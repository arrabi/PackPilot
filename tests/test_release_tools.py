import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts/release'))
import backup
import backend
from maintenance import connection_target


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts/release' / filename)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


restore = module('restore_local', 'restore-local.py')
refresh = module('refresh_staging', 'refresh-staging.py')
rehearsal = module('rehearse_backup', 'rehearse-backup.py')


class ObjectStore:
    def __init__(self, corrupt=False):
        self.objects = {}
        self.corrupt = corrupt

    def upload_file(self, filename, bucket, key, **kwargs):
        self.objects[key] = Path(filename).read_bytes()

    def download_file(self, bucket, key, filename):
        Path(filename).write_bytes(self.objects[key] + (b'corruption' if self.corrupt else b''))

    def put_object(self, *, Bucket, Key, Body, **kwargs):
        self.objects[Key] = Body

    def get_object(self, *, Bucket, Key):
        return {'Body': io.BytesIO(self.objects[Key])}

    def head_object(self, *, Bucket, Key):
        return {'ContentLength': len(self.objects[Key])}

    def get_paginator(self, _):
        return self

    def paginate(self, *, Bucket, Prefix):
        yield {'Contents': [{'Key': key} for key in self.objects if key.startswith(Prefix)]}

    def delete_object(self, *, Bucket, Key):
        self.objects.pop(Key, None)

    def delete_objects(self, *, Bucket, Delete):
        for item in Delete['Objects']:
            self.objects.pop(item['Key'], None)
        return {}


def capture(directory):
    (directory / 'database.dump').write_bytes(b'synthetic database')
    (directory / 'files.json').write_text('[]')
    value = {'captured_at': backup.timestamp(), 'storage_objects': 0}
    (directory / 'inventory.json').write_text(json.dumps(value))
    return value


