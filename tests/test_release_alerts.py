import json
import os
import unittest
from unittest.mock import patch
import io

from test_release_tools import module
from backup import alert

alerts = module('rehearse_alerts', 'rehearse-alerts.py')


class AlertTests(unittest.TestCase):
    def test_dry_run_never_sends_and_detects_missing_and_stale_backups(self):
        with patch.object(alerts, 'alert') as send:
            result = alerts.rehearse()
        send.assert_not_called()
        self.assertFalse(result['backup_objects_changed'])
        self.assertEqual([r['scenario'] for r in result['results']], ['missing', 'stale', 'release-failure'])
        self.assertTrue(all(not r['provider_accepted'] for r in result['results']))

    def test_authorized_tests_are_labeled_and_provider_failure_is_not_success(self):
        with patch.object(alerts, 'alert') as send:
            result = alerts.rehearse(send=True)
            self.assertEqual(send.call_count, 3)
            self.assertTrue(all(c.kwargs['subject'].startswith('PackPilot PLANNED TEST: ') for c in send.call_args_list))
            self.assertTrue(all(r['provider_accepted'] for r in result['results']))
        with patch.object(alerts, 'alert', side_effect=RuntimeError('provider failure')), self.assertRaises(RuntimeError):
            alerts.rehearse(send=True)

    def test_test_alerts_keep_the_two_admin_recipients_and_require_delivery_reference(self):
        with patch.dict(os.environ, {'BREVO_API_KEY': 'synthetic', 'PACK99_FROM_EMAIL': 'admin@example.test'}), \
                patch('backup.urllib.request.urlopen', return_value=io.BytesIO(b'{"messageId":"synthetic"}')) as request:
            alert('PLANNED TEST', subject='PackPilot PLANNED TEST: missing backup')
            body = json.loads(request.call_args.args[0].data)
            self.assertEqual(body['to'], [{'email': 'admin@example.test'}, {'email': 'recovery@example.test'}])
            self.assertIn('PLANNED TEST', body['subject'])
            request.return_value = io.BytesIO(b'{}')
            with self.assertRaises(RuntimeError):
                alert('PLANNED TEST')
