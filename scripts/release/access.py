"""Read-only release access checks. Never log credentials or API response bodies."""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request

PRODUCTION_PROJECT = 'aaaaaaaaaaaaaaaaaaaa'


def management_token():
    # The renamed binding wins. Do not replace inherited proxy configuration.
    token = os.environ.get('SUPABASE_ACCESS_KEY') or os.environ.get('SUPABASE_ACCESS_TOKEN')
    if not token:
        raise RuntimeError('Missing SUPABASE_ACCESS_KEY or SUPABASE_ACCESS_TOKEN binding')
    return token


def request_json(url, token, *, method='GET', data=None):
    headers = {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'}
    request = urllib.request.Request(url, headers=headers, method=method,
                                    data=None if data is None else json.dumps(data).encode())
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def check(name, url, token, validate=lambda value: True):
    if not token:
        return {'check': name, 'ok': False, 'reason': 'credential binding missing'}
    try:
        data = request_json(url, token)
        if not validate(data):
            return {'check': name, 'ok': False, 'reason': 'API response failed validation'}
        return {'check': name, 'ok': True}
    except urllib.error.HTTPError as error:
        result = {'check': name, 'ok': False, 'http_status': error.code}
        # Only documented permission identifiers may cross the reporting boundary.
        try:
            body = json.load(error)
            permissions = body.get('error', {}).get('missing_permissions', [])
            result['missing_permissions'] = [p for p in permissions
                                             if isinstance(p, str) and p.replace('_', '').isalnum()]
        except (ValueError, AttributeError, TypeError):
            pass
        return result
    except (urllib.error.URLError, TimeoutError):
        return {'check': name, 'ok': False, 'reason': 'connection failed; inspect network permission and proxy policy'}


def run():
    account = os.environ.get('CLOUDFLARE_ACCOUNT_ID', '')
    cf_token = os.environ.get('CLOUDFLARE_API_TOKEN')
    sb_token = os.environ.get('SUPABASE_ACCESS_KEY') or os.environ.get('SUPABASE_ACCESS_TOKEN')
    checks = [check('supabase-production-project',
                    'https://api.supabase.com/v1/projects/' + PRODUCTION_PROJECT, sb_token,
                    lambda d: d.get('id') == PRODUCTION_PROJECT)]
    if account and account.isalnum():
        base = 'https://api.cloudflare.com/client/v4/accounts/' + account
        for name, path in [('cloudflare-pages', '/pages/projects'), ('cloudflare-r2', '/r2/buckets')]:
            checks.append(check(name, base + path, cf_token, lambda d: d.get('success') is True))
    else:
        checks.append({'check': 'cloudflare-account', 'ok': False, 'reason': 'account binding missing or invalid'})
    return {'new_supabase_binding_present': bool(os.environ.get('SUPABASE_ACCESS_KEY')), 'checks': checks}


if __name__ == '__main__':
    argparse.ArgumentParser(description=__doc__).parse_args()
    result = run()
    print(json.dumps(result, indent=2))
    sys.exit(0 if all(c['ok'] for c in result['checks']) else 1)
