"""Rehearsals share the release engine but cannot touch production metadata."""
from contextlib import ExitStack
import io
import json
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

import test_release_deploy as fixtures
from test_release_tools import ObjectStore
from rehearsal_store import RehearsalStore
import deploy

OLD, NEW = fixtures.OLD, fixtures.NEW
STAGING = 'bbbbbbbbbbbbbbbbbbbb'


class RehearsalTests(unittest.TestCase):
    def test_public_smoke_checks_mcp_startup_custom_origin_and_project_issuer(self):
        for issuer in ('https://' + STAGING + '.supabase.co/auth/v1', 'https://wrong-project.example/auth/v1'):
            response = io.BytesIO(json.dumps({'authorization_servers': [issuer]}).encode())
            response.status = 200
            response.headers = {'Access-Control-Allow-Origin': 'https://staging.packpilot.example'}
            denied = HTTPError('https://example.test', 401, 'unauthenticated', None, io.BytesIO(b''))
            with patch.object(deploy.urllib.request, 'urlopen', side_effect=[denied, response]) as requests:
                if 'wrong-project' in issuer:
                    with self.assertRaises(RuntimeError):
                        deploy.safe_smoke(STAGING)
                else:
                    deploy.safe_smoke(STAGING)
                self.assertEqual(requests.call_args.args[0].get_header('Origin'), 'https://staging.packpilot.example')

    def test_namespaced_metadata_and_root_retention_pins_cannot_escape(self):
        root = ObjectStore()
        root.objects['releases/current.json'] = b'production-pointer'
        store = RehearsalStore(root, 'e' * 32)
        store.put_object(Bucket=deploy.BUCKET, Key='releases/current.json', Body=b'stage-pointer')
        self.assertEqual(root.objects['releases/current.json'], b'production-pointer')
        self.assertEqual(store.get_object(Bucket=deploy.BUCKET, Key='releases/current.json')['Body'].read(), b'stage-pointer')
        pin = 'pins/release-' + 'a' * 32 + '-attempt-1.json'
        store.put_object(Bucket=deploy.BUCKET, Key=pin, Body=b'pin')
        self.assertTrue(any(k.startswith('pins/rehearsal-') for k in root.objects))
        store.delete_object(Bucket=deploy.BUCKET, Key=pin)
        self.assertFalse(any(k.startswith('pins/') for k in root.objects))
        for key in ('activation/verified.json', '../releases/current.json', '/releases/current.json'):
            with self.assertRaises(RuntimeError):
                store.key(key)
        with self.assertRaises(RuntimeError):
            store.delete_object(Bucket=deploy.BUCKET, Key='releases/current.json')

    def test_actual_engine_fault_and_resume_use_only_staging_and_keep_original_backup(self):
        with ExitStack() as stack:
            root_store = ObjectStore()
            fixture = fixtures.DeploymentTests()
            root, mocks = fixture.setup_controller(stack, root_store)
            original_pointer = root_store.objects['releases/current.json']
            store = RehearsalStore(root_store, 'e' * 32)
            current = {'commit': OLD}
            deploy.put_json(store, 'releases/current.json', current)
            with self.assertRaises(RuntimeError):
                deploy.execute_operation(root, NEW, 'test', store, current, {'migration_digest': 'synthetic'},
                    backend_root=root, backend_commit=NEW, rehearsal=True, fail_after='website')
            key = next(k for k in root_store.objects if k.startswith(store.prefix + 'operations/'))
            record = json.loads(root_store.objects[key])
            self.assertEqual(record['status'], 'partial-failure')
            self.assertEqual(record['components']['failure_isolation'], 'closed')
            deploy.execute_operation(root, NEW, 'test', store, current, {'migration_digest': 'synthetic'},
                backend_root=root, backend_commit=NEW, rehearsal=True,
                resume_operation=record['id'], record=record)
            record = json.loads(root_store.objects[key])
            self.assertEqual(record['status'], 'verified')
            self.assertEqual(record['attempts'], 2)
            self.assertEqual(record['backup'], 'backups/original')
            self.assertEqual(root_store.objects['releases/current.json'], original_pointer)
            self.assertEqual(mocks['backup'].call_args.args[0], root_store)
            self.assertEqual(mocks['pause'].call_args.args, (STAGING, True))
            self.assertTrue(all(c.args[0] == STAGING for c in mocks['maintenance'].call_args_list))
            self.assertTrue(all(c.args[0] == STAGING for c in mocks['deploy_functions'].call_args_list))
            self.assertTrue(all(c.args[1] == 'packpilot-staging' for c in mocks['website'].call_args_list))
            mocks['immutable_tag'].assert_not_called()

    def test_fault_injection_cannot_be_enabled_for_production(self):
        with ExitStack() as stack:
            store = ObjectStore()
            root, mocks = fixtures.DeploymentTests().setup_controller(stack, store)
            before = store.objects.copy()
            with self.assertRaises(RuntimeError):
                deploy.execute_operation(root, NEW, 'test', store, {'commit': OLD}, {}, fail_after='website')
            self.assertEqual(store.objects, before)
            mocks['pause'].assert_not_called()

    def test_production_catalog_drift_stops_before_pausing_or_backup(self):
        with ExitStack() as stack:
            store = ObjectStore()
            root, mocks = fixtures.DeploymentTests().setup_controller(stack, store)
            mocks['schema_digest'].return_value = 'manual-untracked-change'
            with self.assertRaises(RuntimeError):
                deploy.production(root, NEW, '1')
            mocks['pause'].assert_not_called()
            mocks['backup'].assert_not_called()

    def test_historical_backend_override_requires_verified_operation_metadata(self):
        store = ObjectStore()
        key = 'operations/' + 'e' * 32 + '.json'
        current = {'previous_operation_key': key}
        record = {'commit': OLD, 'status': 'verified', 'backend_commit': NEW}
        deploy.put_json(store, key, record)
        self.assertEqual(deploy.rollback_backend_commit(store, current, OLD), NEW)
        record['status'] = 'prepared'
        deploy.put_json(store, key, record)
        with self.assertRaises(RuntimeError):
            deploy.rollback_backend_commit(store, current, OLD)
