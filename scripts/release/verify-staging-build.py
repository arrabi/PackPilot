"""Verify generated staging pages and reject production backend references."""
from pathlib import Path

root = Path('auth-ui/dist')
for name in ['index.html', 'parents.html', 'consent.html', 'prev/index.html']:
    html = (root / name).read_text()
    for marker in ['STAGING — Production copy · Test emails only', '[STAGING]', '/staging.svg']:
        if marker not in html:
            raise SystemExit('Missing staging identity in ' + name)
for path in root.rglob('*.js'):
    if 'https://aaaaaaaaaaaaaaaaaaaa.supabase.co' in path.read_text():
        raise SystemExit('Production backend reference in ' + str(path))
print('Staging page identity and backend isolation verified')
