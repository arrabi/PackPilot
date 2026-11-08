"""Manual Actions backup/restore rehearsal; never deploys or restores remotely.

The database restores with all application services stopped. Networkless Auth
and REST services then exercise permissions using a new local signing key and
blocked SMTP. Real recovery data stays in private R2 and the ephemeral runner,
never an Actions artifact. External OAuth/file/administrator acceptance remains
separate from this automated rehearsal.
"""
import argparse
from contextlib import contextmanager
import importlib.util
import json
import os
from pathlib import Path
from typing import NamedTuple
import secrets
import subprocess
import tempfile
import time
import re

from backup import BUCKET, backup, client

# Verified linux/amd64 manifest for this PostgreSQL 17 Supabase image.
IMAGE = 'supabase/postgres:17.6.1.063@sha256:432d12926b09e10eb3317b0e2e9672c9ce8ea6bccb359857a31ff9f90683161d'
NAME = 'pack99-backup-rehearsal'


class LocalDatabase(NamedTuple):
    connection: str
    sockets: Path
    instance: str


def failure_reason(error):
    """Return a fixed diagnosis, never an exception body, DSN or SQL value."""
    import psycopg
    from recovery_behavior import RecoveryBehaviorFailure
    if isinstance(error, RecoveryBehaviorFailure):
        return str(error)
    if isinstance(error, psycopg.OperationalError):
        message = str(error).lower()
        if 'password authentication failed' in message or error.sqlstate == '28P01':
            return 'Database password authentication failed; verify the existing production password in the Actions secret'
        if 'tenant or user not found' in message:
            return 'Database pooler user/project was not found; verify the Session pooler URI and postgres.PROJECT username'
        if 'certificate' in message or 'sslrootcert' in message or 'sslmode' in message:
            return 'Database TLS verification failed; check trusted CA configuration and certificate hostname'
        if 'translate host' in message or 'name or service not known' in message:
            return 'Database hostname could not be resolved'
        if any(value in message for value in ('timeout', 'timed out', 'connection refused', 'network is unreachable', 'no route to host')):
            return 'Database TCP connection failed or timed out; check database availability and network restrictions'
        return 'Database connection failed; private connection details withheld'
    if isinstance(error, psycopg.Error):
        state = error.sqlstate
        if state and re.fullmatch('[A-Z0-9]{5}', state):
            return 'Database operation rejected (SQLSTATE ' + state + '); SQL and record values withheld'
        return 'Database connection string or operation is invalid; private details withheld'
    safe_messages = {
        'Inherited PostgreSQL routing/session overrides are not permitted',
        'Database connection overrides are not permitted',
        'Database connection does not identify the expected Supabase project',
        'Expected the Supabase postgres database',
        'Database TLS certificate and hostname verification is required',
        'Unexpected production storage project',
        'PostgreSQL 17 server and backup client required',
        'Required production schemas missing',
        'Production pg_dump failed; credentials and SQL errors withheld',
        'Storage changed during capture; retry with uploads paused',
        'Isolated database container operation failed',
        'Local pg_restore failed; review role/schema compatibility securely',
        'Restored table count mismatch',
        'Restored database contains unvalidated constraints',
        'Restored RLS configuration differs from backup',
    }
    if type(error) is RuntimeError and str(error) in safe_messages:
        return str(error)
    response = getattr(error, 'response', None)
    if isinstance(response, dict):
        status = response.get('ResponseMetadata', {}).get('HTTPStatusCode')
        if isinstance(status, int) and 100 <= status <= 599:
            return 'R2 request failed (HTTP ' + str(status) + '); provider body withheld'
    return 'Rehearsal failed; private exception details withheld'


