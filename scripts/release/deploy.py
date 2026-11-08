"""Integrated CI deployment. Production stays locked behind recovery and owner approval.

Uses the trusted controller checkout with a separate exact candidate checkout.
Never reverses migrations. Every partial production outcome is recorded privately.
"""
import argparse
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile
import time
import urllib.request
import uuid
from access import PRODUCTION_PROJECT, request_json
from backend import deploy_functions, migrate, plan, schema_digest
from backup import BUCKET, backup, client, put_json, timestamp, sha as file_sha
from platform_api import query, supabase
from retention import parse_time

ROOT = Path(__file__).resolve().parents[2]


@contextmanager
def backend_checkout(root, commit, *, current_commit=None):
    """A recorded operational baseline can retain newer safety-aware functions."""
    if not re.fullmatch('[a-f0-9]{40}', commit):
        raise RuntimeError('Exact backend source commit required')
    if (current_commit or run(['git', 'rev-parse', 'HEAD'], cwd=root)) == commit:
        yield root
        return
    run(['git', 'merge-base', '--is-ancestor', commit, 'origin/main'], cwd=root)
    with tempfile.TemporaryDirectory(prefix='pack99-backend-source-') as temporary:
        destination = Path(temporary)
        source = destination / 'source.tar.gz'
        run(['git', 'archive', '--format=tar.gz', '--output=' + str(source), commit], cwd=root)
        with tarfile.open(source) as archive:
            archive.extractall(destination, filter='data')
        source.unlink()
        run(['npm', 'ci', '--ignore-scripts'], cwd=destination)
        yield destination


def rollback_backend_commit(s3, current, commit):
    key = current.get('previous_operation_key')
    if not key:
        return commit
    if not re.fullmatch('operations/[a-f0-9]{32}\\.json', key):
        raise RuntimeError('Invalid previous operation identity')
    record = json.loads(s3.get_object(Bucket=BUCKET, Key=key)['Body'].read())
    if record.get('status') != 'verified' or record.get('commit') != commit:
        raise RuntimeError('Previous operational baseline is not verified')
    backend = record.get('backend_commit', commit)
    if not re.fullmatch('[a-f0-9]{40}', backend):
        raise RuntimeError('Invalid previous backend source')
    return backend


