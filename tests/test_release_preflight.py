"""Preflight must report missing gates without changing production or leaking errors."""
from contextlib import ExitStack
import base64
import io
import json
import os
from pathlib import Path
import unittest
import urllib.error
from unittest.mock import patch

from botocore.exceptions import ClientError

from test_release_tools import ObjectStore, module

preflight = module('production_preflight_tests', 'production_preflight.py')


class MissingStore(ObjectStore):
    def list_objects_v2(self, **kwargs):
        return {'Contents': [{'Key': key} for key in self.objects][:kwargs['MaxKeys']]}

    def get_object(self, **kwargs):
        if kwargs['Key'] not in self.objects:
            raise ClientError({'Error': {'Code': 'NoSuchKey'}}, 'GetObject')
        return super().get_object(**kwargs)


class PreflightTests(unittest.TestCase):
    def test_public_api_success_is_not_service_role_proof(self):
        payload = base64.urlsafe_b64encode(json.dumps({'role': 'anon', 'ref': preflight.PRODUCTION_PROJECT}).encode()).decode().rstrip('=')
        key = 'header.' + payload + '.signature'
        with patch.dict(os.environ, {'PRODUCTION_SUPABASE_SERVICE_KEY': key}), patch.object(preflight.urllib.request, 'urlopen') as request:
            request.return_value.__enter__.return_value.status = 200
            with self.assertRaises(preflight.ServiceAPIError) as error:
                preflight.api_binding()
            self.assertEqual(error.exception.diagnostics['failure'], 'wrong_credential_type_or_scope')

    def test_api_failure_reports_status_and_safe_format_without_body_or_key(self):
        key = 'sb_secret_credential-must-not-appear'
        error = urllib.error.HTTPError('https://private.example', 401, key,
                                      None, io.BytesIO(('Invalid API key ' + key).encode()))
        with patch.dict(os.environ, {'PRODUCTION_SUPABASE_SERVICE_KEY': key}), \
                patch.object(preflight.urllib.request, 'urlopen', side_effect=error), \
                self.assertRaises(preflight.ServiceAPIError) as raised:
            preflight.api_binding()
        diagnostics = raised.exception.diagnostics
        self.assertEqual(diagnostics['http_status'], 401)
        self.assertEqual(diagnostics['failure'], 'api_key_rejected')
        self.assertEqual(diagnostics['format'], 'secret_api_key')
        self.assertNotIn(key, str(raised.exception) + json.dumps(diagnostics))
        self.assertNotIn('private.example', json.dumps(diagnostics))

    def test_jwt_diagnostics_never_report_arbitrary_claims(self):
        claims = {'role': 'service_role', 'ref': preflight.PRODUCTION_PROJECT, 'private': 'never-report-this'}
        payload = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip('=')
        diagnostics = preflight.key_diagnostics('synthetic.' + payload + '.synthetic')
        self.assertTrue(diagnostics['jwt_service_role_claim'])
        self.assertTrue(diagnostics['jwt_project_claim_matches'])
        self.assertNotIn('never-report-this', json.dumps(diagnostics))
        self.assertTrue(preflight.key_diagnostics(' sb_secret_synthetic\n')['outer_whitespace'])

    def test_audit_keeps_safe_service_diagnostics_and_rejects_credentials(self):
        with ExitStack() as stack:
            self.audit(stack, MissingStore())
            stack.enter_context(patch.object(preflight, 'api_binding',
                side_effect=preflight.ServiceAPIError({'http_status': 401, 'failure': 'api_key_rejected'})))
            report = preflight.audit(Path('.'), 'b' * 40, '1')
            self.assertFalse(report['bindings_ok'])
            result = next(c for c in report['checks'] if c['name'] == 'production_service_api_read')
            self.assertEqual(result['diagnostics']['http_status'], 401)

    def test_owner_main_dispatch_and_exact_controller_are_required(self):
        context = {'GITHUB_ACTIONS': 'true', 'GITHUB_ACTOR': 'YOUR_GITHUB_OWNER',
                   'GITHUB_REPOSITORY': 'YOUR_GITHUB_OWNER/YOUR_GITHUB_REPOSITORY', 'GITHUB_EVENT_NAME': 'workflow_dispatch',
                   'GITHUB_REF': 'refs/heads/main', 'GITHUB_SHA': 'a' * 40}
        with patch.dict(os.environ, context, clear=True), patch.object(preflight.subprocess, 'check_output', return_value='a' * 40):
            preflight.authorized_source()
            for key, wrong in [('GITHUB_ACTOR', 'other'), ('GITHUB_REF', 'refs/heads/feature'),
                               ('GITHUB_SHA', 'b' * 40), ('GITHUB_EVENT_NAME', 'push')]:
                with self.subTest(key=key), patch.dict(os.environ, {key: wrong}), self.assertRaises(RuntimeError):
                    preflight.authorized_source()

    def test_database_and_behavior_only_receipts_cannot_accept_recovery(self):
        store = MissingStore()
        self.assertFalse(preflight.recovery_accepted(store))
        store.objects['activation/verified.json'] = json.dumps({'status': 'verified',
            'recovery_administrator': 'Recovery Administrator', 'restore_rehearsal_key': 'rehearsals/test.json'}).encode()
        for status in ('database-verified', 'behavior-verified', 'verified'):
            store.objects['rehearsals/test.json'] = json.dumps({'status': status}).encode()
            self.assertEqual(preflight.recovery_accepted(store), status == 'verified')

    def test_access_denied_is_not_reported_as_missing_recovery(self):
        error = ClientError({'Error': {'Code': 'AccessDenied'}}, 'GetObject')
        with patch.object(MissingStore, 'get_object', side_effect=error), self.assertRaises(ClientError):
            preflight.recovery_accepted(MissingStore())

    def audit(self, stack, store):
        for name, value in [('database_binding', True), ('api_binding', True),
                            ('pages_binding', 'a' * 40), ('plan', {'pending': [], 'migration_digest': 'test'}),
                            ('staging_evidence', {'migration_digest': 'test'}), ('query', [{'present': False}]),
                            ('freshness', {'validated': True}), ('client', store)]:
            stack.enter_context(patch.object(preflight, name, return_value=value))
        return preflight.audit(Path('.'), 'b' * 40, '1')

    def test_missing_adoption_reports_blockers_and_does_not_mutate_store(self):
        with ExitStack() as stack:
            store = MissingStore()
            store.objects['backups/private-record.json'] = b'private-record-must-not-appear'
            before = store.objects.copy()
            report = self.audit(stack, store)
            self.assertTrue(report['bindings_ok'])
            self.assertFalse(report['all_audited_gates_ok'])
            self.assertFalse(report['activation_authorized'])
            self.assertFalse(report['production_mutated'])
            self.assertFalse(report['mail_sent'])
            self.assertEqual(store.objects, before)
            self.assertNotIn('private-record-must-not-appear', json.dumps(report))

    def test_provider_exception_details_are_not_in_report(self):
        secret = 'provider-body-with-credential'
        with ExitStack() as stack:
            self.audit(stack, MissingStore())
            stack.enter_context(patch.object(preflight, 'database_binding', side_effect=RuntimeError(secret)))
            report = preflight.audit(Path('.'), 'b' * 40, '1')
            self.assertFalse(report['bindings_ok'])
            self.assertNotIn(secret, json.dumps(report))

    def test_public_baseline_must_match_pointer_and_provider(self):
        with ExitStack() as stack:
            store = MissingStore()
            self.audit(stack, store)
            store.objects['releases/current.json'] = json.dumps({'commit': 'a' * 40}).encode()
            stack.enter_context(patch.object(preflight, 'site_response', return_value=io.BytesIO(json.dumps({'commit': 'c' * 40}).encode())))
            report = preflight.audit(Path('.'), 'b' * 40, '1')
            check = next(c for c in report['checks'] if c['name'] == 'production_pointer_and_public_release_match')
            self.assertFalse(check['ok'])


if __name__ == '__main__':
    unittest.main()
