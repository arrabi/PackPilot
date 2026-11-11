"""Expire private assistant state after the verified daily production backup.

Uses the existing production operation lock and TLS-bound database credential.
No scout records, provider keys, prompts or notification queues are read/written.
"""
import os
from pathlib import Path
import psycopg
from access import PRODUCTION_PROJECT
from maintenance import connection_target


def prune(connection):
    ready = connection.execute("select to_regclass('private.pack_assistant_proposals') is not null and to_regclass('private.pack_assistant_usage') is not null").fetchone()[0]
    if not ready:
        return False  # A previous production version may predate the assistant.
    paused = connection.execute('select enabled from private.pack_release_maintenance where singleton').fetchone()[0]
    if paused is not False:
        return False
    connection.execute("set local lock_timeout = '5s'")
    connection.execute((Path(__file__).with_name('assistant-retention.sql')).read_text())
    return True


if __name__ == '__main__':
    try:
        if (os.environ.get('GITHUB_ACTIONS') != 'true' or os.environ.get('GITHUB_REF') != 'refs/heads/main'
                or os.environ.get('GITHUB_REPOSITORY') != 'YOUR_GITHUB_OWNER/YOUR_GITHUB_REPOSITORY'):
            raise RuntimeError('Assistant retention requires the main-only production backup workflow')
        with psycopg.connect(**connection_target(os.environ['PRODUCTION_DATABASE_URL'], PRODUCTION_PROJECT)) as connection:
            completed = prune(connection)
        print('Assistant retention completed' if completed else 'Assistant retention skipped: not installed or maintenance enabled')
    except Exception:
        raise SystemExit('Assistant retention incomplete; inspect the production backup workflow securely') from None
