import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts/release'))
from workflow_context import owner_pr_snapshot


class WorkflowContextTests(unittest.TestCase):
    def test_staging_requires_its_own_owner_label_and_exact_candidate(self):
        sha = 'a' * 40
        event = {'action': 'labeled', 'label': {'name': 'rehearse-staging'}, 'sender': {'login': 'YOUR_GITHUB_OWNER'},
            'pull_request': {'head': {'sha': sha, 'repo': {'full_name': 'YOUR_GITHUB_OWNER/YOUR_GITHUB_REPOSITORY'}}, 'base': {'ref': 'main'}}}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'event.json'
            env = {'GITHUB_ACTIONS': 'true', 'GITHUB_EVENT_NAME': 'pull_request', 'GITHUB_ACTOR': 'YOUR_GITHUB_OWNER',
                'GITHUB_REPOSITORY': 'YOUR_GITHUB_OWNER/YOUR_GITHUB_REPOSITORY', 'GITHUB_EVENT_PATH': str(path)}
            path.write_text(json.dumps(event))
            with patch.dict(os.environ, env, clear=True), patch('workflow_context.subprocess.check_output', return_value=sha):
                self.assertEqual(owner_pr_snapshot(Path('.'), 'rehearse-staging', sha), sha)
                with self.assertRaises(RuntimeError):
                    owner_pr_snapshot(Path('.'), 'rehearse-staging', 'b' * 40)
                with self.assertRaises(RuntimeError):
                    owner_pr_snapshot(Path('.'), 'rehearse-backup', sha)
                event['action'] = 'synchronize'
                path.write_text(json.dumps(event))
                with self.assertRaises(RuntimeError):
                    owner_pr_snapshot(Path('.'), 'rehearse-staging', sha)


if __name__ == '__main__':
    unittest.main()
