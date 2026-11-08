"""Restore and verify a recovery point in an isolated local Supabase stack only.

Stop local Auth, Edge Functions and mail services BEFORE running this command.
No remote database or remote Storage target is accepted. The recovery pin remains
until an administrator removes it after reviewing rehearsal evidence.
"""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile
from urllib.parse import urlsplit, quote
import urllib.request
from backup import BUCKET, SCHEMAS, client, pg_environment, put_json, sha, timestamp
from maintenance import reject_environment_overrides, open_local_recovery_barrier


def local_target(value):
    from psycopg.conninfo import conninfo_to_dict
    reject_environment_overrides()
    target = conninfo_to_dict(value)
    if target.get('host') not in ('localhost', '127.0.0.1', '::1') or any(k in target for k in ('hostaddr', 'service', 'servicefile', 'options')):
        raise RuntimeError('Restore only supports an explicit localhost database')
    target.setdefault('dbname', 'postgres')
    target.setdefault('port', '5432')
    target.setdefault('connect_timeout', '15')
    return target


def extract(archive, directory, *, max_bytes):
    seen = set()
    total = 0
    with tarfile.open(archive, 'r:gz') as bundle:
        for member in bundle:
            if not member.isfile() or not re.fullmatch(r'database\.dump|files\.json|inventory\.json|file-\d+', member.name) or member.name in seen:
                raise RuntimeError('Unsafe or duplicate backup archive member')
            seen.add(member.name)
            total += member.size
            if total > max_bytes:
                raise RuntimeError('Backup exceeds the configured restore size bound')
            with bundle.extractfile(member) as source, (directory / member.name).open('xb') as output:
                while chunk := source.read(1024 * 1024):
                    output.write(chunk)
    if not {'database.dump', 'files.json', 'inventory.json'} <= seen:
        raise RuntimeError('Incomplete backup archive')