def run(args, *, cwd=None):
    result = subprocess.run(args, cwd=cwd, capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError('Release command failed: ' + args[0])
    return result.stdout.strip()


def candidate(root, sha):
    if not re.fullmatch('[0-9a-f]{40}', sha) or run(['git', 'rev-parse', 'HEAD'], cwd=root) != sha:
        raise RuntimeError('Candidate checkout does not match exact approved commit')
    if run(['git', 'status', '--porcelain', '--untracked-files=no'], cwd=root):
        raise RuntimeError('Candidate source has tracked edits')
    return Path(root).resolve()


def function_inventory(project):
    return sorted([{'slug': f['slug'], 'version': f['version']} for f in supabase('/v1/projects/' + project + '/functions')], key=lambda f: f['slug'])


def config_inventory(project):
    base = '/v1/projects/' + project
    auth = supabase(base + '/config/auth')
    return {'secret_digests': sorted([{'name': f['name'], 'digest': f['value']} for f in supabase(base + '/secrets')], key=lambda f: f['name']),
        'auth': {key: auth.get(key) for key in ('site_url', 'uri_allow_list', 'disable_signup', 'external_email_enabled', 'external_google_enabled', 'hook_send_email_enabled', 'hook_send_email_uri')}}


def pause(project, value):
    supabase('/v1/projects/' + project + '/secrets', method='POST', data=[{'name': 'PACK99_DELIVERY_PAUSED', 'value': 'true' if value else 'false'}])


def maintenance(project, enabled):
    if not query(project, "select to_regprocedure('private.set_release_maintenance(boolean)') as present")[0]['present']:
        raise RuntimeError('Rehearsed maintenance barrier must be adopted before integrated production deployment')
    query(project, 'select private.set_release_maintenance(' + ('true' if enabled else 'false') + ')')


def site_response(url):
    # Cloudflare rejects Python's generic urllib browser signature (1010).
    # Identify the deployment checker explicitly for public route/readback checks.
    request = urllib.request.Request(url, headers={'User-Agent': 'PackPilotReleaseVerifier/1.0'})
    return urllib.request.urlopen(request, timeout=30)


def website(root, project, sha):
    if project not in ('packpilot-site', 'packpilot-staging'):
        raise RuntimeError('Unexpected Pages project')
    if not os.environ.get('GITHUB_ACTIONS') == 'true':
        raise RuntimeError('Website upload only runs through GitHub Actions')
    dist = root / 'auth-ui/dist'
    # Public commit metadata is part of the exact artifact uploaded to Pages.
    (dist / 'release.json').write_text(json.dumps({'commit': sha}))
    output = run([str(root / 'node_modules/.bin/wrangler'), 'pages', 'deploy', str(dist),
        '--project-name', project, '--branch', 'main', '--commit-hash', sha, '--commit-dirty=false'], cwd=root)
    # Verify Cloudflare's recorded source rather than trusting command exit alone.
    account = os.environ['CLOUDFLARE_ACCOUNT_ID']
    base = 'https://api.cloudflare.com/client/v4/accounts/' + account + '/pages/projects/' + project
    value = request_json(base, os.environ['CLOUDFLARE_API_TOKEN'])['result']
    deployment = value.get('canonical_deployment') or value.get('latest_deployment')
    if not deployment or deployment.get('deployment_trigger', {}).get('metadata', {}).get('commit_hash') != sha or deployment.get('latest_stage', {}).get('status') != 'success':
        raise RuntimeError('Cloudflare deployment commit/status failed verification')
    url = deployment['url'].rstrip('/')
    with site_response(url + '/release.json') as response:
        if json.load(response).get('commit') != sha:
            raise RuntimeError('Published release identifier mismatch')
    for route in ('/', '/parents', '/oauth/consent', '/prev/'):
        with site_response(url + route) as response:
            if response.status != 200:
                raise RuntimeError('Published route failed')
    return {'id': deployment['id'], 'url': url, 'commit': sha}


def safe_smoke(project):
    # Invalid scheduler credentials cannot send mail. Do not replace this with a
    # valid HMAC proof: a successful dispatcher invocation drains parent mail.
    from urllib.error import HTTPError
    req = urllib.request.Request('https://' + project + '.supabase.co/functions/v1/parent-notifications',
        data=b'{}', headers={'Content-Type': 'application/json'})
    try:
        urllib.request.urlopen(req, timeout=30)
    except HTTPError as error:
        if error.code != 401:
            raise RuntimeError('Notification endpoint did not reject an unauthenticated request') from None
    else:
        raise RuntimeError('Notification endpoint did not reject an unauthenticated request')
    origin = 'https://packpilot.example' if project == PRODUCTION_PROJECT else 'https://staging.packpilot.example'
    url = 'https://' + project + '.supabase.co/functions/v1/scouts-mcp/.well-known/oauth-protected-resource'
    req = urllib.request.Request(url, headers={'Origin': origin})
    with urllib.request.urlopen(req, timeout=30) as response:
        metadata = json.load(response)
        if (response.status != 200 or response.headers.get('Access-Control-Allow-Origin') != origin
                or metadata.get('authorization_servers') != ['https://' + project + '.supabase.co/auth/v1']):
            raise RuntimeError('MCP startup, origin or authorization-server metadata failed verification')


def staging(root, sha, evidence_path, *, rollback=False, backend_root=None, backend_commit=None):
    config = json.loads((ROOT / 'config/release-system.json').read_text())
    project = config['staging_project']
    if project == PRODUCTION_PROJECT:
        raise RuntimeError('Staging target is production')
    pause(project, True)
    try:
        maintenance(project, True)
        migrations = plan(project, root, rollback=True) if rollback else migrate(project, root)
        functions = deploy_functions(project, backend_root or root, staging=True)
        page = website(root, 'packpilot-staging', sha)
        safe_smoke(project)
        evidence = {'commit': sha, 'backend_commit': backend_commit or sha,
            'project': project, 'deployed_at': timestamp(),
            'migration_digest': migrations['migration_digest'], 'functions': function_inventory(project),
            'schema_digest': schema_digest(project),
            'function_sources': functions, 'configuration': config_inventory(project), 'website': page, 'status': 'deployed',
            'delivery_paused': True, 'acceptance': 'owner must approve this exact tested commit'}
        Path(evidence_path).write_text(json.dumps(evidence, indent=2))
        maintenance(project, False)
        # Staging delivery remains paused until isolated provider verification.
    except Exception:
        raise RuntimeError('Staging deployment incomplete; delivery and maintenance must remain closed') from None


def staging_evidence(run_id, sha, root, *, rollback=False, backend_commit=None):
    if not re.fullmatch(r'\d+', run_id):
        raise RuntimeError('Staging Actions run ID required')
    data = json.loads(run(['gh', 'api', 'repos/YOUR_GITHUB_OWNER/YOUR_GITHUB_REPOSITORY/actions/runs/' + run_id]))
    if data.get('conclusion') != 'success' or data.get('event') not in ('push', 'workflow_dispatch') or data.get('head_branch') != 'main' or data.get('name') != 'Staging integration' or (data.get('event') == 'push' and data.get('head_sha') != sha):
        raise RuntimeError('Candidate lacks a successful main staging deployment')
    with tempfile.TemporaryDirectory(prefix='pack99-evidence-') as temp:
        run(['gh', 'run', 'download', run_id, '--repo', 'YOUR_GITHUB_OWNER/YOUR_GITHUB_REPOSITORY', '--name', 'staging-evidence-' + sha, '--dir', temp])
        evidence = json.loads((Path(temp) / 'staging.json').read_text())
    config = json.loads((ROOT / 'config/release-system.json').read_text())
    age = datetime.now(timezone.utc) - parse_time(evidence['deployed_at'])
    if (evidence.get('commit') != sha or evidence.get('status') != 'deployed'
            or evidence.get('backend_commit', sha) != (backend_commit or sha)
            or evidence.get('project') != config['staging_project']
            or not timedelta(0) <= age <= timedelta(days=14)):
        raise RuntimeError('Invalid staging deployment evidence')
    if evidence['functions'] != function_inventory(evidence['project']):
        raise RuntimeError('Staging functions changed after candidate deployment')
    if evidence.get('configuration') != config_inventory(evidence['project']):
        raise RuntimeError('Staging configuration changed after candidate deployment')
    if evidence.get('schema_digest') != schema_digest(evidence['project']):
        raise RuntimeError('Staging schema changed after candidate deployment')
    current = plan(evidence['project'], root, rollback=rollback)
    if current['migration_digest'] != evidence['migration_digest']:
        raise RuntimeError('Staging database changed after candidate deployment')
    return evidence


def resume_record(s3, operation, sha, current, rollback):
    if not re.fullmatch('[a-f0-9]{32}', operation):
        raise RuntimeError('Invalid production operation ID')
    record = json.loads(s3.get_object(Bucket=BUCKET, Key='operations/' + operation + '.json')['Body'].read())
    if (record.get('id') != operation or record.get('commit') != sha
            or record.get('previous_commit') != current['commit']
            or record.get('kind') != ('rollback' if rollback else 'release')
            or record.get('status') not in ('started', 'partial-failure', 'prepared')):
        raise RuntimeError('Resume must match the unfinished operation and unchanged production pointer')
    return record


def immutable_tag(root, tag, sha):
    # A retry may follow a successful push whose response was lost. Verify the
    # remote object before reusing a tag; never move an existing production tag.
    remote = run(['git', 'ls-remote', '--tags', 'origin', 'refs/tags/' + tag], cwd=root)
    if remote:
        if remote.split()[0] != sha:
            raise RuntimeError('Production tag already identifies another commit')
        return
    local = subprocess.run(['git', 'rev-parse', '--verify', 'refs/tags/' + tag], cwd=root, capture_output=True, text=True)
    if local.returncode == 0:
        if local.stdout.strip() != sha:
            raise RuntimeError('Local production tag identifies another commit')
    else:
        run(['git', 'tag', tag, sha], cwd=root)
    run(['git', 'push', 'origin', 'refs/tags/' + tag], cwd=root)


def publish_pointer(s3, value):
    try:
        put_json(s3, 'releases/current.json', value)
    except Exception:
        # A lost successful response must not turn a committed release into a
        # partial failure. R2 reads are strongly consistent.
        actual = json.loads(s3.get_object(Bucket=BUCKET, Key='releases/current.json')['Body'].read())
        if actual != value:
            raise


def finalize_operation(s3, record):
    record['status'] = 'verified'
    put_json(s3, 'operations/' + record['id'] + '.json', record)
    put_json(s3, 'releases/' + record['id'] + '/manifest.json', record)
    s3.delete_object(Bucket=BUCKET, Key='pins/release-' + record['id'] + '.json')
    for attempt in range(1, record['attempts'] + 1):
        s3.delete_object(Bucket=BUCKET, Key='pins/release-' + record['id'] + '-attempt-' + str(attempt) + '.json')


def production(root, sha, staging_run, *, rollback=False, resume_operation=None):
    if os.environ.get('GITHUB_EVENT_NAME') != 'workflow_dispatch' or os.environ.get('GITHUB_ACTOR') != 'YOUR_GITHUB_OWNER':
        raise RuntimeError('Only owner-dispatched production operations are allowed')
    s3 = client()
    # This record is created only after real recovery/administrator acceptance,
    # never by synthetic tests or this deployment command.
    activation = json.loads(s3.get_object(Bucket=BUCKET, Key='activation/verified.json')['Body'].read())
    if activation.get('status') != 'verified' or activation.get('recovery_administrator') != 'Recovery Administrator':
        raise RuntimeError('Recovery/admin readiness has not been verified')
    rehearsal = json.loads(s3.get_object(Bucket=BUCKET, Key=activation['restore_rehearsal_key'])['Body'].read())
    if rehearsal.get('status') != 'verified':
        raise RuntimeError('A complete accepted restore rehearsal is required')
    current = json.loads(s3.get_object(Bucket=BUCKET, Key='releases/current.json')['Body'].read())
    if resume_operation and re.fullmatch('[a-f0-9]{32}', resume_operation) and current.get('operation_key') == 'operations/' + resume_operation + '.json':
        record = json.loads(s3.get_object(Bucket=BUCKET, Key=current['operation_key'])['Body'].read())
        if (record.get('id') != resume_operation or record.get('commit') != sha or current.get('commit') != sha
                or record.get('previous_commit') != current.get('previous_commit')
                or record.get('kind') != ('rollback' if rollback else 'release')
                or record.get('status') not in ('prepared', 'verified')):
            raise RuntimeError('Committed operation metadata does not match the requested resume')
        # The runner may have stopped after the pointer write. Complete metadata
        # and pin cleanup only; never pause or redeploy an already committed app.
        finalize_operation(s3, record)
        return
    current_key = current.get('operation_key', '')
    if not re.fullmatch('operations/[a-f0-9]{32}\\.json', current_key):
        raise RuntimeError('A verified operational production baseline is required')
    baseline = json.loads(s3.get_object(Bucket=BUCKET, Key=current_key)['Body'].read())
    if baseline.get('status') != 'verified' or baseline.get('commit') != current.get('commit'):
        raise RuntimeError('Current production operation is not verified')
    if not resume_operation and baseline.get('schema_digest') != schema_digest(PRODUCTION_PROJECT):
        raise RuntimeError('Production catalog differs from its verified baseline')
    if rollback and sha != current.get('previous_commit'):
        raise RuntimeError('Rollback is restricted to the previous known-good commit')
    if not rollback:
        run(['git', 'merge-base', '--is-ancestor', current['commit'], sha], cwd=root)
    record = resume_record(s3, resume_operation, sha, current, rollback) if resume_operation else None
    backend_commit = rollback_backend_commit(s3, current, sha) if rollback else sha
    staged = staging_evidence(staging_run, sha, root, rollback=rollback, backend_commit=backend_commit)
    migrations = plan(PRODUCTION_PROJECT, root, rollback=rollback)
    if migrations['migration_digest'] != staged['migration_digest']:
        raise RuntimeError('Candidate was not tested against the resulting production migration history')
    # Verify the live website baseline before any backend mutation.
    with site_response('https://packpilot.example/release.json') as response:
        live = json.load(response).get('commit')
        # A failed verification can follow an upload whose response was lost.
        # Re-running the same approved operation re-verifies all components.
        if live not in ({current['commit'], sha} if record else {current['commit']}):
            raise RuntimeError('Production baseline drift; inspect before deploying')
    with backend_checkout(root, backend_commit, current_commit=sha) as backend_root:
        return execute_operation(root, sha, staging_run, s3, current, migrations,
            rollback=rollback, resume_operation=resume_operation, record=record,
            backend_root=backend_root, backend_commit=backend_commit)


def execute_operation(root, sha, staging_run, s3, current, migrations, *, rollback=False,
                      resume_operation=None, record=None, backend_root=None,
                      backend_commit=None, rehearsal=False, fail_after=None):
    if (os.environ.get('GITHUB_ACTIONS') != 'true' or os.environ.get('GITHUB_ACTOR') != 'YOUR_GITHUB_OWNER'
            or os.environ.get('GITHUB_EVENT_NAME') != 'workflow_dispatch'
            or os.environ.get('GITHUB_REF') != 'refs/heads/main'
            or os.environ.get('GITHUB_REPOSITORY') != 'YOUR_GITHUB_OWNER/YOUR_GITHUB_REPOSITORY'):
        raise RuntimeError('Integrated operations require owner-dispatched main Actions')
    # Production callers pass through production() gates. The separate rehearsal
    # caller can select only this fixed isolated target and a namespaced store.
    if rehearsal:
        from rehearsal_store import RehearsalStore
        if not isinstance(s3, RehearsalStore):
            raise RuntimeError('Staging rehearsal requires isolated operation metadata')
    if fail_after is not None and (not rehearsal or fail_after != 'website'):
        raise RuntimeError('Fault injection is restricted to a staging rehearsal')
    project = 'bbbbbbbbbbbbbbbbbbbb' if rehearsal else PRODUCTION_PROJECT
    pages_project = 'packpilot-staging' if rehearsal else 'packpilot-site'
    operation = resume_operation or uuid.uuid4().hex
    key = 'operations/' + operation + '.json'
    record = record or {'id': operation, 'operator': 'YOUR_GITHUB_OWNER', 'commit': sha, 'previous_commit': current['commit'],
        'started_at': timestamp(), 'status': 'started', 'kind': 'rollback' if rollback else 'release', 'components': {}}
    record['environment'] = 'staging-rehearsal' if rehearsal else 'production'
    record['backend_commit'] = backend_commit or sha
    record['attempts'] = record.get('attempts', 0) + 1
    record.update(status='started', last_attempt_at=timestamp(), staging_run=staging_run)
    pin = 'pins/release-' + operation + '.json'
    release_prefix = 'releases/' + operation

    def save():
        put_json(s3, key, record)

    save()
    try:
        pause(project, True)
        # Existing deployed dispatcher must support the pause flag before activation.
        # Wait beyond the free Edge runtime's maximum lifetime. No blocking sleep
        # exceeds 5 seconds, and progress is emitted for the Actions execution log.
        start = time.monotonic()
        while time.monotonic() - start < (0 if rehearsal else 180):
            print('Draining existing notification invocations', flush=True)
            time.sleep(5)
        pending = query(project, "select count(*) as count from private.pack_email_outbox where status='sending'")[0]['count']
        if pending:
            raise RuntimeError('Existing notification deliveries remain unresolved; inspect without resending')
        maintenance(project, True)
        record['components']['maintenance'] = 'enabled'
        save()
        recovery = backup(s3.root if rehearsal else s3, reason='release-rehearsal' if rehearsal else 'pre-rollback' if rollback else 'pre-release')
        # Never replace the original recovery point with an already partially
        # migrated state when resuming. Keep every attempt independently pinned.
        put_json(s3, 'pins/release-' + operation + '-attempt-' + str(record['attempts']) + '.json',
                 {'backup_id': recovery['id'], 'operation': operation})
        if 'backup' not in record:
            put_json(s3, pin, {'backup_id': recovery['id'], 'operation': operation})
            record['backup'] = recovery['prefix']
        record.setdefault('attempt_backups', []).append(recovery['prefix'])
        record['components']['backup'] = 'validated'
        save()
        if not rollback:
            migrations = migrate(project, root)
        record['migrations'] = migrations
        record['schema_digest'] = schema_digest(project)
        record['components']['migrations'] = 'kept' if rollback else 'complete'
        save()

        def archive(slug, code):
            s3.put_object(Bucket=BUCKET, Key=release_prefix + '/functions/' + slug + '.ts', Body=code)

        record['functions'] = deploy_functions(project, backend_root or root, archive=archive, staging=rehearsal)
        record['components']['functions'] = 'complete'
        save()
        record['website'] = website(root, pages_project, sha)
        record['components']['website'] = 'complete'
        save()
        if fail_after == 'website':
            raise RuntimeError('Planned staging interruption after website verification')
        safe_smoke(project)
        with tempfile.TemporaryDirectory(prefix='pack99-release-') as temp:
            path = Path(temp) / 'source.tar.gz'
            run(['git', 'archive', '--format=tar.gz', '--output=' + str(path), sha], cwd=root)
            s3.upload_file(str(path), BUCKET, release_prefix + '/source.tar.gz')
            record['artifacts'] = [{'key': release_prefix + '/source.tar.gz', 'sha256': file_sha(path), 'bytes': path.stat().st_size}]
            path = Path(temp) / 'website.tar.gz'
            with tarfile.open(path, 'w:gz') as bundle:
                bundle.add(root / 'auth-ui/dist', arcname='website')
            s3.upload_file(str(path), BUCKET, release_prefix + '/website.tar.gz')
            record['artifacts'].append({'key': release_prefix + '/website.tar.gz', 'sha256': file_sha(path), 'bytes': path.stat().st_size})
            if backend_commit and backend_commit != sha:
                path = Path(temp) / 'backend-source.tar.gz'
                run(['git', 'archive', '--format=tar.gz', '--output=' + str(path), backend_commit], cwd=root)
                s3.upload_file(str(path), BUCKET, release_prefix + '/backend-source.tar.gz')
                record['artifacts'].append({'key': release_prefix + '/backend-source.tar.gz',
                    'sha256': file_sha(path), 'bytes': path.stat().st_size})
            for artifact in record['artifacts']:
                readback = Path(temp) / 'readback'
                s3.download_file(BUCKET, artifact['key'], str(readback))
                if file_sha(readback) != artifact['sha256']:
                    raise RuntimeError('Release artifact readback failed')
        # Unique immutable tag: reject any already-existing tag rather than moving it.
        tag = None if rehearsal else 'production/' + operation
        if tag:
            immutable_tag(root, tag, sha)
        record['tag'] = tag
        maintenance(project, False)
        pause(project, rehearsal)
        record['configuration'] = config_inventory(project)
        # The durable pointer is the commit point. A terminated runner between
        # this save and that write must leave an operation that can be resumed.
        record.update(status='prepared', finished_at=timestamp())
        save()
        put_json(s3, release_prefix + '/manifest.json', record)
        publish_pointer(s3, {'commit': sha, 'previous_commit': current['commit'],
            'operation_key': key, 'previous_operation_key': current.get('operation_key'), 'tag': tag})
    except Exception:
        try:
            pause(project, True)
            maintenance(project, True)
            record['components']['failure_isolation'] = 'closed'
        except Exception:
            record['components']['failure_isolation'] = 'unknown; administrator intervention required'
        record.update(status='partial-failure', finished_at=timestamp())
        save()
        # A partial operation retains its backup pin, pause and maintenance.
        # No automatic migration reversal or authenticated dispatch is attempted.
        raise RuntimeError('Production operation incomplete; inspect durable operation record and retained recovery pin') from None
    # The production pointer is the commit point. Failed housekeeping after it
    # must not reclose a verified release or rewrite its outcome as a failure.
    try:
        finalize_operation(s3, record)
    except Exception:
        print('Release pointer committed; operation metadata/pin cleanup requires administrator review', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--environment', choices=['staging', 'production'], required=True)
    parser.add_argument('--candidate-root', required=True)
    parser.add_argument('--commit', required=True)
    parser.add_argument('--staging-run')
    parser.add_argument('--rollback', action='store_true')
    parser.add_argument('--backend-commit')
    parser.add_argument('--resume-operation')
    parser.add_argument('--evidence', default='staging.json')
    args = parser.parse_args()
    try:
        if os.environ.get('GITHUB_ACTIONS') != 'true':
            raise RuntimeError('Integrated deployment must run in GitHub Actions')
        root = candidate(args.candidate_root, args.commit)
        if args.environment == 'staging':
            if os.environ.get('GITHUB_EVENT_NAME') == 'pull_request':
                from workflow_context import owner_pr_snapshot
                owner_pr_snapshot(root, 'rehearse-staging', args.commit)
            backend_commit = args.backend_commit or args.commit
            if backend_commit != args.commit and not args.rollback:
                raise RuntimeError('Operational backend overrides are restricted to rollback tests')
            with backend_checkout(root, backend_commit, current_commit=args.commit) as backend_root:
                staging(root, args.commit, args.evidence, rollback=args.rollback,
                        backend_root=backend_root, backend_commit=backend_commit)
        else:
            if args.backend_commit:
                raise RuntimeError('Production backend selection comes only from verified operation metadata')
            production(root, args.commit, args.staging_run or '', rollback=args.rollback, resume_operation=args.resume_operation)
    except Exception as error:
        # Tool exceptions never include provider bodies, SQL, URLs or credentials.
        print('Integrated deployment failed; inspect component metadata and setup readiness')
        raise SystemExit(1)
