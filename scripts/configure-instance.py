"""Preview/apply non-secret template values before a new instance's first migration.

Offline only. Never installs providers or rewrites an already configured instance.
"""
import argparse
import json
from pathlib import Path
import re
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]


def configuration(path):
    defaults = json.loads((ROOT / 'config/instance.example.json').read_text())
    chosen = json.loads(path.read_text())
    if set(chosen) != set(defaults) or not all(isinstance(v, str) for v in chosen.values()):
        raise ValueError('Use exactly the non-secret fields from config/instance.example.json')
    for field in ('production_project', 'staging_project'):
        if not re.fullmatch('[a-z]{20}', chosen[field]) or chosen[field] == defaults[field]:
            raise ValueError('Supply your own 20-letter Supabase project references')
    if chosen['production_project'] == chosen['staging_project']:
        raise ValueError('Production and staging must use separate Supabase projects')
    for field in ('production_origin', 'staging_origin', 'legacy_origin'):
        value = urlsplit(chosen[field])
        if (value.scheme != 'https' or not value.hostname or value.username or value.password
                or value.path or value.query or value.fragment or chosen[field] == defaults[field]):
            raise ValueError('Supply exact HTTPS origins without paths or trailing slashes')
    if chosen['production_origin'] == chosen['staging_origin']:
        raise ValueError('Production and staging must use separate origins')
    for field in ('national_registration_url', 'pack_registration_url', 'registration_guide_url', 'skills_survey_url'):
        value = urlsplit(chosen[field])
        if (value.scheme != 'https' or not value.hostname or value.username or value.password
                or chosen[field] == defaults[field] or any(c.isspace() for c in chosen[field])):
            raise ValueError('Supply your own HTTPS registration, guide and survey links')
    if not re.fullmatch('[a-f0-9]{32}', chosen['cloudflare_account_id']) or chosen['cloudflare_account_id'] == defaults['cloudflare_account_id']:
        raise ValueError('Supply your own Cloudflare account ID')
    if not re.fullmatch('[A-Za-z0-9-]{1,39}', chosen['github_owner']):
        raise ValueError('Supply your GitHub owner login')
    if not re.fullmatch('[A-Za-z0-9_.-]{1,100}', chosen['github_repository']) or chosen['github_repository'] == defaults['github_repository']:
        raise ValueError('Supply your GitHub repository name')
    for field in ('production_pages', 'staging_pages'):
        if not re.fullmatch('[a-z0-9-]{1,58}', chosen[field]):
            raise ValueError('Pages names must contain lowercase letters, digits or hyphens')
    if chosen['production_pages'] == chosen['staging_pages']:
        raise ValueError('Use separate Pages projects')
    for field in ('admin_email', 'staging_email', 'recovery_email', 'contact_email'):
        if (not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', chosen[field])
                or chosen[field] != chosen[field].lower() or chosen[field] == defaults[field]):
            raise ValueError('Supply lowercase administrator, test, recovery and contact addresses you control')
    if len(set(defaults.values())) != len(defaults):
        raise ValueError('Template fields must have distinct replacement values')
    return defaults, chosen


def prepare(defaults, chosen):
    substitutions = sorted(((old, chosen[key]) for key, old in defaults.items()), key=lambda pair: len(pair[0]), reverse=True)
    changes = []
    for path in ROOT.rglob('*'):
        if not path.is_file() or path.is_symlink():
            continue
        relative = path.relative_to(ROOT)
        if any(part in ('.git', '.local', 'node_modules', 'dist', '__pycache__', '.wrangler') for part in relative.parts):
            continue
        if relative.as_posix() == 'config/instance.example.json':
            continue
        try:
            original = path.read_text()
        except (UnicodeError, OSError):
            continue
        updated = original
        # One pass avoids applying a later replacement to newly inserted values.
        mapping = dict(substitutions)
        expression = re.compile('|'.join(re.escape(old) for old, new in substitutions))
        updated = expression.sub(lambda match: mapping[match.group()], updated)
        if updated != original:
            changes.append((path, updated))
    return changes


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('settings', type=Path)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    try:
        defaults, chosen = configuration(args.settings)
        stamp = ROOT / '.local/configured-instance.json'
        if stamp.exists():
            if json.loads(stamp.read_text()) != chosen:
                raise ValueError('This instance was already configured; do not rewrite applied migration source')
            print('Instance already configured; no files changed')
        else:
            changes = prepare(defaults, chosen)
            if args.apply:
                for path, content in changes:
                    path.write_text(content)
                stamp.parent.mkdir(parents=True, exist_ok=True)
                stamp.write_text(json.dumps(chosen, indent=2) + '\n')
            print(json.dumps({'files': len(changes), 'applied': args.apply, 'provider_requests': 0}))
    except (ValueError, OSError):
        raise SystemExit('Configuration rejected. Review non-secret values and use a fresh copy before first migration; no provider request was made.')
