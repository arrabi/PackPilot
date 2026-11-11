import importlib.util
import contextlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts/release'))
import backend

spec = importlib.util.spec_from_file_location('assistant_retention', ROOT / 'scripts/release/prune-assistant.py')
retention = importlib.util.module_from_spec(spec)
spec.loader.exec_module(retention)
probe_spec = importlib.util.spec_from_file_location('assistant_probe', ROOT / 'scripts/release/test-assistant.py')
probe = importlib.util.module_from_spec(probe_spec)
probe_spec.loader.exec_module(probe)


class Connection:
    def __init__(self, ready=True, paused=False):
        self.ready, self.paused, self.sql = ready, paused, []

    def execute(self, sql):
        self.sql.append(sql)
        return self

    def fetchone(self):
        return (self.ready if 'to_regclass' in self.sql[-1] else self.paused,)


class AssistantReleaseTests(unittest.TestCase):
    def test_retention_skips_pre_assistant_and_maintenance_versions(self):
        for ready, paused in [(False, False), (True, True), (True, None)]:
            connection = Connection(ready, paused)
            self.assertFalse(retention.prune(connection))
            self.assertFalse(any('delete from' in sql for sql in connection.sql))
        connection = Connection()
        self.assertTrue(retention.prune(connection))
        self.assertIn('private.pack_assistant_proposals', connection.sql[-1])
        self.assertIn('private.pack_assistant_usage', connection.sql[-1])
        self.assertNotIn('public.', connection.sql[-1])

    def deployment(self, assistant):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        if assistant:
            entry = root / 'supabase/functions/fieldbook-assistant/index.ts'
            entry.parent.mkdir(parents=True)
            entry.write_text('// synthetic entry')
        calls = []
        def api(path, **kwargs):
            calls.append((path, kwargs.get('method', 'GET')))
            if path.endswith('/functions'):
                return [{'slug': 'fieldbook-assistant'}, {'slug': 'parent-notifications'}]
            if kwargs.get('method') == 'DELETE':
                return None
            return {'status': 'ACTIVE', 'verify_jwt': False, 'version': 1}
        def bundle(_root, slug, destination):
            Path(destination).write_text('synthetic-' + slug)
        archived = []
        with patch.object(backend, 'supabase', side_effect=api), patch.object(backend, 'bundle', side_effect=bundle):
            result = backend.deploy_functions('aaaaaaaaaaaaaaaaaaaa', root, archive=lambda slug, code: archived.append(slug))
        return calls, result, archived

    def test_production_includes_and_archives_assistant_without_staging_auth(self):
        calls, result, archived = self.deployment(True)
        self.assertEqual({item['slug'] for item in result}, set(backend.SLUGS) | {'fieldbook-assistant'})
        self.assertIn('fieldbook-assistant', archived)
        self.assertFalse(any('staging-auth-email' in path or method == 'DELETE' for path, method in calls))

    def test_old_rollback_source_removes_only_the_absent_assistant_endpoint(self):
        calls, result, archived = self.deployment(False)
        self.assertEqual({item['slug'] for item in result}, set(backend.SLUGS))
        self.assertEqual([path for path, method in calls if method == 'DELETE'], ['/v1/projects/aaaaaaaaaaaaaaaaaaaa/functions/fieldbook-assistant'])
        self.assertNotIn('fieldbook-assistant', archived)


class AssistantProbeTests(unittest.TestCase):
    def test_production_probe_uses_only_production_keys_and_legacy_fallback_on_endpoint_401(self):
        keys = [{'type': 'secret', 'api_key': 'synthetic-modern'}, {'name': 'service_role', 'api_key': 'synthetic-legacy'}]
        requests = []
        def send(request, **kwargs):
            requests.append(request)
            rejected = request.get_header('Authorization') == 'Bearer synthetic-modern'
            response = io.BytesIO(json.dumps({'configured': True, 'passed': not rejected}).encode())
            response.status = 401 if rejected else 200
            return response
        output = io.StringIO()
        with patch.object(probe, 'supabase', return_value=keys) as api, patch.object(probe.urllib.request, 'urlopen', side_effect=send), contextlib.redirect_stdout(output):
            probe.verify('production')
        api.assert_called_once_with('/v1/projects/aaaaaaaaaaaaaaaaaaaa/api-keys?reveal=true')
        self.assertEqual(len(requests), 4)
        self.assertTrue(all(r.full_url.startswith('https://aaaaaaaaaaaaaaaaaaaa.supabase.co/') for r in requests))
        self.assertEqual([r.get_header('Authorization') for r in requests], ['Bearer synthetic-modern'] + ['Bearer synthetic-legacy'] * 3)
        self.assertNotIn('synthetic-modern', output.getvalue())
        self.assertNotIn('synthetic-legacy', output.getvalue())

    def test_provider_auth_failure_does_not_try_a_different_project_admin_key(self):
        response = io.BytesIO(json.dumps({'configured': True, 'passed': False, 'provider': {'status': 401}}).encode())
        response.status = 502
        with patch.object(probe, 'supabase', return_value=[{'type': 'secret', 'api_key': 'synthetic-modern'}, {'name': 'service_role', 'api_key': 'synthetic-legacy'}]), patch.object(probe.urllib.request, 'urlopen', return_value=response) as send, contextlib.redirect_stdout(io.StringIO()), self.assertRaises(RuntimeError):
            probe.verify('production')
        self.assertEqual(send.call_count, 1)
