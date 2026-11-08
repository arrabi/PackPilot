"""Exact same-repository owner approval for pre-merge rehearsals only."""
import json
import os
from pathlib import Path
import re
import subprocess


def owner_pr_snapshot(root, label, expected_sha=None):
    if (label not in ('rehearse-backup', 'rehearse-staging')
            or os.environ.get('GITHUB_ACTIONS') != 'true'
            or os.environ.get('GITHUB_EVENT_NAME') != 'pull_request'
            or os.environ.get('GITHUB_ACTOR') != 'YOUR_GITHUB_OWNER'
            or os.environ.get('GITHUB_REPOSITORY') != 'YOUR_GITHUB_OWNER/YOUR_GITHUB_REPOSITORY'):
        raise RuntimeError('Rehearsal requires an owner-approved same-repository PR')
    event = json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_text())
    pr = event.get('pull_request', {})
    if (event.get('action') != 'labeled' or event.get('label', {}).get('name') != label
            or event.get('sender', {}).get('login') != 'YOUR_GITHUB_OWNER'
            or pr.get('head', {}).get('repo', {}).get('full_name') != 'YOUR_GITHUB_OWNER/YOUR_GITHUB_REPOSITORY'
            or pr.get('base', {}).get('ref') != 'main'):
        raise RuntimeError('Rehearsal requires a fresh matching owner label on a PR to main')
    sha = pr.get('head', {}).get('sha', '')
    actual = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
    if (not re.fullmatch('[a-f0-9]{40}', sha) or actual != sha
            or (expected_sha is not None and expected_sha != sha)):
        raise RuntimeError('Rehearsal source differs from the exact owner-approved snapshot')
    return sha
