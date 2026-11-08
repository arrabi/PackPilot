"""Rehearse transaction draining on disposable PostgreSQL 17; no production access."""
import os
from pathlib import Path
import subprocess
import time
import uuid


def main():
    name = 'pack99-maintenance-' + uuid.uuid4().hex[:10]
    env = {k: v for k, v in os.environ.items() if k not in ('DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH')}
    docker = ['docker', '--host=unix:///var/run/docker.sock']
    subprocess.run(docker + ['run', '-d', '--name', name, '--network=none', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgres:17'], env=env, check=True, stdout=subprocess.DEVNULL)
    base = docker + ['exec', '-i', name, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At']

    def execute(sql, *, check=True):
        return subprocess.run(base, input=sql, text=True, env=env, capture_output=True, check=check)

    try:
        for _ in range(30):
            if execute('select 1', check=False).returncode == 0:
                break
            time.sleep(0.3)
        else:
            raise RuntimeError('Disposable PostgreSQL failed to initialize')
        execute('create schema private;create role anon;create role authenticated;create role service_role;create table public.records(id int);grant all on public.records to authenticated,service_role;')
        migration = Path(__file__).resolve().parents[2] / 'supabase/migrations/20261105090000_release_maintenance.sql'
        execute(migration.read_text())
        # Hold an existing write transaction. Activation must wait until it commits.
        writer = subprocess.Popen(base, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
        writer.stdin.write("begin;set local role authenticated;insert into public.records values(1);select pg_sleep(3);commit;\n")
        writer.stdin.close()
        for _ in range(30):
            locked = execute("select count(*) from pg_locks where locktype='advisory' and objid=990050900 and granted").stdout.strip()
            if locked == '1':
                break
            time.sleep(0.1)
        else:
            raise RuntimeError('Writer did not acquire the maintenance lock')
        start = time.monotonic()
        execute('select private.set_release_maintenance(true)')
        if time.monotonic() - start < 1:
            raise RuntimeError('Maintenance did not drain the existing write')
        if writer.wait(timeout=10) != 0:
            raise RuntimeError('Existing write failed instead of completing')
        for role in ('authenticated', 'service_role'):
            for statement in ('insert into public.records values(2)', 'update public.records set id=3', 'delete from public.records', 'truncate public.records'):
                result = execute('set role ' + role + ';' + statement, check=False)
                if result.returncode == 0 or 'maintenance' not in result.stderr:
                    raise RuntimeError('Maintenance failed to block ' + role)
        execute('select private.set_release_maintenance(false);set role authenticated;insert into public.records values(2);reset role;')
        if execute('select count(*) from public.records').stdout.strip() != '2':
            raise RuntimeError('Reopening did not restore application writes')
        print('PostgreSQL 17 rehearsal passed: existing writers drain; application/service writes block; reopening works')
    finally:
        subprocess.run(docker + ['rm', '-f', name], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == '__main__':
    main()
