"""Save private recovery inventories without claiming hashed platform secrets recoverable.

Exports function bodies (including independently managed functions), safe Auth
settings, secret digests, Vault names and scheduler metadata. No decrypted secrets
are read and no secret-bearing configuration/SQL is printed. Transfer this ignored
directory to the administrators' secure recovery store before workspace replacement.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import os
from access import PRODUCTION_PROJECT
from backup import timestamp
from platform_api import private_json, query, supabase

ROOT = Path(__file__).resolve().parents[2]
AUTH_FIELDS = ('site_url', 'uri_allow_list', 'disable_signup', 'external_email_enabled',
    'external_google_enabled', 'hook_send_email_enabled', 'hook_send_email_uri',
    'smtp_host', 'smtp_port', 'smtp_admin_email', 'smtp_sender_name', 'rate_limit_email_sent')
AUTOMATION = ('SUPABASE_ACCESS_KEY', 'CLOUDFLARE_API_TOKEN', 'PRODUCTION_DATABASE_URL',
    'PRODUCTION_SUPABASE_SERVICE_KEY', 'R2_ENDPOINT', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'BREVO_API_KEY')


def inventory(project, *, destination=None):
    path = Path(destination) if destination is not None else ROOT / '.local/release/platform' / project
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    base = '/v1/projects/' + project
    secrets = supabase(base + '/secrets')
    auth = supabase(base + '/config/auth')
    functions = []
    for function in supabase(base + '/functions'):
        slug = function['slug']
        if not re.fullmatch('[a-zA-Z0-9_-]+', slug):
            raise RuntimeError('Unexpected deployed function name')
        body = supabase(base + '/functions/' + slug + '/body', return_bytes=True)
        filename = slug + '.bundle'
        fd = os.open(path / filename, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'wb') as output:
            output.write(body)
        functions.append({'slug': slug, 'version': function['version'], 'verify_jwt': function.get('verify_jwt'),
            'file': filename, 'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest()})
    vault = query(project, 'select name from vault.secrets order by name')
    jobs = query(project, 'select jobname,schedule,active,md5(command) as command_digest from cron.job order by jobname')
    value = {'project': project, 'captured_at': timestamp(), 'functions': functions,
        'auth': {key: auth.get(key) for key in AUTH_FIELDS},
        'edge_secret_digests': sorted([{'name': item['name'], 'digest': item['value']} for item in secrets], key=lambda s: s['name']),
        'vault_secret_names': [item['name'] for item in vault], 'scheduler': jobs,
        'automation_binding_presence': {name: bool(os.environ.get(name)) for name in AUTOMATION},
        'recovery_status': 'incomplete: administrator must verify an independent secure store for every secret',
        'limitations': 'Secret digests cannot reconstruct values. Function exports may contain sensitive source; keep the entire directory private. Auth credentials, OAuth configuration, SMTP/hook secrets, Vault values and automation credentials need independently verified secure recovery copies.'}
    private_json(path / 'inventory.json', value)
    return value


if __name__ == '__main__':
    argparse.ArgumentParser(description=__doc__).parse_args()
    try:
        staging = json.loads((ROOT / 'config/release-system.json').read_text())['staging_project']
        for project in (PRODUCTION_PROJECT, staging):
            value = inventory(project)
            print('Private platform inventory saved for ' + project + ': ' + str(len(value['functions'])) + ' function exports; external secret recovery remains unverified')
    except Exception:
        raise SystemExit('Platform inventory incomplete; no secret values logged')
