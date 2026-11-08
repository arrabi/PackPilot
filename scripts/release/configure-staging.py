"""Install staging-only configuration; never reads or copies production secrets."""
import argparse
import base64
import json
import os
from pathlib import Path
import secrets
from platform_api import private_json, project_ref, query, supabase

ROOT = Path(__file__).resolve().parents[2]
STATE = ROOT / '.local/release/staging-admin.json'


def configure():
    config = json.loads((ROOT / 'config/release-system.json').read_text())
    ref = project_ref(config['staging_project'], staging=True)
    origin = config['staging_origin']
    allowed_origins = {'https://staging.packpilot.example', 'https://packpilot-staging.pages.dev'}
    legacy = config.get('staging_legacy_origin')
    if origin not in allowed_origins or legacy and legacy not in allowed_origins:
        raise RuntimeError('Unexpected staging website')
    query(ref, (ROOT / 'scripts/release/staging-auth-audit.sql').read_text())
    state = json.loads(STATE.read_text()) if STATE.exists() else {}
    state.setdefault('auth_hook_secret', 'v1,whsec_' + base64.b64encode(secrets.token_bytes(32)).decode())
    state.setdefault('dispatch_secret', secrets.token_hex(32))
    private_json(STATE, state)
    keys = supabase('/v1/projects/' + ref + '/api-keys')
    service = next((key['api_key'] for key in keys if key.get('name') == 'service_role'), None)
    if not service:
        raise RuntimeError('Staging service key unavailable')
    values = {'PACK99_ENVIRONMENT': 'staging', 'PACK99_EMAIL_ALLOWLIST': 'staging@example.test',
        'PACK99_AUTH_UI_ORIGIN': origin, 'AUTH_UI_ORIGIN': origin,
        'MCP_RESOURCE_URL': 'https://' + ref + '.supabase.co/functions/v1/scouts-mcp',
        'PACK99_DATABASE_KEY': service, 'PACK99_DISPATCH_SECRET': state['dispatch_secret'],
        'AUTH_EMAIL_HOOK_SECRET': state['auth_hook_secret'], 'PACK99_FROM_EMAIL': 'admin@example.test',
        'PACK99_DELIVERY_PAUSED': 'true'}
    # Owner authorized the existing Brevo mail service for staging. Its credential
    # stays behind the independently enforced application/Auth recipient gates.
    provider = os.environ.get('STAGING_BREVO_API_KEY') or os.environ.get('BREVO_API_KEY')
    if provider:
        values['BREVO_API_KEY'] = provider
    supabase('/v1/projects/' + ref + '/secrets', method='POST', data=[{'name': key, 'value': value} for key, value in values.items()])
    # Keep signups and email login closed until a real callback/provider rehearsal.
    supabase('/v1/projects/' + ref + '/config/auth', method='PATCH', data={
        'disable_signup': True, 'external_email_enabled': False,
        'site_url': origin,
        'uri_allow_list': ','.join(value + '/**' for value in dict.fromkeys([origin, legacy]) if value),
        # Supabase's default of two requests/hour prevents the allowed+blocked
        # callback rehearsal and a retry. The signed recipient gate still applies.
        'rate_limit_email_sent': 20,
        'hook_send_email_enabled': True,
        'hook_send_email_uri': 'https://' + ref + '.supabase.co/functions/v1/staging-auth-email',
        'hook_send_email_secrets': state['auth_hook_secret']})
    print('Configured isolated staging secrets and signed Auth hook; delivery paused; signup/email login closed')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', required=True, action='store_true')
    parser.parse_args()
    try:
        configure()
    except Exception:
        raise SystemExit('Staging configuration incomplete; keep staging closed; no secret values logged')
