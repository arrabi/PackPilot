"""Read-only production bindings and adoption audit; never activates or deploys.

The public report contains fixed labels, booleans, HTTP statuses and public IDs.
Provider bodies, database records and private recovery metadata stay in memory.
"""
import argparse
import base64
import json
import os
from pathlib import Path
import re
import subprocess
import urllib.error
import urllib.request

import psycopg
from botocore.exceptions import ClientError

from access import PRODUCTION_PROJECT, request_json
from backend import plan
from backup import BUCKET, client, freshness
from deploy import candidate, site_response, staging_evidence
from maintenance import connection_target
from platform_api import query

ROOT = Path(__file__).resolve().parents[2]
ACCOUNT = '00000000000000000000000000000000'


def authorized_source():
    expected = {'GITHUB_ACTIONS': 'true', 'GITHUB_ACTOR': 'YOUR_GITHUB_OWNER',
                'GITHUB_REPOSITORY': 'YOUR_GITHUB_OWNER/YOUR_GITHUB_REPOSITORY',
                'GITHUB_EVENT_NAME': 'workflow_dispatch', 'GITHUB_REF': 'refs/heads/main'}
    if any(os.environ.get(key) != value for key, value in expected.items()):
        raise RuntimeError('Preflight requires an owner dispatch on main')
    actual = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    if actual != os.environ.get('GITHUB_SHA'):
        raise RuntimeError('Preflight controller does not match the dispatched source')


def object_or_none(s3, key):
    try:
        return json.loads(s3.get_object(Bucket=BUCKET, Key=key)['Body'].read())
    except ClientError as error:
        if error.response.get('Error', {}).get('Code') in ('NoSuchKey', '404', 'NotFound'):
            return None
        raise


def recovery_accepted(s3):
    activation = object_or_none(s3, 'activation/verified.json')
    if not activation or activation.get('status') != 'verified' or activation.get('recovery_administrator') != 'Recovery Administrator':
        return False
    key = activation.get('restore_rehearsal_key', '')
    if not re.fullmatch(r'rehearsals/[A-Za-z0-9-]+\.json', key):
        return False
    receipt = object_or_none(s3, key)
    return bool(receipt and receipt.get('status') == 'verified')


def database_binding():
    target = connection_target(os.environ['PRODUCTION_DATABASE_URL'], PRODUCTION_PROJECT)
    with psycopg.connect(**target) as db:
        db.execute('begin read only')
        return db.execute('select current_database(), current_setting(\'transaction_read_only\')').fetchone() == ('postgres', 'on')


class ServiceAPIError(RuntimeError):
    def __init__(self, diagnostics):
        super().__init__('Production service API request failed; see safe diagnostics')
        self.diagnostics = diagnostics


def key_diagnostics(key):
    # Decode claims only to diagnose configuration. This is not JWT verification;
    # the actual API request still determines whether the credential is accepted.
    result = {'binding_present': bool(key), 'outer_whitespace': key != key.strip(),
              'format': 'unrecognized'}
    if key.startswith('sb_secret_'):
        result['format'] = 'secret_api_key'
    elif key.startswith('sb_publishable_'):
        result['format'] = 'publishable_api_key'
    elif len(key) <= 16384 and len(key.split('.')) == 3:
        try:
            payload = key.split('.')[1]
            claims = json.loads(base64.urlsafe_b64decode(payload + '=' * (-len(payload) % 4)))
            if isinstance(claims, dict):
                result.update(format='jwt', jwt_service_role_claim=claims.get('role') == 'service_role',
                              jwt_project_claim_present='ref' in claims,
                              jwt_project_claim_matches=claims.get('ref') == PRODUCTION_PROJECT)
        except (ValueError, UnicodeError):
            pass
    return result


def api_binding():
    key = os.environ.get('PRODUCTION_SUPABASE_SERVICE_KEY', '')
    diagnostics = key_diagnostics(key)
    try:
        req = urllib.request.Request('https://' + PRODUCTION_PROJECT + '.supabase.co/rest/v1/',
            headers={'apikey': key, 'Authorization': 'Bearer ' + key})
        with urllib.request.urlopen(req, timeout=30) as response:
            if response.status == 200:
                service = (diagnostics['format'] == 'secret_api_key' or
                    (diagnostics['format'] == 'jwt' and diagnostics.get('jwt_service_role_claim') is True
                     and (not diagnostics.get('jwt_project_claim_present') or diagnostics.get('jwt_project_claim_matches') is True)))
                if service:
                    return True
                diagnostics.update(http_status=200, failure='wrong_credential_type_or_scope')
    except urllib.error.HTTPError as error:
        diagnostics.update(http_status=error.code, failure='http_error')
        # Provider response bodies remain private; only known categories escape.
        try:
            body = error.read(4096).decode(errors='replace').lower()
        except Exception:
            body = ''
        for phrase, category in [('invalid api key', 'api_key_rejected'),
                                 ('invalid jwt', 'bearer_token_rejected'),
                                 ('jwt expired', 'bearer_token_expired')]:
            if phrase in body:
                diagnostics['failure'] = category
                break
    except (TimeoutError, urllib.error.URLError):
        diagnostics['failure'] = 'connection_or_timeout'
    except (ValueError, UnicodeError):
        diagnostics['failure'] = 'invalid_header_or_request'
    raise ServiceAPIError(diagnostics)