def command(args, env):
    result = subprocess.run(['docker', '--host=unix:///var/run/docker.sock', *args],
        env=env, capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError('Isolated database container operation failed')
    return result.stdout.strip()


@contextmanager
def isolated_database():
    import psycopg
    from psycopg.conninfo import make_conninfo
    env = {key: value for key, value in os.environ.items() if key not in
        ('DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH')}
    env['POSTGRES_PASSWORD'] = secrets.token_urlsafe(36)
    instance = secrets.token_hex(16)
    with tempfile.TemporaryDirectory(prefix='pack99-recovery-') as temp:
        # The parent remains private (0700); only this subdirectory is mounted
        # into the database so its postgres user can create the Unix socket.
        sockets = Path(temp) / 'sockets'
        sockets.mkdir(mode=0o777)
        sockets.chmod(0o777)
        container_created = False
        forwarder = None
        try:
            # No container network at all. The runner reaches this database only
            # through a private Unix socket and a localhost-only socat listener.
            command(['run', '-d', '--name', NAME, '--network=none',
                '--mount', 'type=bind,src=' + str(sockets) + ',dst=/var/run/postgresql',
                '--env', 'POSTGRES_PASSWORD', '--env', 'POSTGRES_USER=supabase_admin', '--env', 'POSTGRES_DB=postgres',
                IMAGE, 'postgres', '-D', '/etc/postgresql', '-c', 'cron.launch_active_jobs=off',
                '-c', 'unix_socket_directories=/var/run/postgresql', '-c', 'unix_socket_permissions=0777',
                '-c', 'pack99.rehearsal_id=' + instance], env)
            container_created = True
            if command(['inspect', '--format', '{{.HostConfig.NetworkMode}}', NAME], env) != 'none':
                raise RuntimeError('Recovery container must have no network')
            forwarder = subprocess.Popen(['socat', 'TCP-LISTEN:55432,bind=127.0.0.1,reuseaddr,fork',
                'UNIX-CONNECT:' + str(sockets / '.s.PGSQL.5432')],
                env={'PATH': os.environ['PATH']}, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            target = {'host': '127.0.0.1', 'port': '55432', 'dbname': 'postgres',
                'user': 'supabase_admin', 'password': env['POSTGRES_PASSWORD'],
                'connect_timeout': '2', 'sslmode': 'disable'}
            for _ in range(90):
                if forwarder.poll() is not None:
                    raise RuntimeError('Recovery localhost listener failed; check port 55432 availability')
                try:
                    with psycopg.connect(**target, autocommit=True) as db:
                        # A preexisting listener/forwarder must never get marked
                        # as an isolated restore target, even on a port collision.
                        if db.execute("select current_setting('pack99.rehearsal_id', true)").fetchone()[0] != instance:
                            raise RuntimeError('Local listener is not this disposable database')
                        if db.info.server_version // 10000 != 17:
                            raise RuntimeError('Recovery requires PostgreSQL 17')
                        if db.execute("select current_setting('cron.launch_active_jobs')").fetchone()[0] != 'off':
                            raise RuntimeError('Recovery scheduler must be stopped')
                        db.execute("alter database postgres set pack99.local_recovery_target='isolated'")
                    break
                except psycopg.OperationalError:
                    time.sleep(2)
            else:
                raise RuntimeError('Isolated Supabase PostgreSQL did not become ready')
            yield LocalDatabase(make_conninfo(**target), sockets, instance)
        finally:
            if forwarder:
                forwarder.terminate()
                try:
                    forwarder.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    forwarder.kill()
                    forwarder.wait()
            if container_created:
                command(['rm', '-fv', NAME], env)
                # PostgreSQL's entrypoint changes socket-directory ownership and
                # sets its sticky bit. A killed postmaster may leave socket/lock
                # files the runner cannot unlink. A networkless root helper only
                # fixes this mounted directory; the private parent stays 0700.
                command(['run', '--rm', '--network=none', '--user', '0', '--entrypoint', 'chmod',
                    '--mount', 'type=bind,src=' + str(sockets) + ',dst=/var/run/postgresql',
                    IMAGE, '0777', '/var/run/postgresql'], env)


def authorized_source():
    if (os.environ.get('GITHUB_ACTIONS') != 'true' or os.environ.get('GITHUB_ACTOR') != 'YOUR_GITHUB_OWNER'
            or os.environ.get('GITHUB_REPOSITORY') != 'YOUR_GITHUB_OWNER/YOUR_GITHUB_REPOSITORY'):
        raise RuntimeError('Rehearsal requires owner-approved Actions execution')
    if os.environ.get('GITHUB_EVENT_NAME') == 'workflow_dispatch' and os.environ.get('GITHUB_REF') == 'refs/heads/main':
        expected = os.environ.get('GITHUB_SHA', '')
    elif os.environ.get('GITHUB_EVENT_NAME') == 'pull_request':
        from workflow_context import owner_pr_snapshot
        owner_pr_snapshot(Path(__file__).resolve().parents[2], 'rehearse-backup')
        return
    else:
        raise RuntimeError('Rehearsal requires owner-dispatched main or an owner-labeled PR')
    root = Path(__file__).resolve().parents[2]
    actual = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
    if not re.fullmatch('[a-f0-9]{40}', expected) or actual != expected:
        raise RuntimeError('Rehearsal source must match the exact approved Actions snapshot')


def rehearse(prefix=None):
    authorized_source()
    required = ['CLOUDFLARE_ACCOUNT_ID', 'R2_ENDPOINT', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']
    if not prefix:
        required += ['PRODUCTION_DATABASE_URL', 'PRODUCTION_SUPABASE_URL', 'PRODUCTION_SUPABASE_SERVICE_KEY']
    missing = [name for name in required if not os.environ.get(name)]
    if missing:
        print('Missing Actions bindings: ' + ', '.join(missing), flush=True)
        raise RuntimeError('Actions setup incomplete')
    s3 = client()
    print('Checking private R2 access and preparing a disposable database', flush=True)
    s3.head_bucket(Bucket=BUCKET)
    with isolated_database() as local:
        if not prefix:
            print('Capturing production read-only and verifying private R2 readback', flush=True)
            prefix = backup(s3, reason='recovery-rehearsal')['prefix']
            print('Validated private R2 recovery point: ' + prefix, flush=True)
        print('Restoring the R2 recovery point into isolated Supabase PostgreSQL 17', flush=True)
        spec = importlib.util.spec_from_file_location('restore_local', Path(__file__).with_name('restore-local.py'))
        restore = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(restore)
        # The stopped-services assertion describes this script's database-only
        # container. It must never be used for a remote or active application.
        names = ('LOCAL_DATABASE_URL', 'LOCAL_RECOVERY_SERVICES_STOPPED')
        previous = {name: os.environ.get(name) for name in names}
        try:
            os.environ['LOCAL_DATABASE_URL'] = local.connection
            os.environ['LOCAL_RECOVERY_SERVICES_STOPPED'] = 'true'
            evidence = restore.restore(prefix, max_bytes=2 * 1024**3)
            # Restore has completed and delivery/session state is scrubbed.
            # Only now start isolated services for behavioral acceptance.
            os.environ['LOCAL_RECOVERY_SERVICES_STOPPED'] = 'false'
            from recovery_behavior import verify
            behavior = verify(local.connection, local.sockets, local.instance, s3, evidence['backup_id'])
        finally:
            for name, value in previous.items():
                if value is None:
                    os.environ.pop(name, None)
                else:
                    os.environ[name] = value
    summary = ('Database recovery rehearsal: ' + evidence['status'] + '; Auth/permissions: ' + behavior['status'] + '\n\n'
        'Backup: `' + prefix + '`. Evidence and the retained recovery pin are in private R2.\n\n'
        'External Google OAuth, uploaded-file behavior and independent administrator recovery still need acceptance. Schedules and production activation remain disabled.\n')
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as output:
            output.write(summary)
    return evidence


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--prefix', help='Existing backups/CAPTURE-ID; blank captures a new recovery point')
    args = parser.parse_args()
    try:
        rehearse(args.prefix)
    except Exception as error:
        print('Failure diagnosis: ' + failure_reason(error), flush=True)
        raise SystemExit('Backup/restore rehearsal incomplete; inspect binding setup and private R2 evidence. No remote restore or deployment was attempted.')
