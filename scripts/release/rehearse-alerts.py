"""Owner-authorized operational test mail; all backup failures are in memory."""
import argparse
import json
from pathlib import Path

from access import PRODUCTION_PROJECT
from backup import alert, freshness
from production_preflight import authorized_source


class SyntheticReadOnlyStore:
    """Implements only reads of a missing or stale synthetic manifest."""
    def __init__(self, scenario):
        self.scenario = scenario

    def get_paginator(self, operation):
        if operation != 'list_objects_v2':
            raise RuntimeError('Unexpected synthetic read')
        return self

    def paginate(self, **kwargs):
        yield {'Contents': [] if self.scenario == 'missing' else [
            {'Key': 'backups/planned-test/manifest.json'}]}

    def get_object(self, **kwargs):
        import io
        return {'Body': io.BytesIO(json.dumps({'id': 'planned-test',
            'prefix': 'backups/planned-test', 'project': PRODUCTION_PROJECT,
            'status': 'complete', 'validated': True,
            'captured_at': '2000-01-01T00:00:00Z', 'objects': []}).encode())}


def rehearse(*, send=False):
    results = []
    for scenario in ('missing', 'stale', 'release-failure'):
        if scenario != 'release-failure':
            try:
                freshness(SyntheticReadOnlyStore(scenario))
            except RuntimeError:
                pass
            else:
                raise RuntimeError('Synthetic backup failure was not detected')
        label = {'missing': 'missing backup', 'stale': 'stale backup',
                 'release-failure': 'release failure'}[scenario]
        if send:
            alert('PLANNED RELEASE READINESS TEST: ' + label + '. '
                'This condition was simulated. No production failure was induced, '
                'no backups were changed, and no parent emails were sent. '
                'Please confirm receipt of all three labeled test alerts with the owner.',
                subject='PackPilot PLANNED TEST: ' + label)
        results.append({'scenario': scenario, 'failure_simulated': True,
                        'provider_accepted': send})
    return {'production_mutated': False, 'backup_objects_changed': False,
            'scope': 'controlled failure detection and real provider alert delivery; not an integrated deployment-failure rehearsal',
            'results': results}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--send-authorized-test-alerts', action='store_true')
    args = parser.parse_args()
    try:
        authorized_source()
        result = rehearse(send=args.send_authorized_test_alerts)
        Path('alert-rehearsal.json').write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps(result))
    except Exception:
        raise SystemExit('Operational alert rehearsal incomplete; private exception details withheld; do not assume both inboxes received all tests')
