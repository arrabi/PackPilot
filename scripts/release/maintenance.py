"""Set the application write barrier using a direct administrator connection."""
import argparse
import os
import re
import psycopg
from psycopg.conninfo import conninfo_to_dict


def reject_environment_overrides():
    # libpq reads these even when host/user are explicit. In particular an
    # inherited hostaddr can route a localhost restore into another database.
    if any(os.environ.get(key) for key in ('PGHOSTADDR', 'PGSERVICE', 'PGSERVICEFILE', 'PGOPTIONS')):
        raise RuntimeError('Inherited PostgreSQL routing/session overrides are not permitted')


def connection_target(connection, project):
    reject_environment_overrides()
    target = conninfo_to_dict(connection)
    if any(key in target for key in ('hostaddr', 'service', 'servicefile', 'options')):
        raise RuntimeError('Database connection overrides are not permitted')
    direct = target.get('host') == 'db.' + project + '.supabase.co'
    pooler = (re.fullmatch(r'[a-z0-9-]+\.pooler\.supabase\.com', target.get('host', ''))
              and target.get('user') == 'postgres.' + project and str(target.get('port', '5432')) == '5432')
    if not (direct or pooler) or str(target.get('port', '5432')) != '5432':
        raise RuntimeError('Database connection does not identify the expected Supabase project')
    if target.get('dbname', 'postgres') != 'postgres':
        raise RuntimeError('Expected the Supabase postgres database')
    if target.get('sslmode', 'verify-full') != 'verify-full':
        raise RuntimeError('Database TLS certificate and hostname verification is required')
    target.setdefault('sslmode', 'verify-full')
    # The CI-provided trusted provider CA also applies to URIs that explicitly
    # selected system roots. Preserve an operator's explicit CA-file selection.
    if target.get('sslrootcert') in (None, 'system'):
        target['sslrootcert'] = os.environ.get('PGSSLROOTCERT') or 'system'
    target.setdefault('dbname', 'postgres')
    target.setdefault('port', '5432')
    target.setdefault('user', 'postgres')
    target.setdefault('connect_timeout', '15')
    return target


def open_local_recovery_barrier(connection):
    """Open only an explicitly isolated clone after its delivery/session cleanup."""
    marker = connection.execute("select current_setting('pack99.local_recovery_target', true)").fetchone()[0]
    if marker != 'isolated':
        raise RuntimeError('Recovery barrier changes require the isolated local target marker')
    if connection.execute("select to_regprocedure('private.set_release_maintenance(boolean)')").fetchone()[0]:
        connection.execute('select private.set_release_maintenance(false)')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('state', choices=['on', 'off'])
    parser.add_argument('--environment', choices=['staging', 'production'], required=True)
    args = parser.parse_args()
    prefix = args.environment.upper()
    project = 'aaaaaaaaaaaaaaaaaaaa' if args.environment == 'production' else os.environ['STAGING_PROJECT_REF']
    if args.environment == 'staging' and project == 'aaaaaaaaaaaaaaaaaaaa':
        raise SystemExit('Staging cannot target production')
    # No SQL, URL or exception containing credentials is printed.
    try:
        target = connection_target(os.environ[prefix + '_DATABASE_URL'], project)
        with psycopg.connect(**target) as connection:
            connection.execute("set local lock_timeout = '60s'")
            connection.execute('select private.set_release_maintenance(%s)', (args.state == 'on',))
    except Exception:
        raise SystemExit('Maintenance operation failed; inspect database access and migration readiness securely')
    print('Application maintenance ' + args.state + ' for ' + args.environment)
