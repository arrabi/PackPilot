"""Small management API client. Error messages contain no bodies or credentials."""
import json
import os
import re
import urllib.error
import urllib.request
from access import management_token, PRODUCTION_PROJECT


class APIError(RuntimeError):
    pass


def project_ref(value, *, staging=False):
    if not re.fullmatch(r'[a-z]{20}', value or ''):
        raise RuntimeError('Invalid Supabase project reference')
    if staging and value == PRODUCTION_PROJECT:
        raise RuntimeError('Staging cannot target production')
    return value


def supabase(path, *, method='GET', data=None, raw=None, content_type='application/json', return_bytes=False):
    if not path.startswith('/v1/'):
        raise RuntimeError('Invalid management API path')
    body = raw if raw is not None else None if data is None else json.dumps(data).encode()
    request = urllib.request.Request('https://api.supabase.com' + path, data=body,
        method=method, headers={'Authorization': 'Bearer ' + management_token(), 'Content-Type': content_type})
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            value = response.read()
            if return_bytes:
                return value
            return json.loads(value) if value else None
    except urllib.error.HTTPError as error:
        permissions = []
        try:
            permissions = json.load(error).get('error', {}).get('missing_permissions', [])
            permissions = [p for p in permissions if isinstance(p, str) and re.fullmatch('[a-z_]+', p)]
        except (ValueError, AttributeError):
            pass
        raise APIError('Supabase HTTP %s%s' % (error.code, ': ' + ', '.join(permissions) if permissions else '')) from None


def query(project, sql):
    project_ref(project)
    return supabase('/v1/projects/' + project + '/database/query', method='POST', data={'query': sql})


def private_json(path, value):
    """Never print the value. Use only ignored administrator state, not Git."""
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, 'w') as output:
        json.dump(value, output)