class ReleaseToolsTests(unittest.TestCase):
    def test_rehearsal_diagnoses_database_errors_without_exposing_exception_details(self):
        import psycopg
        secret = 'credential-must-never-appear'
        cases = [
            (psycopg.OperationalError('password authentication failed ' + secret), 'password authentication failed'),
            (psycopg.OperationalError('Tenant or user not found ' + secret), 'pooler user/project'),
            (psycopg.OperationalError('certificate verify failed ' + secret), 'TLS verification failed'),
            (psycopg.OperationalError('connection timed out ' + secret), 'TCP connection failed'),
            (psycopg.errors.InsufficientPrivilege(secret), 'SQLSTATE 42501'),
            (psycopg.ProgrammingError('invalid URI ' + secret), 'connection string or operation is invalid'),
            (RuntimeError(secret), 'private exception details withheld'),
        ]
        for error, expected in cases:
            with self.subTest(expected=expected):
                result = rehearsal.failure_reason(error)
                self.assertIn(expected, result)
                self.assertNotIn(secret, result)
        error = RuntimeError('Database TLS certificate and hostname verification is required')
        self.assertEqual(rehearsal.failure_reason(error), str(error))

    def test_rehearsal_requires_owner_approval_of_the_checked_out_snapshot(self):
        sha = 'a' * 40
        context = {'GITHUB_ACTIONS': 'true', 'GITHUB_ACTOR': 'YOUR_GITHUB_OWNER',
            'GITHUB_REPOSITORY': 'YOUR_GITHUB_OWNER/YOUR_GITHUB_REPOSITORY', 'GITHUB_EVENT_NAME': 'workflow_dispatch',
            'GITHUB_REF': 'refs/heads/main', 'GITHUB_SHA': sha}
        with patch.dict(os.environ, context, clear=True), patch.object(rehearsal.subprocess, 'check_output', return_value=sha):
            rehearsal.authorized_source()
            for name, value in [('GITHUB_ACTOR', 'other'), ('GITHUB_REF', 'refs/heads/feature'),
                    ('GITHUB_SHA', 'b' * 40), ('GITHUB_EVENT_NAME', 'schedule')]:
                with patch.dict(os.environ, {name: value}), self.assertRaises(RuntimeError):
                    rehearsal.authorized_source()

    def test_pr_rehearsal_approval_cannot_be_reused_on_push_or_a_new_commit(self):
        sha = 'a' * 40
        event = {'action': 'labeled', 'label': {'name': 'rehearse-backup'}, 'sender': {'login': 'YOUR_GITHUB_OWNER'},
            'pull_request': {'head': {'sha': sha, 'repo': {'full_name': 'YOUR_GITHUB_OWNER/YOUR_GITHUB_REPOSITORY'}}, 'base': {'ref': 'main'}}}
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'event.json'
            context = {'GITHUB_ACTIONS': 'true', 'GITHUB_ACTOR': 'YOUR_GITHUB_OWNER',
                'GITHUB_REPOSITORY': 'YOUR_GITHUB_OWNER/YOUR_GITHUB_REPOSITORY', 'GITHUB_EVENT_NAME': 'pull_request',
                'GITHUB_EVENT_PATH': str(path)}
            with patch.dict(os.environ, context, clear=True), patch.object(rehearsal.subprocess, 'check_output', return_value=sha) as checkout:
                path.write_text(json.dumps(event))
                rehearsal.authorized_source()
                for invalid in (event | {'action': 'synchronize'}, event | {'sender': {'login': 'other'}},
                        event | {'label': {'name': 'unrelated'}}, event | {'pull_request': {'head': {'sha': sha, 'repo': {'full_name': 'fork/repo'}}, 'base': {'ref': 'main'}}}):
                    path.write_text(json.dumps(invalid))
                    with self.assertRaises(RuntimeError):
                        rehearsal.authorized_source()
                path.write_text(json.dumps(event))
                checkout.return_value = 'b' * 40
                with self.assertRaises(RuntimeError):
                    rehearsal.authorized_source()

    def test_backup_publishes_complete_manifest_only_after_readback(self):
        store = ObjectStore()
        with patch.object(backup, 'capture', capture):
            value = backup.backup(store, reason='pre-release')
        self.assertTrue(value['validated'])
        self.assertEqual(backup.freshness(store)['id'], value['id'])
        store.objects[value['objects'][0]['key']] += b'truncated'
        with self.assertRaises(RuntimeError):
            backup.freshness(store)
        store = ObjectStore(corrupt=True)
        with patch.object(backup, 'capture', capture), self.assertRaises(RuntimeError):
            backup.backup(store)
        self.assertFalse(any(key.endswith('manifest.json') for key in store.objects))

    def test_cleanup_preserves_recovery_pins_and_last_good(self):
        store = ObjectStore()
        for id, date in [('old', '2020-01-01T00:00:00Z'), ('newest', '2020-01-03T00:00:00Z'), ('expired', '2020-01-02T00:00:00Z')]:
            value = {'id': id, 'prefix': 'backups/' + id, 'captured_at': date,
                     'project': backup.PRODUCTION_PROJECT, 'status': 'complete', 'validated': True}
            backup.put_json(store, value['prefix'] + '/manifest.json', value)
            store.objects[value['prefix'] + '/backup.tar.gz'] = b'synthetic'
        backup.put_json(store, 'pins/recovery.json', {'backup_id': 'old'})
        backup.cleanup(store)
        self.assertIn('backups/old/backup.tar.gz', store.objects)
        self.assertIn('backups/newest/backup.tar.gz', store.objects)
        self.assertNotIn('backups/expired/manifest.json', store.objects)

    def test_restore_rejects_remote_and_connection_override_targets(self):
        for value in ['postgres://postgres@production.example/postgres',
                      'host=localhost hostaddr=192.0.2.1 dbname=postgres',
                      'host=localhost service=production dbname=postgres']:
            with self.assertRaises(RuntimeError):
                restore.local_target(value)
        for value in ['postgres://postgres@db.aaaaaaaaaaaaaaaaaaaa.supabase.co/postgres?sslmode=disable',
                      'postgres://postgres@db.aaaaaaaaaaaaaaaaaaaa.supabase.co:6543/postgres',
                      'postgres://postgres@db.aaaaaaaaaaaaaaaaaaaa.supabase.co/postgres?sslmode=verify-ca',
                      'host=db.aaaaaaaaaaaaaaaaaaaa.supabase.co hostaddr=192.0.2.1 dbname=postgres',
                      'host=other.invalid,aws-0-us-east-1.pooler.supabase.com user=postgres.aaaaaaaaaaaaaaaaaaaa port=5432',
                      'host=aws-0-us-east-1.pooler.supabase.com user=postgres.aaaaaaaaaaaaaaaaaaaa port=6543']:
            with self.assertRaises(RuntimeError):
                connection_target(value, backup.PRODUCTION_PROJECT)

    def test_connections_reject_inherited_routing_and_session_overrides(self):
        production = 'postgres://postgres@db.' + backup.PRODUCTION_PROJECT + '.supabase.co/postgres'
        for name in ('PGHOSTADDR', 'PGSERVICE', 'PGSERVICEFILE', 'PGOPTIONS'):
            with self.subTest(name=name), patch.dict(os.environ, {name: 'unreviewed'}):
                with self.assertRaises(RuntimeError):
                    connection_target(production, backup.PRODUCTION_PROJECT)
                with self.assertRaises(RuntimeError):
                    restore.local_target('host=localhost dbname=postgres')

    def test_cli_and_python_use_the_same_database_and_trusted_ca(self):
        production = 'postgres://postgres@db.' + backup.PRODUCTION_PROJECT + '.supabase.co'
        with patch.dict(os.environ, {'PGDATABASE': 'other', 'PGSSLROOTCERT': '/trusted/roots.pem',
                'PGPASSWORD': 'ambient', 'HTTPS_PROXY': 'http://proxy:8080'}, clear=True):
            target = connection_target(production, backup.PRODUCTION_PROJECT)
            self.assertEqual(target['dbname'], 'postgres')
            self.assertEqual(target['sslrootcert'], '/trusted/roots.pem')
            env = backup.pg_environment(target)
            self.assertEqual(env['PGDATABASE'], 'postgres')
            self.assertEqual(env['PGSSLMODE'], 'verify-full')
            self.assertEqual(env['PGSSLROOTCERT'], '/trusted/roots.pem')
            self.assertEqual(env['HTTPS_PROXY'], os.environ['HTTPS_PROXY'])
            self.assertNotIn('PGPASSWORD', env)
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(connection_target(production, backup.PRODUCTION_PROJECT)['sslrootcert'], 'system')
        with self.assertRaises(RuntimeError):
            connection_target(production + '/other', backup.PRODUCTION_PROJECT)

    def test_provider_ca_applies_to_system_root_uris_and_preserves_custom_roots(self):
        production = 'postgres://postgres@db.' + backup.PRODUCTION_PROJECT + '.supabase.co/postgres'
        with patch.dict(os.environ, {'PGSSLROOTCERT': '/trusted/supabase-ca.crt'}, clear=True):
            target = connection_target(production + '?sslrootcert=system', backup.PRODUCTION_PROJECT)
            self.assertEqual(target['sslmode'], 'verify-full')
            self.assertEqual(target['sslrootcert'], '/trusted/supabase-ca.crt')
            self.assertEqual(backup.pg_environment(target)['PGSSLROOTCERT'], target['sslrootcert'])
            target = connection_target(production + '?sslrootcert=/trusted/custom.crt', backup.PRODUCTION_PROJECT)
            self.assertEqual(target['sslrootcert'], '/trusted/custom.crt')

    def test_restore_rejects_archive_traversal_duplicates_and_expansion(self):
        for names, limit in [(['../secret'], 1024), (['database.dump', 'database.dump'], 1024), (['database.dump'], 1)]:
            with tempfile.TemporaryDirectory() as temp:
                directory = Path(temp)
                archive = directory / 'archive.tar.gz'
                with tarfile.open(archive, 'w:gz') as bundle:
                    for name in names:
                        member = tarfile.TarInfo(name)
                        member.size = 5
                        bundle.addfile(member, io.BytesIO(b'value'))
                with self.assertRaises(RuntimeError):
                    restore.extract(archive, directory, max_bytes=limit)

    def test_migration_hash_ignores_comments_but_preserves_data_literals(self):
        self.assertEqual(backend.sql_digest('-- comment\nselect 1;'), backend.sql_digest('select   1; -- other'))
        self.assertNotEqual(backend.sql_digest("select 'a b'"), backend.sql_digest("select 'a  b'"))
        self.assertNotEqual(backend.sql_digest("select 1"), backend.sql_digest("select 2"))

    def test_migration_drift_and_out_of_order_changes_block_before_mutation(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            directory = root / 'supabase/migrations'
            directory.mkdir(parents=True)
            (directory / '20260101000000_first.sql').write_text('select 1;')
            live = [{'version': '20260101000000', 'name': 'first', 'statements': ['select 2;']}]
            with patch.object(backend, 'history', return_value=live), self.assertRaisesRegex(RuntimeError, 'immutable'):
                backend.plan('synthetic', root)
            live[0]['statements'] = ['select 1;']
            (directory / '20250101000000_older.sql').write_text('select 3;')
            with patch.object(backend, 'history', return_value=live), self.assertRaisesRegex(RuntimeError, 'Out-of-order'):
                backend.plan('synthetic', root)

    def test_refresh_remaps_actor_ids_without_rewriting_parent_addresses(self):
        source = str(uuid.uuid4())
        target = uuid.uuid4()
        record = {'created_by': uuid.UUID(source), 'parent_email': 'real-parent@example.invalid',
                  'command': {'actor': source, 'subject': 'production copy'}}
        result = refresh.remap(record, {source: target})
        self.assertEqual(result['created_by'], target)
        self.assertEqual(result['command']['actor'], str(target))
        self.assertEqual(result['parent_email'], record['parent_email'])

    def test_refresh_receipt_expires_and_cannot_cover_changed_functions(self):
        checks = dict.fromkeys(['auth_allowed', 'auth_blocked', 'notification_allowed', 'notification_blocked', 'retry_blocked'], True)
        receipt = {'project': 'synthetic', 'verified_at': backup.timestamp(), 'checks': checks, 'functions': [], 'secrets': []}
        self.assertTrue(refresh.receipt_valid(receipt, 'synthetic', [], []))
        self.assertFalse(refresh.receipt_valid(receipt, 'synthetic', [{'version': 2}], []))
        receipt['verified_at'] = '2000-01-01T00:00:00Z'
        self.assertFalse(refresh.receipt_valid(receipt, 'synthetic', [], []))


if __name__ == '__main__':
    unittest.main()
