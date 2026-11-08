"""Failure-injection rehearsals of the controller, with no provider/DB access."""
from contextlib import ExitStack
import io
import itertools
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts/release'))
import deploy
from test_release_tools import ObjectStore
from test_release_tools import module

expiry = module('expire_records', 'expire-records.py')

OLD, NEW = 'a' * 40, 'b' * 40


class DeploymentTests(unittest.TestCase):
    def setup_controller(self, stack, store):
        temp = stack.enter_context(tempfile.TemporaryDirectory())
        root = Path(temp)
        (root / 'auth-ui/dist').mkdir(parents=True)
        (root / 'auth-ui/dist/index.html').write_text('synthetic website')
        deploy.put_json(store, 'activation/verified.json', {'status': 'verified',
            'recovery_administrator': 'Recovery Administrator', 'restore_rehearsal_key': 'rehearsals/test.json'})
        deploy.put_json(store, 'rehearsals/test.json', {'status': 'verified'})
        baseline = 'operations/' + '0' * 32 + '.json'
        deploy.put_json(store, baseline, {'commit': OLD, 'kind': 'baseline', 'status': 'verified',
            'schema_digest': 'synthetic-catalog'})
        deploy.put_json(store, 'releases/current.json', {'commit': OLD, 'previous_commit': 'c' * 40,
            'operation_key': baseline})
        stack.enter_context(patch.dict(os.environ, {'GITHUB_EVENT_NAME': 'workflow_dispatch', 'GITHUB_ACTOR': 'YOUR_GITHUB_OWNER',
            'GITHUB_ACTIONS': 'true', 'GITHUB_REF': 'refs/heads/main', 'GITHUB_REPOSITORY': 'YOUR_GITHUB_OWNER/YOUR_GITHUB_REPOSITORY'}))
        mocks = {}
        for name, value in [('client', store), ('staging_evidence', {'migration_digest': 'synthetic'}),
                ('plan', {'migration_digest': 'synthetic'}), ('migrate', {'migration_digest': 'synthetic'}),
                ('config_inventory', {}), ('schema_digest', 'synthetic-catalog'), ('query', [{'count': 0}]), ('pause', None),
                ('maintenance', None), ('deploy_functions', []), ('website', {}),
                ('safe_smoke', None), ('immutable_tag', None)]:
            mocks[name] = stack.enter_context(patch.object(deploy, name, return_value=value))
        mocks['backup'] = stack.enter_context(patch.object(deploy, 'backup', side_effect=[
            {'id': 'original', 'prefix': 'backups/original'}, {'id': 'retry', 'prefix': 'backups/retry'}]))
        stack.enter_context(patch.object(deploy.time, 'monotonic', side_effect=itertools.cycle([0, 181])))
        stack.enter_context(patch.object(deploy.urllib.request, 'urlopen',
            side_effect=lambda *a, **k: io.BytesIO(json.dumps({'commit': self.live}).encode())))

        def command(args, **kwargs):
            if args[:2] == ['git', 'archive']:
                Path(next(a.removeprefix('--output=') for a in args if a.startswith('--output='))).write_bytes(b'synthetic source')
            return ''

        mocks['run'] = stack.enter_context(patch.object(deploy, 'run', side_effect=command))
        self.live = OLD
        return root, mocks

    def record(self, store):
        key = next(key for key in store.objects if key.startswith('operations/') and json.loads(store.objects[key]).get('kind') != 'baseline')
        return json.loads(store.objects[key])

    def test_every_component_failure_keeps_pointer_and_closes_writes(self):
        for component in ('backup', 'migrate', 'deploy_functions', 'website', 'safe_smoke', 'immutable_tag', 'config_inventory'):
            with self.subTest(component=component), ExitStack() as stack:
                store = ObjectStore()
                root, mocks = self.setup_controller(stack, store)
                mocks[component].side_effect = RuntimeError('synthetic interruption')
                with self.assertRaisesRegex(RuntimeError, 'incomplete'):
                    deploy.production(root, NEW, '1')
                self.assertEqual(json.loads(store.objects['releases/current.json'])['commit'], OLD)
                record = self.record(store)
                self.assertEqual(record['status'], 'partial-failure')
                self.assertEqual(mocks['maintenance'].call_args.args, (deploy.PRODUCTION_PROJECT, True))
                self.assertEqual(mocks['pause'].call_args.args, (deploy.PRODUCTION_PROJECT, True))
                if component != 'backup':
                    self.assertTrue(any(k.startswith('pins/') for k in store.objects))

    def test_resume_reverifies_partial_upload_and_preserves_original_backup(self):
        with ExitStack() as stack:
            store = ObjectStore()
            root, mocks = self.setup_controller(stack, store)
            mocks['safe_smoke'].side_effect = RuntimeError('synthetic failure after upload')
            with self.assertRaises(RuntimeError):
                deploy.production(root, NEW, '1')
            original = self.record(store)
            mocks['safe_smoke'].side_effect = None
            self.live = NEW
            deploy.production(root, NEW, '2', resume_operation=original['id'])
            result = self.record(store)
            self.assertEqual(result['attempts'], 2)
            self.assertEqual(result['backup'], 'backups/original')
            self.assertEqual(result['attempt_backups'], ['backups/original', 'backups/retry'])
            self.assertEqual(result['status'], 'verified')
            self.assertEqual(json.loads(store.objects['releases/current.json'])['commit'], NEW)
            self.assertFalse(any(k.startswith('pins/') for k in store.objects))
            self.assertEqual(mocks['website'].call_count, 2)

    def test_runner_termination_before_pointer_can_resume_prepared_operation(self):
        with ExitStack() as stack:
            store = ObjectStore()
            root, mocks = self.setup_controller(stack, store)
            with patch.object(deploy, 'publish_pointer', side_effect=KeyboardInterrupt), self.assertRaises(KeyboardInterrupt):
                deploy.production(root, NEW, '1')
            record = self.record(store)
            self.assertEqual(record['status'], 'prepared')
            self.assertEqual(json.loads(store.objects['releases/current.json'])['commit'], OLD)
            self.live = NEW
            deploy.production(root, NEW, '2', resume_operation=record['id'])
            self.assertEqual(self.record(store)['status'], 'verified')
            self.assertEqual(self.record(store)['attempts'], 2)
            self.assertEqual(self.record(store)['backup'], 'backups/original')

    def test_runner_termination_after_pointer_resumes_housekeeping_only(self):
        for rollback in (False, True):
            with self.subTest(rollback=rollback), ExitStack() as stack:
                store = ObjectStore()
                root, mocks = self.setup_controller(stack, store)
                commit = 'c' * 40 if rollback else NEW
                with patch.object(deploy, 'finalize_operation', side_effect=KeyboardInterrupt), self.assertRaises(KeyboardInterrupt):
                    deploy.production(root, commit, '1', rollback=rollback)
                record = self.record(store)
                self.assertEqual(record['status'], 'prepared')
                self.assertEqual(json.loads(store.objects['releases/current.json'])['commit'], commit)
                for mock in mocks.values():
                    mock.reset_mock()
                deploy.production(root, commit, '', rollback=rollback, resume_operation=record['id'])
                self.assertEqual(self.record(store)['status'], 'verified')
                self.assertFalse(any(k.startswith('pins/') for k in store.objects))
                for name in ('pause', 'maintenance', 'backup', 'website', 'staging_evidence'):
                    mocks[name].assert_not_called()

    def test_committed_resume_rejects_a_different_candidate_or_operation_kind(self):
        with ExitStack() as stack:
            store = ObjectStore()
            root, mocks = self.setup_controller(stack, store)
            deploy.production(root, NEW, '1')
            record = self.record(store)
            for commit, rollback in ((OLD, False), (NEW, True)):
                with self.assertRaises(RuntimeError):
                    deploy.production(root, commit, '', rollback=rollback, resume_operation=record['id'])

    def test_rollback_keeps_migrations_and_uses_separate_artifacts(self):
        with ExitStack() as stack:
            store = ObjectStore()
            root, mocks = self.setup_controller(stack, store)
            deploy.production(root, 'c' * 40, '1', rollback=True)
            mocks['migrate'].assert_not_called()
            record = self.record(store)
            self.assertEqual(record['kind'], 'rollback')
            self.assertEqual(record['components']['migrations'], 'kept')
            self.assertTrue(all(a['key'].startswith('releases/' + record['id'] + '/') for a in record['artifacts']))

    def test_resume_rejects_other_candidate_baseline_and_completed_operations(self):
        store = ObjectStore()
        operation = 'd' * 32
        record = {'id': operation, 'commit': NEW, 'previous_commit': OLD, 'kind': 'release', 'status': 'partial-failure'}
        deploy.put_json(store, 'operations/' + operation + '.json', record)
        for sha, baseline, rollback in [(OLD, OLD, False), (NEW, NEW, False), (NEW, OLD, True)]:
            with self.assertRaises(RuntimeError):
                deploy.resume_record(store, operation, sha, {'commit': baseline}, rollback)
        record['status'] = 'verified'
        deploy.put_json(store, 'operations/' + operation + '.json', record)
        with self.assertRaises(RuntimeError):
            deploy.resume_record(store, operation, NEW, {'commit': OLD}, False)

    def test_artifact_corruption_prevents_pointer_update(self):
        with ExitStack() as stack:
            store = ObjectStore(corrupt=True)
            root, mocks = self.setup_controller(stack, store)
            with self.assertRaises(RuntimeError):
                deploy.production(root, NEW, '1')
            self.assertEqual(json.loads(store.objects['releases/current.json'])['commit'], OLD)
            mocks['immutable_tag'].assert_not_called()

    def test_cleanup_failure_after_commit_does_not_close_verified_release(self):
        with ExitStack() as stack:
            store = ObjectStore()
            root, mocks = self.setup_controller(stack, store)
            stack.enter_context(patch.object(store, 'delete_object', side_effect=RuntimeError('cleanup failure')))
            deploy.production(root, NEW, '1')
            self.assertEqual(self.record(store)['status'], 'verified')
            self.assertEqual(json.loads(store.objects['releases/current.json'])['commit'], NEW)
            self.assertEqual(mocks['maintenance'].call_args.args, (deploy.PRODUCTION_PROJECT, False))

    def test_immutable_tag_retry_accepts_only_same_remote_commit(self):
        with patch.object(deploy, 'run', return_value=NEW + '\trefs/tags/production/test') as run:
            deploy.immutable_tag(Path('.'), 'production/test', NEW)
            self.assertEqual(run.call_count, 1)
            with self.assertRaises(RuntimeError):
                deploy.immutable_tag(Path('.'), 'production/test', OLD)

    def test_pointer_response_loss_is_reconciled_by_readback(self):
        store = ObjectStore()
        pointer = {'commit': NEW, 'operation_key': 'operations/test.json'}
        original = store.put_object

        def lost_response(**kwargs):
            original(**kwargs)
            raise RuntimeError('response lost')

        with patch.object(store, 'put_object', side_effect=lost_response):
            deploy.publish_pointer(store, pointer)
        with patch.object(store, 'put_object', side_effect=RuntimeError('write failed')):
            with self.assertRaises(RuntimeError):
                deploy.publish_pointer(store, {'commit': OLD})

    def test_expiry_keeps_baselines_pins_and_partial_operations(self):
        store = ObjectStore()
        ids = [str(i) * 32 for i in range(1, 6)]
        for operation, status, commit in zip(ids, ['verified'] * 3 + ['partial-failure', 'verified'], ['d' * 40] * 5):
            record = {'id': operation, 'commit': commit, 'status': status, 'finished_at': '2020-01-01T00:00:00Z'}
            deploy.put_json(store, 'operations/' + operation + '.json', record)
            store.objects['releases/' + operation + '/source.tar.gz'] = b'synthetic'
        deploy.put_json(store, 'releases/current.json', {'commit': NEW, 'previous_commit': OLD,
            'operation_key': 'operations/' + ids[0] + '.json', 'previous_operation_key': 'operations/' + ids[1] + '.json'})
        deploy.put_json(store, 'pins/retained.json', {'backup_id': 'test', 'operation': ids[2]})
        self.assertEqual(expiry.expire(store), [ids[4]])
        for operation in ids[:4]:
            self.assertIn('operations/' + operation + '.json', store.objects)
            self.assertIn('releases/' + operation + '/source.tar.gz', store.objects)

    def test_no_expiry_without_a_verified_production_baseline(self):
        store = ObjectStore()
        store.objects['operations/unknown.json'] = b'{}'
        self.assertEqual(expiry.expire(store), [])
        self.assertIn('operations/unknown.json', store.objects)

    def test_expiry_bounds_backup_metadata_but_keeps_retained_points(self):
        store = ObjectStore()
        deploy.put_json(store, 'releases/current.json', {'commit': NEW})
        for id in ('retained', 'expired'):
            record = {'id': id, 'completed_at': '2020-01-01T00:00:00Z', 'prefix': 'backups/' + id}
            deploy.put_json(store, 'records/backups/' + id + '.json', record)
        deploy.put_json(store, 'backups/retained/manifest.json', record | {'id': 'retained', 'prefix': 'backups/retained'})
        expiry.expire(store)
        self.assertIn('records/backups/retained.json', store.objects)
        self.assertNotIn('records/backups/expired.json', store.objects)

    def test_staging_evidence_rejects_expiry_wrong_project_and_catalog_drift(self):
        evidence = {'commit': NEW, 'status': 'deployed', 'project': 'bbbbbbbbbbbbbbbbbbbb',
            'deployed_at': deploy.timestamp(), 'functions': [], 'configuration': {},
            'schema_digest': 'catalog', 'migration_digest': 'migrations'}

        def gh(args, **kwargs):
            if args[:2] == ['gh', 'api']:
                return json.dumps({'conclusion': 'success', 'event': 'push', 'head_branch': 'main',
                    'head_sha': NEW, 'name': 'Staging integration'})
            Path(args[-1], 'staging.json').write_text(json.dumps(evidence))
            return ''

        with ExitStack() as stack:
            stack.enter_context(patch.object(deploy, 'run', side_effect=gh))
            stack.enter_context(patch.object(deploy, 'function_inventory', return_value=[]))
            stack.enter_context(patch.object(deploy, 'config_inventory', return_value={}))
            stack.enter_context(patch.object(deploy, 'schema_digest', return_value='catalog'))
            stack.enter_context(patch.object(deploy, 'plan', return_value={'migration_digest': 'migrations'}))
            self.assertEqual(deploy.staging_evidence('1', NEW, Path('.')), evidence)
            for field, value in [('project', deploy.PRODUCTION_PROJECT), ('schema_digest', 'drift'),
                    ('deployed_at', '2020-01-01T00:00:00Z'), ('deployed_at', '2099-01-01T00:00:00Z')]:
                original = evidence[field]
                evidence[field] = value
                with self.assertRaises(RuntimeError):
                    deploy.staging_evidence('1', NEW, Path('.'))
                evidence[field] = original


if __name__ == '__main__':
    unittest.main()
