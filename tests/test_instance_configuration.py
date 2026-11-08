"""Exercise the offline first-install configurator in a disposable checkout."""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class InstanceConfigurationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'scripts').mkdir()
        (self.root / 'config').mkdir()
        (self.root / '.local').mkdir()
        shutil.copy(ROOT / 'scripts/configure-instance.py', self.root / 'scripts/configure-instance.py')
        shutil.copy(ROOT / 'config/instance.example.json', self.root / 'config/instance.example.json')
        self.chosen = json.loads((self.root / 'config/instance.example.json').read_text())
        self.chosen.update(production_project='c' * 20, staging_project='d' * 20,
            production_origin='https://packpilot-staging.example.test', staging_origin='https://stage.example.test',
            legacy_origin='https://legacy.example.test', cloudflare_account_id='1' * 32,
            github_owner='example-owner', github_repository='example-repo',
            production_pages='example-live', staging_pages='example-stage',
            admin_email='owner@example.test', staging_email='test@example.test',
            recovery_email='restore@example.test', contact_email='help@example.test',
            national_registration_url='https://registration.example.test/national',
            pack_registration_url='https://registration.example.test/pack',
            registration_guide_url='https://registration.example.test/guide',
            skills_survey_url='https://registration.example.test/survey')
        self.settings = self.root / '.local/instance.json'
        self.settings.write_text(json.dumps(self.chosen))
        self.sample = self.root / 'sample.sql'
        self.original = 'https://packpilot.example admin@example.test aaaaaaaaaaaaaaaaaaaa'
        self.sample.write_text(self.original)

    def run_tool(self, *args):
        return subprocess.run([sys.executable, str(self.root / 'scripts/configure-instance.py'),
            str(self.settings), *args], capture_output=True, text=True)

    def test_preview_is_offline_and_does_not_change_files(self):
        result = self.run_tool()
        self.assertEqual(result.returncode, 0)
        self.assertEqual(json.loads(result.stdout), {'files': 1, 'applied': False, 'provider_requests': 0})
        self.assertEqual(self.sample.read_text(), self.original)
        self.assertFalse((self.root / '.local/configured-instance.json').exists())

    def test_apply_preserves_inserted_values_and_skips_private_files(self):
        private = self.root / '.local/private.sql'
        private.write_text(self.original)
        result = self.run_tool('--apply')
        self.assertEqual(result.returncode, 0)
        self.assertEqual(self.sample.read_text(), 'https://packpilot-staging.example.test owner@example.test ' + 'c' * 20)
        self.assertEqual(private.read_text(), self.original)
        self.assertEqual(self.run_tool('--apply').returncode, 0)
        self.chosen['admin_email'] = 'different@example.test'
        self.settings.write_text(json.dumps(self.chosen))
        self.assertNotEqual(self.run_tool('--apply').returncode, 0)

    def test_crossed_projects_are_rejected_before_mutation(self):
        self.chosen['staging_project'] = self.chosen['production_project']
        self.settings.write_text(json.dumps(self.chosen))
        self.assertNotEqual(self.run_tool('--apply').returncode, 0)
        self.assertEqual(self.sample.read_text(), self.original)

    def test_unknown_secret_field_is_rejected_without_printing_it(self):
        self.chosen['password'] = 'synthetic-do-not-print'
        self.settings.write_text(json.dumps(self.chosen))
        result = self.run_tool('--apply')
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn(self.chosen['password'], result.stdout + result.stderr)
        self.assertEqual(self.sample.read_text(), self.original)
