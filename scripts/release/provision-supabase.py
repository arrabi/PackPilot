"""Create an empty staging project; keep signup/mail closed until isolation is verified."""
import argparse
import json
from pathlib import Path
import secrets
from platform_api import private_json, supabase, project_ref

ORG = 'vhxpnnhnucogckphhdhj'
NAME = 'PackPilot staging'
STATE = Path(__file__).resolve().parents[2] / '.local/release/staging-admin.json'
CONFIG = Path(__file__).resolve().parents[2] / 'config/release-system.json'


def provision(apply):
    projects = supabase('/v1/projects')
    matches = [p for p in projects if p['name'] == NAME and p['organization_id'] == ORG]
    if len(matches) > 1:
        raise RuntimeError('Multiple staging projects; inspect before continuing')
    if not matches:
        if not apply:
            print('Would create isolated free Supabase staging project in scouts99 / us-east-1')
            return
        # Persist before creating, so interrupted creation does not lose its password.
        state = json.loads(STATE.read_text()) if STATE.exists() else {'database_password': secrets.token_urlsafe(36)}
        private_json(STATE, state)
        project = supabase('/v1/projects', method='POST', data={'organization_id': ORG,
            'name': NAME, 'region': 'us-east-1', 'plan': 'free', 'db_pass': state['database_password']})
        state['project_ref'] = project['id']
        private_json(STATE, state)
    else:
        project = matches[0]
    ref = project_ref(project['id'], staging=True)
    config = {'production_project': 'aaaaaaaaaaaaaaaaaaaa', 'staging_project': ref,
              'production_pages': 'packpilot-site', 'staging_pages': 'packpilot-staging',
              'staging_origin': 'https://staging.packpilot.example',
              'staging_legacy_origin': 'https://packpilot-staging.pages.dev', 'backup_bucket': 'packpilot-production-backups'}
    if apply:
        CONFIG.write_text(json.dumps(config, indent=2) + '\n')
        # A just-created project may still be initializing. Retry this idempotent
        # command after it is healthy; never create another project on failure.
        supabase('/v1/projects/' + ref + '/config/auth', method='PATCH', data={
            'disable_signup': True, 'external_email_enabled': False,
            'external_anonymous_users_enabled': False,
            'site_url': config['staging_origin'],
            'uri_allow_list': ','.join(config[key] + '/**' for key in ('staging_origin', 'staging_legacy_origin'))})
        auth = supabase('/v1/projects/' + ref + '/config/auth')
        if auth.get('disable_signup') is not True or auth.get('external_email_enabled') is not False:
            raise RuntimeError('Staging Auth closure did not verify')
    print('Staging project: ' + ref + '; application data not copied; signup/email must remain closed')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    try:
        provision(parser.parse_args().apply)
    except Exception as error:
        from platform_api import APIError
        raise SystemExit(str(error) if isinstance(error, APIError) else 'Staging provisioning incomplete; inspect private state and retry')
