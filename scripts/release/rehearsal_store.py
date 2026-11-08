"""Keep rehearsal operation metadata away from production pointers and acceptance.

Real production recovery points retain the ordinary bounded backup policy. Their
rehearsal pins live at root so normal cleanup can honor and later release them.
"""
import re


class RehearsalStore:
    def __init__(self, root, identity):
        if not re.fullmatch('[a-f0-9]{32}', identity):
            raise RuntimeError('Invalid rehearsal identity')
        self.root = root
        self.identity = identity
        self.prefix = 'rehearsals/releases/' + identity + '/'

    def key(self, key):
        if '..' in key.split('/') or key.startswith('/'):
            raise RuntimeError('Unsafe rehearsal object key')
        if key.startswith('pins/release-') and re.fullmatch('pins/release-[a-f0-9]{32}(?:-attempt-[0-9]+)?\\.json', key):
            return 'pins/rehearsal-' + self.identity + '-' + key.removeprefix('pins/')
        if not key.startswith(('operations/', 'releases/')):
            raise RuntimeError('Rehearsal metadata cannot access this object scope')
        return self.prefix + key

    def put_object(self, **kwargs):
        return self.root.put_object(**(kwargs | {'Key': self.key(kwargs['Key'])}))

    def get_object(self, **kwargs):
        return self.root.get_object(**(kwargs | {'Key': self.key(kwargs['Key'])}))

    def delete_object(self, **kwargs):
        if not kwargs['Key'].startswith('pins/'):
            raise RuntimeError('Rehearsal deletion is restricted to its own pins')
        return self.root.delete_object(**(kwargs | {'Key': self.key(kwargs['Key'])}))

    def upload_file(self, filename, bucket, key, **kwargs):
        return self.root.upload_file(filename, bucket, self.key(key), **kwargs)

    def download_file(self, bucket, key, filename):
        return self.root.download_file(bucket, self.key(key), filename)
