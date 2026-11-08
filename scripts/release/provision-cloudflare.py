"""Provision only isolated staging Pages and private Standard backup storage."""
import argparse
import os
from access import request_json

PAGES = 'packpilot-staging'
BUCKET = 'packpilot-production-backups'


def provision(apply=False):
    account = os.environ['CLOUDFLARE_ACCOUNT_ID']
    if not account.isalnum():
        raise RuntimeError('Invalid account identifier')
    base = 'https://api.cloudflare.com/client/v4/accounts/' + account
    token = os.environ['CLOUDFLARE_API_TOKEN']

    def api(path, **kwargs):
        result = request_json(base + path, token, **kwargs)
        if result.get('success') is not True:
            raise RuntimeError('Cloudflare API rejected operation; no credential or response body logged')
        return result['result']

    pages = api('/pages/projects')
    project = next((p for p in pages if p['name'] == PAGES), None)
    if project is None:
        print(('Create' if apply else 'Would create') + ' isolated Pages project ' + PAGES)
        if apply:
            project = api('/pages/projects', method='POST', data={'name': PAGES, 'production_branch': 'main'})
    elif project.get('production_branch') != 'main':
        raise RuntimeError('Existing staging project has unexpected branch; inspect before changing')
    else:
        print('Staging Pages project already exists; no build uploaded')

    # Inspect named bucket directly; never alter any other bucket or Pages project.
    buckets = api('/r2/buckets')['buckets']
    bucket = next((b for b in buckets if b['name'] == BUCKET), None)
    if bucket is None:
        print(('Create' if apply else 'Would create') + ' private Standard bucket ' + BUCKET)
        if apply:
            api('/r2/buckets', method='POST', data={'name': BUCKET, 'storageClass': 'Standard'})
    if bucket is not None or apply:
        settings = api('/r2/buckets/' + BUCKET + '/domains/managed')
        custom = api('/r2/buckets/' + BUCKET + '/domains/custom')
        if settings.get('enabled') or custom.get('domains'):
            raise RuntimeError('Backup bucket has public domains; disable public access before use')
        details = api('/r2/buckets/' + BUCKET)
        if details.get('storageClass') != 'Standard':
            raise RuntimeError('Backup bucket must use Standard storage')
        print('Verified Standard storage and no public domains')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    provision(parser.parse_args().apply)
