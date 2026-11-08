"""Exercise Auth/JWT/RLS against an isolated, restored database only.

Services share only the database's private Unix socket. Every container has no
network, and HTTP clients enter only that isolated service's network namespace.
Production runtime keys and external mail/OAuth configuration are never passed
to service environments. Restored Auth records remain inside the isolated
database. Responses/records/tokens are never logged.
"""
from contextlib import contextmanager
import base64
import hashlib
import hmac
from http.client import HTTPException, HTTPResponse
import io
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import time
import uuid

import psycopg
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict, make_conninfo

from backup import BUCKET, put_json, timestamp
from maintenance import reject_environment_overrides

AUTH_IMAGE = 'supabase/gotrue:v2.197.0@sha256:839f529492d116b4e8b7777c953a27c381d34c15a744b1bcefde5eefaa1f9f9f'
REST_IMAGE = 'postgrest/postgrest:v14.5@sha256:bb289d00570b569525e1e22fb77c49cd17c17ca3f41da9ee2b4351a35027551b'
AUTH_NAME, REST_NAME = 'pack99-recovery-auth', 'pack99-recovery-rest'
PRIVATE_BINDINGS = {'PRODUCTION_DATABASE_URL', 'PRODUCTION_SUPABASE_SERVICE_KEY', 'BREVO_API_KEY',
    'SUPABASE_ACCESS_KEY', 'SUPABASE_ACCESS_TOKEN', 'CLOUDFLARE_API_TOKEN', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'}


class RecoveryBehaviorFailure(RuntimeError):
    """Only fixed check names and numeric HTTP statuses belong in this error."""


def require(condition, check):
    if not condition:
        raise RecoveryBehaviorFailure('Isolated recovery check failed: ' + check)


def docker(args, *, env=None, payload=None, check=True, timeout=120):
    result = subprocess.run(['docker', '--host=unix:///var/run/docker.sock', *args],
        env=env, input=payload, capture_output=True, timeout=timeout)
    if check and result.returncode:
        raise RecoveryBehaviorFailure('Isolated recovery container operation failed')
    return result


def require_networkless(name, env):
    require(name in (AUTH_NAME, REST_NAME, 'pack99-backup-rehearsal'), 'known local container')
    result = docker(['inspect', '--format', '{{.HostConfig.NetworkMode}}', name], env=env)
    require(result.stdout.strip() == b'none', 'container network disabled')


def startup_failure(name, env):
    # Inspect service logs only in memory. Emit fixed categories and SQLSTATEs,
    # never raw log messages, DSNs, SQL, user data or local signing/password keys.
    result = docker(['logs', '--tail', '40', name], env=env, check=False)
    private = (result.stdout + result.stderr).decode(errors='replace')
    lowered = private.lower()
    tags = [label for phrase, label in (
        ('permission denied', 'database permission'), ('must be owner', 'database ownership'),
        ('peer authentication failed', 'Unix socket authentication'),
        ('password authentication failed', 'local database password'),
        ('not permitted to log in', 'local role login disabled'),
        ('migration', 'Auth schema migration'), ('jwt', 'JWT configuration'),
        ('connection refused', 'local database connection'),
        ('invalid character', 'local configuration encoding'),
    ) if phrase in lowered]
    states = sorted(set(re.findall(r'SQLSTATE ([A-Z0-9]{5})', private)))
    suffix = ', '.join(tags + ['SQLSTATE ' + value for value in states]) or 'private log details withheld'
    return 'Isolated service startup failed: ' + name + ' (' + suffix + ')'


def parse_http(raw):
    class Socket:
        def makefile(self, *args, **kwargs):
            return io.BytesIO(raw) if isinstance(raw, bytes) else raw
    response = HTTPResponse(Socket())
    response.begin()
    body = response.read(2 * 1024**2 + 1)
    require(len(body) <= 2 * 1024**2, 'bounded local HTTP response')
    return response.status, json.loads(body) if body else None


def http(name, port, method, path, *, data=None, token=None, env=None):
    require((name, port) in ((AUTH_NAME, 9999), (REST_NAME, 3000)), 'local service target')
    require(method in ('GET', 'POST', 'PUT', 'PATCH', 'DELETE'), 'local HTTP method')
    require(path.startswith('/') and not path.startswith('//') and '\r' not in path and '\n' not in path, 'local HTTP path')
    require_networkless(name, env)
    body = b'' if data is None else json.dumps(data).encode()
    headers = ['Host: localhost', 'Connection: close', 'Content-Type: application/json', 'Content-Length: ' + str(len(body))]
    if token:
        require(re.fullmatch(r'[A-Za-z0-9_.-]+', token) is not None, 'JWT header encoding')
        headers.append('Authorization: Bearer ' + token)
    request = (method + ' ' + path + ' HTTP/1.1\r\n' + '\r\n'.join(headers) + '\r\n\r\n').encode() + body
    # The client shares ONLY the verified networkless target's namespace. Its
    # stdin/stdout carry private HTTP material, never process arguments or logs.
    args = ['docker', '--host=unix:///var/run/docker.sock', 'run', '--rm', '-i',
        '--network=container:' + name, '--entrypoint', '/bin/busybox', AUTH_IMAGE,
        'nc', '-w', '10', '127.0.0.1', str(port)]
    process = subprocess.Popen(args, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    try:
        # Keep stdin open until the response is complete. nc half-closes on EOF,
        # which cancels GoTrue's request context before its transaction finishes.
        process.stdin.write(request)
        process.stdin.flush()
        result = parse_http(process.stdout)
        process.stdin.close()
        require(process.wait(timeout=15) == 0, 'local HTTP transport')
        return result
    except (OSError, ValueError, HTTPException, subprocess.TimeoutExpired):
        raise RecoveryBehaviorFailure('Isolated local HTTP transport failed') from None
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        process.stdout.close()
        if not process.stdin.closed:
            process.stdin.close()


def encode(value):
    return base64.urlsafe_b64encode(value).decode().rstrip('=')


def signed_token(key, claims):
    value = encode(b'{"alg":"HS256","typ":"JWT"}') + '.' + encode(json.dumps(claims).encode())
    return value + '.' + encode(hmac.new(key.encode(), value.encode(), hashlib.sha256).digest())


def verify_user_token(token, key, expected_user):
    parts = token.split('.')
    require(len(parts) == 3, 'Auth JWT shape')
    require(hmac.compare_digest(parts[2], encode(hmac.new(key.encode(), '.'.join(parts[:2]).encode(), hashlib.sha256).digest())), 'Auth JWT signature')
    claims = json.loads(base64.urlsafe_b64decode(parts[1] + '=' * (-len(parts[1]) % 4)))
    require(claims.get('sub') == str(expected_user) and claims.get('role') == 'authenticated'
        and claims.get('aud') in ('authenticated', ['authenticated']) and claims.get('exp', 0) > time.time(), 'Auth JWT user/role/expiry')
    return claims


def local_target(connection, instance):
    reject_environment_overrides()
    target = conninfo_to_dict(connection)
    require(target.get('host') == '127.0.0.1' and str(target.get('port')) == '55432'
        and not any(k in target for k in ('hostaddr', 'service', 'servicefile', 'options')), 'explicit local behavior database')
    with psycopg.connect(**target) as db:
        require(db.execute("select current_setting('pack99.local_recovery_target', true),current_setting('pack99.rehearsal_id', true)").fetchone()
            == ('isolated', instance), 'exact isolated database identity')
    return target


def auth_schema(db):
    versions = db.execute('select version from auth.schema_migrations order by version').fetchall()
    columns = db.execute("select table_name,column_name,data_type,is_nullable from information_schema.columns where table_schema='auth' order by 1,2").fetchall()
    definitions = db.execute("""select kind,name,definition from (
      select 'function'::text kind,p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' name,pg_get_functiondef(p.oid) definition
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='auth' and p.prokind in ('f','p')
      union all select 'constraint',c.relname||'.'||k.conname,pg_get_constraintdef(k.oid)
      from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='auth'
      union all select 'trigger',c.relname||'.'||t.tgname,pg_get_triggerdef(t.oid)
      from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='auth' and not t.tgisinternal
      union all select 'table',c.relname,jsonb_build_array(c.relrowsecurity,c.relforcerowsecurity)::text
      from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='auth' and c.relkind in ('r','p')
      union all select 'index',indexname,indexdef from pg_indexes where schemaname='auth'
    ) entries order by kind,name""").fetchall()
    return hashlib.sha256(json.dumps([versions, columns, definitions]).encode()).hexdigest()


def socket_authentication(target, password, env):
    # Supabase's image uses peer auth for several local roles. Independent Auth
    # and REST containers have different OS users, so give ONLY these local test
    # roles SCRAM auth. The instance/network guards run before this function.
    with psycopg.connect(**target) as db:
        hba = db.execute('show hba_file').fetchone()[0]
    path = Path(hba)
    require(path.is_absolute() and path.name == 'pg_hba.conf' and '..' not in path.parts, 'local database HBA path')
    script = '''set -eu
file="$1"
temp="${file}.pack99-recovery"
umask 077
{ printf '%s\\n' 'local postgres supabase_auth_admin,authenticator scram-sha-256'; cat "$file"; } > "$temp"
cat "$temp" > "$file"
rm "$temp"
'''
    docker(['exec', '--user', '0', 'pack99-backup-rehearsal', 'sh', '-c', script, 'pack99-local-hba', str(path)], env=env)
    with psycopg.connect(**target, autocommit=True) as db:
        require(db.execute('select pg_reload_conf()').fetchone()[0], 'reload isolated socket authentication')
    for role in ('supabase_auth_admin', 'authenticator'):
        for _ in range(30):
            try:
                with psycopg.connect(**(target | {'user': role, 'password': password})) as db:
                    require(db.execute('select current_user').fetchone()[0] == role, 'isolated database client role')
                break
            except psycopg.OperationalError:
                time.sleep(0.1)
        else:
            raise RecoveryBehaviorFailure('Isolated database service-role authentication failed')


@contextmanager
def services(target, sockets, env, key, instance):
    # Independently guard the write-capable service bootstrap, including callers
    # other than verify(). No password/HBA change precedes this exact marker.
    local_target(make_conninfo(**target), instance)
    sockets = Path(sockets)
    require(sockets.name == 'sockets' and sockets.parent.name.startswith('pack99-recovery-')
        and sockets.parent.stat().st_mode & 0o777 == 0o700, 'private database socket mount')
    require_networkless('pack99-backup-rehearsal', env)
    password = secrets.token_urlsafe(36)
    with psycopg.connect(**target) as db:
        db.execute("set local password_encryption='scram-sha-256'")
        for role in ('supabase_auth_admin', 'authenticator'):
            db.execute(sql.SQL('alter role {} password {}').format(sql.Identifier(role), sql.Literal(password)))
        db.execute('alter role supabase_auth_admin set search_path=auth,public,extensions')
        roles = db.execute("select rolname,rolsuper,rolbypassrls from pg_roles where rolname in ('authenticator','authenticated','anon')").fetchall()
        require(len(roles) == 3 and all(not r[1] and not r[2] for r in roles), 'application roles cannot bypass RLS')
        readiness = db.execute("""select
          (select rolcanlogin from pg_roles where rolname='supabase_auth_admin'),
          has_schema_privilege('supabase_auth_admin','auth','CREATE'),
          case when to_regclass('auth.users') is not null
            then has_table_privilege('supabase_auth_admin','auth.users','SELECT') else null end""").fetchone()
        print('Isolated Auth role readiness: ' + json.dumps(dict(zip(('login', 'schema_create', 'user_select'), readiness))), flush=True)
    socket_authentication(target, password, env)
    def uri(role):
        # pgx/libpq both support PostgreSQL Unix sockets via the host parameter.
        from urllib.parse import urlencode
        return 'postgresql://' + role + ':' + password + '@/postgres?' + urlencode({'host': '/var/run/postgresql'})
    auth_env = {'GOTRUE_API_HOST': '127.0.0.1', 'GOTRUE_API_PORT': '9999',
        'API_EXTERNAL_URL': 'http://127.0.0.1:9999', 'GOTRUE_SITE_URL': 'http://127.0.0.1',
        'GOTRUE_DB_DRIVER': 'postgres', 'GOTRUE_DB_DATABASE_URL': uri('supabase_auth_admin'),
        'GOTRUE_DB_NAMESPACE': 'auth', 'GOTRUE_JWT_SECRET': key, 'GOTRUE_JWT_AUD': 'authenticated',
        'GOTRUE_JWT_DEFAULT_GROUP_NAME': 'authenticated', 'GOTRUE_JWT_ADMIN_ROLES': 'service_role',
        'GOTRUE_JWT_EXP': '300', 'GOTRUE_DISABLE_SIGNUP': 'true', 'GOTRUE_EXTERNAL_EMAIL_ENABLED': 'true',
        'GOTRUE_MAILER_AUTOCONFIRM': 'true', 'GOTRUE_SMTP_HOST': '127.0.0.1', 'GOTRUE_SMTP_PORT': '1',
        'GOTRUE_SMTP_ADMIN_EMAIL': 'recovery@pack99.invalid', 'GOTRUE_LOG_LEVEL': 'error'}
    rest_env = {'PGRST_DB_URI': uri('authenticator'), 'PGRST_DB_SCHEMAS': 'public',
        'PGRST_DB_ANON_ROLE': 'anon', 'PGRST_JWT_SECRET': key, 'PGRST_JWT_AUD': 'authenticated',
        'PGRST_SERVER_HOST': '127.0.0.1', 'PGRST_SERVER_PORT': '3000', 'PGRST_LOG_LEVEL': 'crit'}
    created = []
    try:
        for name, image, values in ((AUTH_NAME, AUTH_IMAGE, auth_env), (REST_NAME, REST_IMAGE, rest_env)):
            child_env = {**env, **values}
            args = ['run', '-d', '--name', name, '--network=none', '--mount',
                'type=bind,src=' + str(sockets) + ',dst=/var/run/postgresql,readonly']
            for variable in values:
                args += ['--env', variable]
            docker([*args, image], env=child_env)
            created.append(name)
            require_networkless(name, env)
            settings = json.loads(docker(['inspect', '--format', '{{json .Config.Env}}', name], env=env).stdout)
            require(not PRIVATE_BINDINGS.intersection(v.split('=', 1)[0] for v in settings), 'production credentials absent from services')
        for name, port, path in ((AUTH_NAME, 9999, '/health'), (REST_NAME, 3000, '/')):
            for _ in range(60):
                try:
                    status, _ = http(name, port, 'GET', path, env=env)
                    if status == 200:
                        break
                except (RecoveryBehaviorFailure, ValueError):
                    pass
                running = docker(['inspect', '--format', '{{.State.Running}}', name], env=env)
                if running.stdout.strip() != b'true':
                    raise RecoveryBehaviorFailure(startup_failure(name, env))
                time.sleep(1)
            else:
                raise RecoveryBehaviorFailure('Isolated Auth/REST services did not become ready')
        yield
    finally:
        cleanup_failed = False
        for name in reversed(created):
            if docker(['rm', '-fv', name], env=env, check=False).returncode:
                cleanup_failed = True
        if cleanup_failed:
            raise RecoveryBehaviorFailure('Isolated Auth/REST cleanup failed')


def verify(connection, sockets, instance, s3, backup_id):
    target = local_target(connection, instance)
    env = {k: v for k, v in os.environ.items() if k not in
        ('DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH')}
    started = time.monotonic()
    evidence = {'backup_id': backup_id, 'started_at': timestamp(), 'status': 'failed',
        'scope': 'restored database plus isolated GoTrue/PostgREST; no external OAuth or provider mail', 'checks': {}}
    checks = evidence['checks']
    key = secrets.token_hex(48)
    admin = signed_token(key, {'role': 'service_role', 'aud': 'authenticated', 'exp': int(time.time()) + 1800})
    try:
        with psycopg.connect(**target) as db:
            before_schema = auth_schema(db)
            leader = db.execute("""select u.id,u.email from auth.users u join public.leader_access l
              on private.canonical_leader_email(u.email)=private.canonical_leader_email(l.email)
              where l.active and l.role='admin' and u.email_confirmed_at is not null
              and exists(select 1 from auth.identities i where i.user_id=u.id and i.provider='google'
                and i.identity_data->>'email_verified'='true'
                and private.canonical_leader_email(i.identity_data->>'email')=private.canonical_leader_email(l.email))
              order by u.created_at limit 1""").fetchone()
            require(leader is not None, 'restored approved administrator identity exists')
            scouts = [str(r[0]) for r in db.execute("select id from public.scouts where coalesce(den,'')!~*'^\\s*\\(withdraw\\)' order by id limit 2")]
            require(len(scouts) == 2, 'two restored scout records available for scope checks')
        print('Recovery behavior: starting networkless Auth and REST services', flush=True)
        with services(target, sockets, env, key, instance):
            with psycopg.connect(**target) as db:
                require(auth_schema(db) == before_schema, 'Auth version matches restored schema without new migrations')
            def auth(path, data=None, token=None, method='POST'):
                return http(AUTH_NAME, 9999, method, path, data=data, token=token, env=env)
            def rest(path, data=None, token=None, method='GET'):
                return http(REST_NAME, 3000, method, path, data=data, token=token, env=env)
            def rpc(name, args, token, allowed=True):
                status, value = rest('/rpc/' + name, args, token, 'POST')
                require((200 <= status < 300) if allowed else status in (401, 403), 'RPC access: ' + name)
                return value
            def login(email, password, user):
                status, session = auth('/token?grant_type=password', {'email': email, 'password': password})
                require(status == 200, 'local password sign-in')
                verify_user_token(session['access_token'], key, user)
                return session
            def accept(token):
                policy = rpc('get_site_policy_status', {}, token)
                require(policy and policy['eligible'], 'policy eligibility')
                rpc('accept_site_policies', {'policy_version': policy['version'],
                    'terms_hash': policy['terms_hash'], 'privacy_hash': policy['privacy_hash']}, token)
            print('Recovery behavior: restored leader identity and signed-token access', flush=True)
            password = secrets.token_urlsafe(36)
            status, _ = auth('/admin/users/' + str(leader[0]), {'password': password}, admin, 'PUT')
            require(status == 200, 'set clone-only recovery password')
            leader_session = login(leader[1], password, leader[0])
            leader_token = leader_session['access_token']
            accept(leader_token)
            status, rows = rest('/scouts?select=id', token=leader_token)
            require(status == 200 and set(scouts) <= {r['id'] for r in rows}, 'restored leader roster access')
            checks['restored_leader_auth_and_rls'] = True
            status, _ = rest('/scouts?select=id')
            require(status in (401, 403), 'anonymous roster denied')
            status, _ = rest('/scouts?select=id', token=signed_token('wrong-key', {'role': 'service_role', 'aud': 'authenticated', 'exp': int(time.time()) + 300}))
            require(status == 401, 'forged privileged JWT denied')
            checks['anonymous_and_forged_tokens_denied'] = True
            identities = {}
            for label in ('parent_a', 'parent_b', 'reader', 'stranger'):
                email, pwd = label + '-' + uuid.uuid4().hex + '@recovery.invalid', secrets.token_urlsafe(36)
                status, user = auth('/admin/users', {'email': email, 'password': pwd, 'email_confirm': True}, admin)
                require(status == 200, 'create isolated test identity')
                identities[label] = {'id': user['id'], 'email': email, 'password': pwd}
            with psycopg.connect(**target) as db:
                for label, scout in zip(('parent_a', 'parent_b'), scouts):
                    db.execute('insert into public.parent_scout_links(scout_id,parent_email,created_by) values(%s,%s,%s)', (scout, identities[label]['email'], leader[0]))
                reader = identities['reader']
                db.execute("insert into public.leader_access(email,role,active,can_record) values(%s,'leader',true,false)", (reader['email'],))
                db.execute("insert into auth.identities(id,user_id,provider_id,provider,identity_data,created_at,updated_at) values(%s,%s,%s,'google',%s::jsonb,now(),now())",
                    (uuid.uuid4(), reader['id'], reader['id'], json.dumps({'sub': reader['id'], 'email': reader['email'], 'email_verified': True})))
            for user in identities.values():
                user['session'] = login(user['email'], user['password'], user['id'])
                user['token'] = user['session']['access_token']
            a, b, reader, stranger = (identities[k] for k in ('parent_a', 'parent_b', 'reader', 'stranger'))
            print('Recovery behavior: policy gating and parent/family boundaries', flush=True)
            rpc('read_parent_dashboard', {}, a['token'], allowed=False)
            status, wrong = auth('/token?grant_type=password', {'email': a['email'], 'password': 'incorrect-local-test-password'})
            require(status == 400 and 'access_token' not in wrong, 'incorrect password denied')
            for parent, scout in ((a, scouts[0]), (b, scouts[1])):
                accept(parent['token'])
                require(rpc('claim_parent_links', {}, parent['token']) == 1, 'parent claims only its approved relationship')
                view = rpc('read_parent_dashboard', {}, parent['token'])
                require({r['id'] for r in view['scouts']} == {scout}, 'parent sees exactly its approved child')
                rpc('read_pack_workspace', {'view_name': 'planner'}, parent['token'], allowed=False)
            checks['policies_and_parent_read_scope'] = True
            accept(reader['token'])
            status, rows = rest('/scouts?select=id', token=reader['token'])
            require(status == 200 and set(scouts) <= {r['id'] for r in rows}, 'read-only leader can read')
            status, rows = rest('/scouts?select=id', token=stranger['token'])
            require(status == 200 and rows == [], 'unapproved user cannot read roster')
            rpc('read_pack_workspace', {'view_name': 'planner'}, stranger['token'], allowed=False)
            activity = str(uuid.uuid4())
            create = {'action': 'create_activity', 'activity_id': activity, 'title': 'Isolated recovery test',
                'kind': 'hike', 'scouting_year': '2026-27', 'occurred_on': '2026-10-10'}
            rpc('record_pack_operation', {'request_id': str(uuid.uuid4()), 'command': create}, reader['token'], allowed=False)
            rpc('record_pack_operation', {'request_id': str(uuid.uuid4()), 'command': create}, a['token'], allowed=False)
            request = str(uuid.uuid4())
            first = rpc('record_pack_operation', {'request_id': request, 'command': create}, leader_token)
            require(rpc('record_pack_operation', {'request_id': request, 'command': create}, leader_token) == first, 'leader write retry is idempotent')
            status, _ = rest('/scouts?id=eq.' + scouts[0], {'scout_name': 'Unauthorized mutation'}, leader_token, 'PATCH')
            require(status in (401, 403), 'direct table writes remain denied')
            message = {'action': 'send_family_message', 'scout_id': scouts[0], 'scouting_year': '2026-27',
                'as_role': 'parent', 'body': 'Isolated recovery permission check'}
            rpc('record_family_operation', {'request_id': str(uuid.uuid4()), 'command': message}, b['token'], allowed=False)
            rpc('record_family_operation', {'request_id': str(uuid.uuid4()), 'command': message}, a['token'])
            checks['write_capabilities_and_family_scope'] = True
            print('Recovery behavior: live revocation and Auth refresh/logout', flush=True)
            with psycopg.connect(**target) as db:
                db.execute('update public.parent_scout_links set active=false where parent_email=%s', (a['email'],))
            view = rpc('read_parent_dashboard', {}, a['token'])
            require(view['scouts'] == [], 'relationship revocation removes reads with existing token')
            rpc('record_family_operation', {'request_id': str(uuid.uuid4()), 'command': message}, a['token'], allowed=False)
            with psycopg.connect(**target) as db:
                db.execute('update public.leader_access set active=false where email=%s', (reader['email'],))
            status, rows = rest('/scouts?select=id', token=reader['token'])
            require(status == 200 and rows == [], 'leader revocation removes reads with existing token')
            checks['live_relationship_and_leader_revocation'] = True
            status, refreshed = auth('/token?grant_type=refresh_token', {'refresh_token': a['session']['refresh_token']})
            require(status == 200, 'Auth refresh succeeds')
            verify_user_token(refreshed['access_token'], key, a['id'])
            status, _ = auth('/logout?scope=global', token=refreshed['access_token'])
            require(status in (200, 204), 'Auth logout succeeds')
            status, denied = auth('/token?grant_type=refresh_token', {'refresh_token': refreshed['refresh_token']})
            require(status == 400 and 'access_token' not in denied, 'logout revokes refresh token')
            checks['password_refresh_and_logout'] = True
        evidence.update(status='behavior-verified', auth_version='v2.197.0', rest_version='v14.5',
            services_networkless=True, production_runtime_keys_absent_from_service_environments=True, external_mail_disabled=True,
            parent_scope_uses_local_test_identities=True, restored_leader_password_change_clone_only=True,
            auth_schema_unchanged=True, google_oauth_roundtrip_verified=False,
            remaining='External Google OAuth/leader login, uploaded-file behavior and independent administrator recovery need separate acceptance')
    finally:
        evidence['finished_at'] = timestamp()
        evidence['duration_seconds'] = round(time.monotonic() - started, 3)
        put_json(s3, 'rehearsals/' + backup_id + '-behavior.json', evidence)
    print(json.dumps(evidence), flush=True)
    return evidence