def restore(prefix, max_bytes):
    import psycopg
    from psycopg import sql
    if not re.fullmatch(r'backups/[A-Za-z0-9-]+', prefix):
        raise RuntimeError('Invalid backup prefix')
    if os.environ.get('LOCAL_RECOVERY_SERVICES_STOPPED') != 'true':
        raise RuntimeError('Stop local Auth/Edge/mail services and set LOCAL_RECOVERY_SERVICES_STOPPED=true')
    target = local_target(os.environ['LOCAL_DATABASE_URL'])
    # Reject a mistaken local TCP forwarding endpoint into a remote production DB.
    # Supabase local rehearsal must carry its explicit marker installed by its admin.
    with psycopg.connect(**target) as db:
        marker = db.execute("select current_setting('pack99.local_recovery_target', true)").fetchone()[0]
        if marker != 'isolated':
            raise RuntimeError('Missing isolated database marker; see recovery instructions')
        if db.info.server_version // 10000 != 17:
            raise RuntimeError('Compatible PostgreSQL 17 Supabase stack required')
    s3 = client()
    manifest = json.loads(s3.get_object(Bucket=BUCKET, Key=prefix + '/manifest.json')['Body'].read())
    if manifest.get('version') != 1 or manifest.get('prefix') != prefix or manifest.get('status') != 'complete' or manifest.get('validated') is not True or manifest.get('project') != 'aaaaaaaaaaaaaaaaaaaa':
        raise RuntimeError('Invalid recovery manifest')
    if len(manifest['objects']) != 1 or manifest['objects'][0]['key'] != prefix + '/backup.tar.gz':
        raise RuntimeError('Unsupported recovery object layout')
    started = datetime.now(timezone.utc)
    pin = 'pins/restore-' + manifest['id'] + '.json'
    put_json(s3, pin, {'backup_id': manifest['id'], 'started_at': timestamp(started), 'purpose': 'isolated recovery rehearsal'})
    evidence = {'backup_id': manifest['id'], 'started_at': timestamp(started), 'status': 'failed'}
    try:
        with tempfile.TemporaryDirectory(prefix='pack99-recovery-') as temp:
            directory = Path(temp)
            archive = directory / 'backup.tar.gz'
            item = manifest['objects'][0]
            s3.download_file(BUCKET, item['key'], str(archive))
            if archive.stat().st_size != item['bytes'] or sha(archive) != item['sha256']:
                raise RuntimeError('Recovery archive checksum or length mismatch')
            extract(archive, directory, max_bytes=max_bytes)
            inventory = json.loads((directory / 'inventory.json').read_text())
            files = json.loads((directory / 'files.json').read_text())
            if inventory['project'] != manifest['project'] or set(inventory['schemas']) != set(SCHEMAS) or len(files) != manifest['storage_objects']:
                raise RuntimeError('Recovery inventory mismatch')
            for entry in files:
                if not re.fullmatch(r'file-\d+', entry['path']) or sha(directory / entry['path']) != entry['sha256']:
                    raise RuntimeError('Recovered file checksum mismatch')
            local_origin = os.environ.get('LOCAL_SUPABASE_URL', '').rstrip('/')
            if files:
                parsed = urlsplit(local_origin)
                if parsed.hostname not in ('localhost', '127.0.0.1', '::1') or parsed.scheme not in ('http', 'https') or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment:
                    raise RuntimeError('File restore only supports a local Supabase origin')
            result = subprocess.run(['pg_restore', '--clean', '--if-exists', '--single-transaction', '--exit-on-error',
                '--dbname=' + target.get('dbname', 'postgres'), str(directory / 'database.dump')], env=pg_environment(target), capture_output=True)
            if result.returncode:
                raise RuntimeError('Local pg_restore failed; review role/schema compatibility securely')
            with psycopg.connect(**target) as db:
                for name, expected in inventory['table_counts'].items():
                    schema, table = name.split('.', 1)
                    if schema not in SCHEMAS:
                        raise RuntimeError('Unexpected inventory schema')
                    actual = db.execute(sql.SQL('select count(*) from {}.{}').format(sql.Identifier(schema), sql.Identifier(table))).fetchone()[0]
                    if actual != expected:
                        raise RuntimeError('Restored table count mismatch')
                invalid = db.execute("select count(*) from pg_constraint c join pg_namespace n on n.oid=c.connamespace where n.nspname=any(%s) and not c.convalidated", (list(SCHEMAS),)).fetchone()[0]
                if invalid:
                    raise RuntimeError('Restored database contains unvalidated constraints')
                policies = db.execute("select schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check from pg_policies where schemaname in ('public','private') order by 1,2,3").fetchall()
                rls = db.execute("select n.nspname,c.relname,c.relrowsecurity,c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private') and c.relkind in ('r','p') order by 1,2").fetchall()
                if json.loads(json.dumps(policies)) != inventory['policies'] or json.loads(json.dumps(rls)) != inventory['rls']:
                    raise RuntimeError('Restored RLS configuration differs from backup')
                # Record restored RLS/grant configuration without private records.
                evidence['rls_tables'] = db.execute("select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private') and c.relrowsecurity").fetchone()[0]
                evidence['policy_count'] = db.execute("select count(*) from pg_policies where schemaname in ('public','private')").fetchone()[0]
                # Rehearsal must never retain live delivery URLs or active sessions.
                db.execute("set local session_replication_role='replica'")
                for table in ('pack_email_outbox', 'pack_notification_invocations', 'parent_email_throttle'):
                    if db.execute('select to_regclass(%s)', ('private.' + table,)).fetchone()[0]:
                        db.execute(sql.SQL('truncate private.{} cascade').format(sql.Identifier(table)))
                if db.execute("select to_regclass('private.pack_notification_settings')").fetchone()[0]:
                    db.execute("update private.pack_notification_settings set endpoint='http://127.0.0.1:1/disabled'")
                for table in ('sessions', 'refresh_tokens', 'one_time_tokens', 'flow_state'):
                    if db.execute('select to_regclass(%s)', ('auth.' + table,)).fetchone()[0]:
                        db.execute(sql.SQL('truncate auth.{} cascade').format(sql.Identifier(table)))
                # Pre-release captures intentionally contain an enabled barrier.
                # Open it only here, after local delivery/session isolation and
                # integrity checks, before exercising the cloned application's RLS.
                open_local_recovery_barrier(db)
            # Local Storage may run while Auth/Edge/mail stay stopped. A service
            # key is supplied only to this localhost endpoint, never the source.
            for entry in files:
                endpoint = local_origin + '/storage/v1/object/' + quote(entry['bucket'], safe='') + '/' + quote(entry['name'], safe='/')
                key = os.environ['LOCAL_SUPABASE_SERVICE_KEY']
                headers = {'apikey': key, 'Authorization': 'Bearer ' + key}
                request = urllib.request.Request(endpoint, method='POST', data=(directory / entry['path']).read_bytes(),
                    headers={**headers, 'x-upsert': 'true', 'Content-Type': (entry.get('metadata') or {}).get('mimetype', 'application/octet-stream')})
                with urllib.request.urlopen(request, timeout=90):
                    pass
                request = urllib.request.Request(endpoint, headers=headers)
                verified = directory / 'file-readback'
                with urllib.request.urlopen(request, timeout=90) as source, verified.open('wb') as output:
                    while chunk := source.read(1024 * 1024):
                        output.write(chunk)
                if sha(verified) != entry['sha256']:
                    raise RuntimeError('Restored uploaded file readback failed')
            evidence.update(status='database-verified', table_count=len(inventory['table_counts']),
                storage_objects=len(files), auth_sessions_cleared=True,
                follow_up='Rehearse RLS with user JWTs, Auth and file download behavior before accepting recovery readiness')
    finally:
        evidence['finished_at'] = timestamp()
        evidence['duration_seconds'] = (datetime.now(timezone.utc) - started).total_seconds()
        put_json(s3, 'rehearsals/' + manifest['id'] + '.json', evidence)
    print(json.dumps(evidence))
    return evidence


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('prefix')
    parser.add_argument('--replace-local-data', action='store_true', required=True)
    parser.add_argument('--max-expanded-bytes', type=int, default=10 * 1024**3)
    args = parser.parse_args()
    try:
        restore(args.prefix, args.max_expanded_bytes)
    except Exception:
        raise SystemExit('Local recovery rehearsal incomplete; recovery pin retained; no remote restore was attempted')
