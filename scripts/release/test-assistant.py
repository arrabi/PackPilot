"""Run an explicitly selected assistant deployment against the real model with fixed fictional records.

The administrative credential stays in memory and is sent only to the fixed
selected project. No application data, leader sessions or notifications are used.
"""
import argparse
import json
import urllib.request
import urllib.error
from platform_api import supabase

STAGING = 'bbbbbbbbbbbbbbbbbbbb'
PROJECTS = {'staging': STAGING, 'production': 'aaaaaaaaaaaaaaaaaaaa'}


def staging_admin_key(keys):
    # Modern projects bind the default server secret to the reserved Edge
    # SUPABASE_SERVICE_ROLE_KEY variable. Older projects still bind the JWT.
    modern = next((key['api_key'] for key in keys if key.get('type') == 'secret'), None)
    legacy = next((key['api_key'] for key in keys if key.get('name') == 'service_role'), None)
    if not (modern or legacy):
        raise RuntimeError('The project administrative key is unavailable')
    return modern or legacy


def verify(environment='staging'):
    project = PROJECTS[environment]
    keys = supabase('/v1/projects/' + project + '/api-keys?reveal=true')
    service = staging_admin_key(keys)
    endpoint = 'https://' + project + '.supabase.co/functions/v1/fieldbook-assistant/self-test'
    candidates = [service] + [key['api_key'] for key in keys if key.get('name') == 'service_role' and key['api_key'] != service]
    for scenario in ('provider', 'count', 'bobcat'):
        for candidate in [service] + [key for key in candidates if key != service]:
            request = urllib.request.Request(endpoint, method='POST',
                headers={'Authorization': 'Bearer ' + candidate, 'Content-Type': 'application/json'},
                data=json.dumps({'scenario': scenario}).encode())
            try:
                response = urllib.request.urlopen(request, timeout=115)
            except urllib.error.HTTPError as error:
                response = error
            value = json.load(response)
            if response.status != 401:
                service = candidate
                break
        if value.get('skipped'):
            print('Assistant live test skipped: OPENAI_API_KEY is not configured')
            if environment == 'production':
                raise RuntimeError('Production assistant key is not configured')
            return
        # The response contains only the fixture's fictional records and safe
        # tool names/validation paths, never provider keys or real user inputs.
        print(json.dumps(value, ensure_ascii=False))
        if response.status != 200 or not value.get('passed'):
            raise RuntimeError(environment + ' assistant live-model test failed: ' + scenario)
    print(environment + ' assistant live-model provider, count and Bobcat tests passed')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--environment', choices=PROJECTS, default='staging')
    verify(parser.parse_args().environment)
