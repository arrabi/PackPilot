"""Synthetic real PostgreSQL/Auth/REST rehearsal; no credentials or backup needed.

The lightweight database lacks provider cron/net binaries, so only their two
CREATE EXTENSION statements are omitted and empty net queue tables are supplied.
Application migrations and all Auth/REST requests execute normally. This is not
accepted as evidence that an actual production archive restores successfully.
"""
import importlib.util
import json
from pathlib import Path
import secrets
import sys
from unittest.mock import patch
import uuid

import psycopg

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts/release'))
import recovery_behavior as behavior
from maintenance import open_local_recovery_barrier

POSTGRES_IMAGE = 'postgres:17@sha256:748a18a54d3842d43bc156f0840d78029b8d349e0feca98c12b9c4ce3404a6b3'


class SyntheticEvidence:
    def __init__(self):
        self.records = {}

    def put_object(self, *, Key, Body, **kwargs):
        self.records[Key] = json.loads(Body)


def main():
    spec = importlib.util.spec_from_file_location('rehearsal', ROOT / 'scripts/release/rehearse-backup.py')
    rehearsal = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(rehearsal)
    original = rehearsal.command

    def postgres(args, env):
        args = list(args)
        # The stock image's data/config directory differs from Supabase's.
        if '-D' in args:
            index = args.index('-D')
            assert args[index + 1] == '/etc/postgresql'
            del args[index:index + 2]
        return original(args, env)

    with patch.object(rehearsal, 'IMAGE', POSTGRES_IMAGE), patch.object(rehearsal, 'command', side_effect=postgres):
        with rehearsal.isolated_database() as local:
            target = behavior.local_target(local.connection, local.instance)
            with psycopg.connect(**target) as db:
                db.execute('''create role postgres;create role anon;create role authenticated;create role service_role bypassrls;
                  create role authenticator login noinherit;grant anon,authenticated,service_role to authenticator;
                  create role supabase_auth_admin login;create schema auth authorization supabase_auth_admin;
                  create schema net;create table net.http_request_queue(id bigint);create table net._http_response(id bigint);
                  create schema extensions;create extension pgcrypto with schema extensions;
                  create extension "uuid-ossp" with schema extensions;
                  grant usage on schema extensions to supabase_auth_admin;
                  grant usage on schema public to anon,authenticated,service_role;
                  grant all on schema auth to supabase_auth_admin;''')
            key = secrets.token_hex(48)
            import os
            env = {k: v for k, v in os.environ.items() if k not in
                ('DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH')}
            # GoTrue builds its authentic versioned Auth schema before fixtures.
            with behavior.services(target, local.sockets, env, key, local.instance):
                import time
                admin = behavior.signed_token(key, {'role': 'service_role', 'aud': 'authenticated', 'exp': int(time.time()) + 600})
                status, owner = behavior.http(behavior.AUTH_NAME, 9999, 'POST', '/admin/users',
                    data={'email': 'owner@recovery.invalid', 'password': secrets.token_urlsafe(36), 'email_confirm': True}, token=admin, env=env)
                behavior.require(status == 200, 'synthetic owner creation')
            with psycopg.connect(**target) as db:
                db.execute('''grant usage on schema auth to anon,authenticated,service_role;
                  grant execute on function auth.uid() to anon,authenticated,service_role;''')
                for path in sorted((ROOT / 'supabase/migrations').glob('*.sql')):
                    body = path.read_text().replace('create extension if not exists pg_cron with schema pg_catalog;', '').replace('create extension if not exists pg_net with schema extensions;', '')
                    db.execute(body, prepare=False)
                db.execute("insert into public.leader_access(email,role,can_record) values('owner@recovery.invalid','admin',true)")
                db.execute("insert into auth.identities(id,user_id,provider_id,provider,identity_data,created_at,updated_at) values(%s,%s,%s,'google',%s::jsonb,now(),now())",
                    (uuid.uuid4(), owner['id'], owner['id'], json.dumps({'sub': owner['id'], 'email': 'owner@recovery.invalid', 'email_verified': True})))
                snapshot = db.execute("insert into public.roster_snapshots(source_sha256,source_file,source_sheet,snapshot_date,expected_rows) values(%s,'synthetic.xlsx','Roster 2026-27','2026-10-21',2) returning id", ('f' * 64,)).fetchone()[0]
                for number in (2, 3):
                    db.execute("insert into public.scouts(snapshot_id,snapshot_date,source_row,scout_name,den,source_values) values(%s,'2026-10-21',%s,'Synthetic recovery scout','1-Tigers','{}')", (snapshot, number))
            with psycopg.connect(**target) as db:
                db.execute('select private.set_release_maintenance(true)')
                assert db.execute('select enabled from private.pack_release_maintenance where singleton').fetchone()[0] is True
                try:
                    with db.transaction():
                        db.execute('update public.scouts set source_row=source_row')
                except psycopg.Error as error:
                    assert error.sqlstate == '55000'
                else:
                    raise RuntimeError('Closed bootstrap barrier did not block an application write')
                # Only the isolated clone may reopen it before RLS/Auth tests.
                open_local_recovery_barrier(db)
                assert db.execute('select enabled from private.pack_release_maintenance where singleton').fetchone()[0] is False
            evidence = SyntheticEvidence()
            result = behavior.verify(local.connection, local.sockets, local.instance, evidence, 'synthetic-local-only')
            assert result['status'] == 'behavior-verified' and all(result['checks'].values())
            assert evidence.records['rehearsals/synthetic-local-only-behavior.json'] == result
    print('Synthetic integration passed with real GoTrue/PostgREST and repository SQL; no production backup was used')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # No raw service bodies, SQL exceptions, DSNs, JWTs or passwords in CI.
        from recovery_behavior import RecoveryBehaviorFailure
        print(str(error) if isinstance(error, RecoveryBehaviorFailure) else 'Synthetic recovery integration failed; private exception details withheld', flush=True)
        raise SystemExit(1)
