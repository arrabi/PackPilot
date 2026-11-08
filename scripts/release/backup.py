"""Compressed production recovery points with readback verification and bounded retention.

The complete manifest is published last. Failed captures never replace a recovery point.
Run under the shared production operation lock in GitHub Actions.
"""
import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile
import urllib.request
from urllib.parse import quote
import uuid
from access import PRODUCTION_PROJECT
from maintenance import connection_target
from retention import retained_ids, parse_time

BUCKET = 'packpilot-production-backups'
SCHEMAS = ('public', 'private', 'auth', 'storage', 'supabase_migrations')


def now():
    return datetime.now(timezone.utc)


def timestamp(value=None):
    return (value or now()).isoformat().replace('+00:00', 'Z')


def sha(path):
    with Path(path).open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def client():
    import boto3
    from urllib.parse import urlsplit
    endpoint = os.environ['R2_ENDPOINT']
    parsed = urlsplit(endpoint)
    account = os.environ['CLOUDFLARE_ACCOUNT_ID']
    if endpoint.rstrip('/') != 'https://' + account + '.r2.cloudflarestorage.com' or parsed.username:
        raise RuntimeError('Expected account-scoped HTTPS R2 endpoint')
    return boto3.client('s3', endpoint_url=endpoint, region_name='auto',
        aws_access_key_id=os.environ['R2_ACCESS_KEY_ID'], aws_secret_access_key=os.environ['R2_SECRET_ACCESS_KEY'])


def put_json(s3, key, value):
    s3.put_object(Bucket=BUCKET, Key=key, Body=json.dumps(value, sort_keys=True).encode(), ContentType='application/json')


def manifests(s3):
    values = []
    for page in s3.get_paginator('list_objects_v2').paginate(Bucket=BUCKET, Prefix='backups/'):
        for item in page.get('Contents', []):
            if re.fullmatch(r'backups/[a-zA-Z0-9-]+/manifest.json', item['Key']):
                value = json.loads(s3.get_object(Bucket=BUCKET, Key=item['Key'])['Body'].read())
                if value.get('prefix') != item['Key'].removesuffix('/manifest.json'):
                    raise RuntimeError('Invalid manifest prefix')
                values.append(value)
    return values


def latest(s3):
    good = [m for m in manifests(s3) if m.get('validated') is True and m.get('status') == 'complete'
            and m.get('project') == PRODUCTION_PROJECT]
    if not good:
        raise RuntimeError('No validated production backup exists')
    return max(good, key=lambda m: parse_time(m['captured_at']))


def freshness(s3):
    value = latest(s3)
    age = now() - parse_time(value['captured_at'])
    if not timedelta(0) <= age <= timedelta(hours=24):
        raise RuntimeError('Latest validated production backup exceeds 24 hours or is future dated')
    # Missing or truncated objects must fail even when a complete manifest exists.
    for item in value['objects']:
        if s3.head_object(Bucket=BUCKET, Key=item['key'])['ContentLength'] != item['bytes']:
            raise RuntimeError('Latest backup object size mismatch')
    return value


def file_bytes(origin, key, bucket, name):
    req = urllib.request.Request(origin + '/storage/v1/object/authenticated/' + quote(bucket, safe='') + '/' + quote(name, safe='/'),
        headers={'apikey': key, 'Authorization': 'Bearer ' + key})
    return urllib.request.urlopen(req, timeout=90)


def pg_environment(target):
    # The CLI must use exactly the same target as psycopg. Preserve proxy/CA
    # settings, but not another connection's ambient libpq configuration.
    env = {key: value for key, value in os.environ.items() if not key.startswith('PG')}
    for key, value in target.items():
        if key in ('host', 'port', 'user', 'password', 'dbname', 'sslmode', 'sslrootcert', 'connect_timeout'):
            env['PG' + ('DATABASE' if key == 'dbname' else 'CONNECT_TIMEOUT' if key == 'connect_timeout' else key.upper())] = str(value)
    # Never put a database URL/password in process arguments or logs.
    return env