def pages_binding():
    if os.environ['CLOUDFLARE_ACCOUNT_ID'] != ACCOUNT:
        raise RuntimeError('Unexpected Cloudflare account')
    url = 'https://api.cloudflare.com/client/v4/accounts/' + ACCOUNT + '/pages/projects/packpilot-site'
    value = request_json(url, os.environ['CLOUDFLARE_API_TOKEN'])
    if value.get('success') is not True:
        raise RuntimeError('Pages read access failed')
    page = value['result'].get('canonical_deployment') or {}
    sha = page.get('deployment_trigger', {}).get('metadata', {}).get('commit_hash', '')
    if page.get('latest_stage', {}).get('status') != 'success' or not re.fullmatch('[a-f0-9]{40}', sha):
        raise RuntimeError('Production deployment metadata is invalid')
    return sha


def audit(root, sha, staging_run):
    report = {'candidate': sha, 'production_mutated': False, 'mail_sent': False,
              'checks': [], 'notes': [
                  'Successful read access does not prove provider write permissions.',
                  'A passing audit does not authorize activation or replace recovery/rollback/alert acceptance.']}

    def check(name, operation, category='gate'):
        try:
            ok = operation() is True
            result = {'name': name, 'category': category, 'ok': ok}
        except ServiceAPIError as error:
            result = {'name': name, 'category': category, 'ok': False,
                      'request_failed': True, 'diagnostics': error.diagnostics}
        except Exception:
            # Exceptions can contain database URLs, SQL or provider response bodies.
            result = {'name': name, 'category': category, 'ok': False, 'request_failed': True}
        report['checks'].append(result)
        return result['ok']

    check('database_verified_tls_read_only', database_binding, 'binding')
    check('production_service_api_read', api_binding, 'binding')
    page = {}

    def pages():
        page['commit'] = pages_binding()
        report['production_commit'] = page['commit']
        return True

    check('cloudflare_pages_read', pages, 'binding')
    migrations = {}

    def migration_history():
        migrations.update(plan(PRODUCTION_PROJECT, root))
        report['pending_migrations'] = migrations['pending']
        return True

    check('immutable_migration_history', migration_history, 'binding')

    def staged():
        evidence = staging_evidence(staging_run, sha, root)
        return evidence['migration_digest'] == migrations.get('migration_digest')

    check('unchanged_staging_candidate_and_resulting_schema', staged)

    def maintenance():
        rows = query(PRODUCTION_PROJECT, "begin read only; select to_regprocedure('private.set_release_maintenance(boolean)') is not null as present; commit;")
        return bool(rows and rows[0]['present'])

    check('production_maintenance_installed', maintenance)
    store = {}

    def r2():
        store['client'] = client()
        store['client'].list_objects_v2(Bucket=BUCKET, MaxKeys=1)
        return True

    if check('r2_bucket_read', r2, 'binding'):
        check('fresh_complete_backup_objects_present', lambda: bool(freshness(store['client'])))
        check('accepted_full_recovery_record', lambda: recovery_accepted(store['client']))

        def baseline():
            pointer = object_or_none(store['client'], 'releases/current.json')
            if not pointer or pointer.get('commit') != page.get('commit'):
                return False
            with site_response('https://packpilot.example/release.json') as response:
                return json.load(response).get('commit') == pointer['commit']

        check('production_pointer_and_public_release_match', baseline)
    report['bindings_ok'] = all(c['ok'] for c in report['checks'] if c['category'] == 'binding')
    report['all_audited_gates_ok'] = all(c['ok'] for c in report['checks'])
    report['activation_authorized'] = False
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--candidate-root', required=True)
    parser.add_argument('--commit', required=True)
    parser.add_argument('--staging-run', required=True)
    parser.add_argument('--report', default='production-preflight.json')
    args = parser.parse_args()
    try:
        authorized_source()
        root = candidate(args.candidate_root, args.commit)
        subprocess.run(['git', 'merge-base', '--is-ancestor', args.commit, 'origin/main'], cwd=root, check=True, capture_output=True)
        report = audit(root, args.commit, args.staging_run)
        Path(args.report).write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps(report))
        if not report['bindings_ok']:
            raise SystemExit('Production credential checks failed; inspect the safe report diagnostics')
        print('Read-only audit complete; inspect blocked gates. Production activation remains disabled.')
    except Exception:
        raise SystemExit('Production preflight failed; private exception details withheld')
