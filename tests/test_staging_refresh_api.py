import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts/release'))
import staging_refresh_api as api

spec = importlib.util.spec_from_file_location('refresh', ROOT / 'scripts/release/refresh-staging.py')
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)


class RefreshBoundaryTests(unittest.TestCase):
    def snapshot(self):
        return {'project': api.PRODUCTION_PROJECT, 'postgres_major': 17, 'public_tables': sorted(policy.PUBLIC),
            'storage_objects': 0, 'actors': [], 'tables': {
                **{'public.' + name: [] for name in policy.PUBLIC - {'leader_access'}},
                **{'private.' + name: [] for name in policy.PRIVATE}}}

    def test_new_tables_files_and_auth_material_cannot_enter_refresh(self):
        for change in (lambda s: s['public_tables'].append('new_unreviewed_table'),
                       lambda s: s.update(storage_objects=1),
                       lambda s: s['tables'].update({'auth.users': [{'encrypted_password': 'private'}]})):
            snapshot = self.snapshot()
            change(snapshot)
            with self.assertRaisesRegex(RuntimeError, 'Source schema/Storage'):
                api.checked_snapshot(snapshot, policy.PUBLIC, policy.PRIVATE, 'bbbbbbbbbbbbbbbbbbbb', policy.remap)

    def test_oversize_snapshot_is_rejected_before_sql_construction(self):
        with patch.object(api, 'MAX_BYTES', 10), self.assertRaisesRegex(RuntimeError, 'size bound'):
            api.checked_snapshot(self.snapshot(), policy.PUBLIC, policy.PRIVATE, 'bbbbbbbbbbbbbbbbbbbb', policy.remap)

    def test_a_production_destination_fails_before_any_network_operation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'config').mkdir()
            (root / 'config/release-system.json').write_text(json.dumps({'staging_project': api.PRODUCTION_PROJECT}))
            with patch.object(api, 'ROOT', root), patch.object(api, 'query') as query, patch.object(api, 'supabase') as supabase:
                with self.assertRaisesRegex(RuntimeError, 'Staging cannot target production'):
                    api.refresh(policy.PUBLIC, policy.PRIVATE, policy.PRESERVE, policy.remap, policy.receipt_valid)
                query.assert_not_called()
                supabase.assert_not_called()

    def test_new_columns_fail_before_a_destructive_transaction_can_be_sent(self):
        with self.assertRaisesRegex(RuntimeError, 'columns differ'):
            api.replacement_sql({'public.scouts': [{'unreviewed': 'private'}]}, {}, {},
                {'public.scouts': ['id']}, 'bbbbbbbbbbbbbbbbbbbb')


if __name__ == '__main__':
    unittest.main()