def capture(directory):
    import psycopg
    from psycopg import sql
    target = connection_target(os.environ['PRODUCTION_DATABASE_URL'], PRODUCTION_PROJECT)
    print('Production database target validated with certificate and hostname verification', flush=True)
    origin = os.environ['PRODUCTION_SUPABASE_URL'].rstrip('/')
    if origin != 'https://' + PRODUCTION_PROJECT + '.supabase.co':
        raise RuntimeError('Unexpected production storage project')
    started = now()
    with psycopg.connect(**target) as db:
        print('Production database connected; opening read-only snapshot', flush=True)
        db.execute('begin isolation level repeatable read read only')
        version = db.info.server_version // 10000
        tool = subprocess.check_output(['pg_dump', '--version'], text=True)
        if version != 17 or not re.search(r'\b17\.', tool):
            raise RuntimeError('PostgreSQL 17 server and backup client required')
        snapshot = db.execute('select pg_export_snapshot()').fetchone()[0]
        tables = db.execute("select n.nspname,c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname=any(%s) and c.relkind in ('r','p') order by 1,2", (list(SCHEMAS),)).fetchall()
        if set(schema for schema, _ in tables) != set(SCHEMAS):
            raise RuntimeError('Required production schemas missing')
        print('Reading snapshot inventory without logging records', flush=True)
        counts = {schema + '.' + table: db.execute(sql.SQL('select count(*) from {}.{}').format(sql.Identifier(schema), sql.Identifier(table))).fetchone()[0] for schema, table in tables}
        storage = db.execute('select bucket_id,name,metadata,updated_at::text from storage.objects order by bucket_id,name').fetchall()
        migrations = db.execute('select version,name from supabase_migrations.schema_migrations order by version').fetchall()
        policies = db.execute("select schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check from pg_policies where schemaname in ('public','private') order by 1,2,3").fetchall()
        rls = db.execute("select n.nspname,c.relname,c.relrowsecurity,c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private') and c.relkind in ('r','p') order by 1,2").fetchall()
        dump = directory / 'database.dump'
        args = ['pg_dump', '--format=custom', '--compress=0', '--snapshot=' + snapshot, '--file=' + str(dump)]
        for schema in SCHEMAS:
            args += ['--schema=' + schema]
        result = subprocess.run(args, env=pg_environment(target), capture_output=True)
        if result.returncode:
            raise RuntimeError('Production pg_dump failed; credentials and SQL errors withheld')
        print('Production PostgreSQL archive exported', flush=True)
        subprocess.run(['pg_restore', '--list', str(dump)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        index = []
        for number, (bucket, name, metadata, updated) in enumerate(storage):
            path = directory / ('file-' + str(number))
            with file_bytes(origin, os.environ['PRODUCTION_SUPABASE_SERVICE_KEY'], bucket, name) as source, path.open('wb') as output:
                while chunk := source.read(1024 * 1024):
                    output.write(chunk)
            index.append({'bucket': bucket, 'name': name, 'path': path.name,
                          'sha256': sha(path), 'bytes': path.stat().st_size, 'metadata': metadata})
    # A transactional database snapshot cannot freeze the object service. Reject
    # metadata drift and record this limit rather than claiming atomic file capture.
    with psycopg.connect(**target) as db:
        after = db.execute('select bucket_id,name,metadata,updated_at::text from storage.objects order by bucket_id,name').fetchall()
    if after != storage:
        raise RuntimeError('Storage changed during capture; retry with uploads paused')
    (directory / 'files.json').write_text(json.dumps(index))
    inventory = {'captured_at': timestamp(started), 'project': PRODUCTION_PROJECT,
        'postgres_major': version, 'schemas': SCHEMAS, 'table_counts': counts,
        'migrations': migrations, 'rls': rls, 'policies': policies,
        'storage_objects': len(storage), 'file_consistency': 'database snapshot plus stable before/after storage metadata; uploads must pause for strict file consistency'}
    (directory / 'inventory.json').write_text(json.dumps(inventory))
    return inventory


def backup(s3, *, scheduled=False, reason='manual'):
    capture_id = now().strftime('%Y%m%dT%H%M%SZ') + '-' + uuid.uuid4().hex[:12]
    prefix = 'backups/' + capture_id
    with tempfile.TemporaryDirectory(prefix='pack99-backup-') as temp:
        directory = Path(temp)
        inventory = capture(directory)
        archive = directory / 'backup.tar.gz'
        with tarfile.open(archive, 'w:gz', compresslevel=6) as bundle:
            for path in sorted(directory.iterdir()):
                if path != archive:
                    bundle.add(path, arcname=path.name, recursive=False)
        key = prefix + '/backup.tar.gz'
        s3.upload_file(str(archive), BUCKET, key, ExtraArgs={'StorageClass': 'STANDARD'})
        readback = directory / 'readback.tar.gz'
        s3.download_file(BUCKET, key, str(readback))
        if sha(archive) != sha(readback):
            raise RuntimeError('R2 backup checksum readback failed')
        value = {'version': 1, 'id': capture_id, 'prefix': prefix,
            'project': PRODUCTION_PROJECT, 'captured_at': inventory['captured_at'],
            'completed_at': timestamp(), 'status': 'complete', 'validated': True,
            'scheduled': scheduled, 'reason': reason, 'storage_objects': inventory['storage_objects'],
            'objects': [{'key': key, 'bytes': archive.stat().st_size, 'sha256': sha(archive)}],
            'scope': 'public/private/Auth/storage/migration schemas with ownership and grants; uploaded files; inventory',
            'excluded': 'Vault secrets, platform configuration, external integrations and deployed function bundles require separate secure inventory'}
        # Keep operational metadata for one year even after the recovery bytes
        # expire. This copy is never enumerated as a usable recovery point.
        put_json(s3, 'records/backups/' + capture_id + '.json', value)
        put_json(s3, prefix + '/manifest.json', value)
        return value


def cleanup(s3):
    values = manifests(s3)
    keep = retained_ids(values, now())
    # Recovery pins are explicit and released by administrators after recovery.
    pins = set()
    for page in s3.get_paginator('list_objects_v2').paginate(Bucket=BUCKET, Prefix='pins/'):
        for item in page.get('Contents', []):
            value = json.loads(s3.get_object(Bucket=BUCKET, Key=item['Key'])['Body'].read())
            pins.add(value['backup_id'])
    for value in values:
        if value['id'] in keep | pins:
            continue
        prefix = value['prefix'] + '/'
        # Only known completed manifests are eligible; incomplete objects are
        # intentionally retained for administrator diagnosis until separately reviewed.
        if not re.fullmatch(r'backups/[A-Za-z0-9-]+/', prefix):
            raise RuntimeError('Unsafe cleanup prefix')
        keys = []
        for page in s3.get_paginator('list_objects_v2').paginate(Bucket=BUCKET, Prefix=prefix):
            keys += [{'Key': item['Key']} for item in page.get('Contents', [])]
        # Remove marker first so interrupted cleanup cannot advertise a usable backup.
        s3.delete_object(Bucket=BUCKET, Key=prefix + 'manifest.json')
        for start in range(0, len(keys), 1000):
            result = s3.delete_objects(Bucket=BUCKET, Delete={'Objects': keys[start:start + 1000]})
            if result.get('Errors'):
                raise RuntimeError('R2 cleanup partially failed')


def alert(message, *, subject='PackPilot backup/release needs attention'):
    req = urllib.request.Request('https://api.brevo.com/v3/smtp/email',
        headers={'api-key': os.environ['BREVO_API_KEY'], 'Content-Type': 'application/json'},
        data=json.dumps({'sender': {'email': os.environ['PACK99_FROM_EMAIL']},
            'to': [{'email': email} for email in ('admin@example.test', 'recovery@example.test')],
            'subject': subject, 'textContent': message}).encode())
    with urllib.request.urlopen(req, timeout=30) as response:
        if not json.load(response).get('messageId'):
            raise RuntimeError('Operational alert lacked delivery reference')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['backup', 'freshness', 'cleanup'])
    parser.add_argument('--scheduled', action='store_true')
    parser.add_argument('--alert-on-failure', action='store_true')
    args = parser.parse_args()
    try:
        s3 = client()
        value = backup(s3, scheduled=args.scheduled) if args.action == 'backup' else freshness(s3) if args.action == 'freshness' else cleanup(s3)
        print(json.dumps({'action': args.action, 'ok': True, 'backup_id': value['id'] if value else None}))
    except Exception:
        if args.alert_on_failure:
            try:
                alert('The PackPilot ' + args.action + ' operation failed. Review GitHub Actions and the last validated recovery point. No private records or credentials are included in this alert.')
            except Exception:
                print('Operational email alert also failed; inspect the GitHub job failure')
        raise SystemExit('Backup operation failed; no recovery point was replaced by an incomplete capture')
