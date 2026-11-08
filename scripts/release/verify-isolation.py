"""Live staging-only Auth, notification and retry checks before any real-data copy.

Sends safety-test mail only to staging@example.test. Requires an otherwise empty
application/Auth database, an authorized mail provider and deployed safeguards.
Keeps staging delivery, signup and email login closed after the check.
"""
import argparse
import hashlib
import hmac
import json
from pathlib import Path
import time
import urllib.error
import urllib.request
from urllib.parse import quote
import uuid
from backend import literal
from platform_api import private_json, project_ref, query, supabase
from backup import timestamp

ROOT = Path(__file__).resolve().parents[2]


def request(origin, path, headers, body):
    req = urllib.request.Request(origin + path, data=json.dumps(body).encode(), headers={**headers, 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=120) as response:
        return json.load(response)


def wait_email_provider(origin, anon, enabled=True):
    # Management configuration propagates to GoTrue asynchronously. Do not
    # mistake email_provider_disabled for evidence that the hook blocked mail.
    for _ in range(24):
        req = urllib.request.Request(origin + '/auth/v1/settings', headers={'apikey': anon})
        with urllib.request.urlopen(req, timeout=20) as response:
            if json.load(response).get('external', {}).get('email') is enabled:
                return
        time.sleep(5)
    raise RuntimeError('Staging email-provider configuration did not propagate')


def verify(*, post_refresh=False):
    receipt_path = ROOT / '.local/release/staging-isolation.json'
    receipt_path.unlink(missing_ok=True)
    config = json.loads((ROOT / 'config/release-system.json').read_text())
    state = json.loads((ROOT / '.local/release/staging-admin.json').read_text())
    ref = project_ref(config['staging_project'], staging=True)
    base = '/v1/projects/' + ref
    origin = 'https://' + ref + '.supabase.co'
    if post_refresh:
        counts = query(ref, """select (select count(*) from public.scouts) as scouts,
          (select count(*) from auth.identities)+(select count(*) from auth.sessions)+
          (select count(*) from auth.refresh_tokens)+(select count(*) from private.pack_email_outbox)+
          (select count(*) from auth.users where banned_until is distinct from 'infinity'::timestamptz) as forbidden""")[0]
        if counts['scouts'] == 0 or counts['forbidden'] != 0:
            raise RuntimeError('Post-refresh checks require copied scouts and closed synthetic-only Auth/delivery state')
    elif query(ref, "select (select count(*) from public.scouts)+(select count(*) from auth.users)+(select count(*) from private.pack_email_outbox) as records")[0]['records'] != 0:
        raise RuntimeError('Run initial isolation checks before real-data refresh, with an empty staging application/Auth database')
    if query(ref, 'select count(*) as jobs from cron.job')[0]['jobs']:
        raise RuntimeError('Staging scheduler must be empty during verification')
    names = {s['name'] for s in supabase(base + '/secrets')}
    if 'BREVO_API_KEY' not in names:
        raise RuntimeError('Authorized staging mail credential required')
    keys = supabase(base + '/api-keys')
    service = next(k['api_key'] for k in keys if k['name'] == 'service_role')
    anon = next(k['api_key'] for k in keys if k['name'] == 'anon')
    auth_headers = {'apikey': service, 'Authorization': 'Bearer ' + service}
    users = []
    snapshot, scout = str(uuid.uuid4()), str(uuid.uuid4())
    if post_refresh:
        snapshot = query(ref, 'select id from public.roster_snapshots where singleton')[0]['id']
    run = uuid.uuid4().hex
    allowed, blocked = 'staging@example.test', 'blocked-parent@example.invalid'
    checks = {}
    try:
        query(ref, 'select private.set_release_maintenance(false)')
        supabase(base + '/secrets', method='POST', data=[{'name': 'PACK99_DELIVERY_PAUSED', 'value': 'false'}])
        supabase(base + '/config/auth', method='PATCH', data={'disable_signup': True, 'external_email_enabled': True})
        wait_email_provider(origin, anon)
        # GoTrue creates new staging identities; no production Auth material is read.
        for email in (allowed, blocked):
            user = request(origin, '/auth/v1/admin/users', auth_headers, {'email': email, 'email_confirm': True})
            users.append(user['id'])
            before = query(ref, 'select now()::text as at')[0]['at']
            request(origin, '/auth/v1/otp?redirect_to=' + quote(config['staging_origin'] + '/parents', safe=''),
                {'apikey': anon}, {'email': email, 'create_user': False})
            # GoTrue can acknowledge requests without invoking a mail hook. Require
            # fresh evidence from the signed callback, including provider acceptance.
            audit = query(ref, 'select decision,provider_message_id from private.pack_staging_auth_mail_checks where recipient_sha256=' +
                literal(hashlib.sha256(email.encode()).hexdigest()) + ' and checked_at>=' + literal(before) + '::timestamptz')
            checks['auth_allowed' if email == allowed else 'auth_blocked'] = any(
                row['decision'] == ('accepted' if email == allowed else 'blocked') and
                (bool(row['provider_message_id']) if email == allowed else row['provider_message_id'] is None) for row in audit)
        snapshot_insert = '' if post_refresh else "insert into public.roster_snapshots(id,source_sha256,source_file,source_sheet,snapshot_date,expected_rows) values(" + literal(snapshot) + ',' + literal(hashlib.sha256(run.encode()).hexdigest()) + ",'synthetic safety test','Roster 2026-27',current_date,1);"
        query(ref, "begin;set local session_replication_role='replica';" + snapshot_insert +
            "insert into public.scouts(id,snapshot_id,snapshot_date,source_row,scout_name,den,source_values) select " + literal(scout) + ',' + literal(snapshot) + ",current_date,coalesce(max(source_row),1)+1,'Staging safety test','1-Tigers','{}'::jsonb from public.scouts;" +
            ''.join("insert into public.parent_scout_links(scout_id,parent_email,created_by) values(" + literal(scout) + ',' + literal(email) + ',' + literal(users[0]) + ');' for email in (allowed, blocked)) +
            ''.join("insert into private.pack_email_outbox(dedupe_key,scout_id,recipient,subject,body) values(" + literal('safety:' + run + ':' + email) + ',' + literal(scout) + ',' + literal(email) + ",'[Safety check] PackPilot staging','This is an isolated staging email safety check.');" for email in (allowed, blocked)) + 'commit;')

        def dispatch():
            issued, nonce = str(int(time.time())), str(uuid.uuid4())
            signature = hmac.new(state['dispatch_secret'].encode(), ('pack99-parent-notifications:' + issued + ':' + nonce).encode(), hashlib.sha256).hexdigest()
            return request(origin, '/functions/v1/parent-notifications', {'x-pack99-dispatch-key': issued + ':' + nonce + ':' + signature}, {})

        dispatch()
        result = query(ref, "select recipient,status,last_error,provider_message_id,attempts from private.pack_email_outbox where dedupe_key like " + literal('safety:' + run + ':%'))
        sent = next(r for r in result if r['recipient'] == allowed)
        rejected = next(r for r in result if r['recipient'] == blocked)
        checks['notification_allowed'] = sent['status'] == 'sent' and bool(sent['provider_message_id'])
        checks['notification_blocked'] = rejected['provider_message_id'] is None and rejected['last_error'] == 'Blocked by environment email policy'
        query(ref, "update private.pack_email_outbox set available_at=now() where dedupe_key=" + literal('safety:' + run + ':' + blocked))
        dispatch()
        retry = query(ref, 'select provider_message_id,last_error,attempts from private.pack_email_outbox where dedupe_key=' + literal('safety:' + run + ':' + blocked))[0]
        checks['retry_blocked'] = retry['provider_message_id'] is None and retry['last_error'] == 'Blocked by environment email policy' and retry['attempts'] > rejected['attempts']
        if not all(checks.values()):
            raise RuntimeError('Live staging email checks did not all verify')
    finally:
        # Close delivery first. Retain closed state on any failed check/cleanup.
        # Attempt every closure independently even if a management call fails.
        failures = []
        snapshot_delete = '' if post_refresh else ';delete from public.roster_snapshots where id=' + literal(snapshot)
        cleanup = "begin;set local session_replication_role='replica';truncate private.pack_staging_auth_mail_checks,private.pack_email_engagement,private.pack_email_outbox cascade;delete from public.parent_scout_links where scout_id=" + literal(scout) + ';delete from public.scouts where id=' + literal(scout) + snapshot_delete + ";set local session_replication_role='origin';" + ''.join('delete from auth.users where id=' + literal(user) + ';' for user in users) + 'commit;'
        for action in (
            lambda: supabase(base + '/secrets', method='POST', data=[{'name': 'PACK99_DELIVERY_PAUSED', 'value': 'true'}]),
            lambda: supabase(base + '/config/auth', method='PATCH', data={'disable_signup': True, 'external_email_enabled': False}),
            lambda: query(ref, cleanup),
            lambda: query(ref, 'select private.set_release_maintenance(true)'),
            lambda: wait_email_provider(origin, anon, False),
        ):
            try:
                action()
            except Exception:
                failures.append(True)
        if failures:
            raise RuntimeError('Staging cleanup/closure incomplete; administrator review required') from None
    functions = sorted([{'slug': f['slug'], 'version': f['version']} for f in supabase(base + '/functions')], key=lambda f: f['slug'])
    secrets = sorted([{'name': f['name'], 'digest': f['value']} for f in supabase(base + '/secrets')], key=lambda f: f['name'])
    if post_refresh:
        after = query(ref, 'select count(*) as scouts from public.scouts')[0]['scouts']
        if after != counts['scouts']:
            raise RuntimeError('Post-refresh verification changed copied scout records')
    receipt = {'project': ref, 'verified_at': timestamp(), 'checks': checks, 'functions': functions, 'secrets': secrets,
        'phase': 'post-refresh' if post_refresh else 'empty-staging'}
    private_json(receipt_path, receipt)
    print('Live staging Auth, notification and retry isolation verified; delivery/Auth/maintenance closed; receipt saved privately')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--send-test-inbox-mail', action='store_true', required=True)
    parser.add_argument('--post-refresh', action='store_true', help='Verify isolated mail against copied data while preserving the roster')
    args = parser.parse_args()
    try:
        verify(post_refresh=args.post_refresh)
    except Exception:
        raise SystemExit('Live isolation verification incomplete; staging must remain closed; no readiness receipt issued')
