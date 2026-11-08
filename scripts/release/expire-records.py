"""Expire verified operation records/artifacts after one year under the release lock.

Keep current/previous rollback operations, all incomplete operations, recovery
pins and accepted activation/rehearsal evidence. Unknown layouts fail closed.
"""
import argparse
from datetime import timedelta
import json
import re
from backup import BUCKET, client, manifests, now
from retention import parse_time


def objects(s3, prefix):
    return [item['Key'] for page in s3.get_paginator('list_objects_v2').paginate(Bucket=BUCKET, Prefix=prefix)
            for item in page.get('Contents', [])]


def expire(s3):
    # No baseline means no deletion: bootstrap must establish verified metadata.
    try:
        response = s3.get_object(Bucket=BUCKET, Key='releases/current.json')
    except Exception as error:
        if isinstance(error, KeyError) or getattr(error, 'response', {}).get('Error', {}).get('Code') == 'NoSuchKey':
            return []
        raise
    current = json.loads(response['Body'].read())
    protected = {current.get('operation_key'), current.get('previous_operation_key')}
    commits = {current['commit'], current.get('previous_commit')}
    for key in objects(s3, 'pins/'):
        pin = json.loads(s3.get_object(Bucket=BUCKET, Key=key)['Body'].read())
        if pin.get('operation'):
            protected.add('operations/' + pin['operation'] + '.json')
    cutoff = now() - timedelta(days=365)
    removed = []
    for key in objects(s3, 'operations/'):
        match = re.fullmatch(r'operations/([a-f0-9]{32})\.json', key)
        if not match:
            raise RuntimeError('Unknown operation record layout; inspect before expiry')
        value = json.loads(s3.get_object(Bucket=BUCKET, Key=key)['Body'].read())
        if value.get('id') != match[1]:
            raise RuntimeError('Operation record identity mismatch')
        if (key in protected or value.get('commit') in commits or value.get('status') != 'verified'
                or parse_time(value['finished_at']) > cutoff):
            continue
        prefix = 'releases/' + match[1] + '/'
        # Remove deployable marker first. An interrupted cleanup can be retried
        # from the operation record; incomplete/orphaned archives stay untouched.
        s3.delete_object(Bucket=BUCKET, Key=prefix + 'manifest.json')
        for artifact in objects(s3, prefix):
            s3.delete_object(Bucket=BUCKET, Key=artifact)
        s3.delete_object(Bucket=BUCKET, Key=key)
        removed.append(match[1])
    retained_backups = {value['id'] for value in manifests(s3)}
    for key in objects(s3, 'records/backups/'):
        match = re.fullmatch(r'records/backups/([A-Za-z0-9-]+)\.json', key)
        if not match:
            raise RuntimeError('Unknown backup record layout')
        value = json.loads(s3.get_object(Bucket=BUCKET, Key=key)['Body'].read())
        if value.get('id') != match[1]:
            raise RuntimeError('Backup record identity mismatch')
        if value['id'] not in retained_backups and parse_time(value['completed_at']) < cutoff:
            s3.delete_object(Bucket=BUCKET, Key=key)
    return removed


if __name__ == '__main__':
    argparse.ArgumentParser(description=__doc__).parse_args()
    try:
        removed = expire(client())
        print('Expired verified operation records: ' + str(len(removed)))
    except Exception:
        raise SystemExit('Record expiry incomplete; current/previous releases and incomplete operations retained')
