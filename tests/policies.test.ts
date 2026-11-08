import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { m2Fixture, id } from './helpers/m2.ts';
import { showPolicyGate } from '../auth-ui/policy-gate.ts';
import { policyMarkdown, type PolicyStatus } from '../auth-ui/policy-model.ts';
import { Window } from 'happy-dom';
const healthFile = '20261102190000_remove_health_information.sql', gateFile = '20261102190100_site_policy_acceptance.sql';
async function fixture() { const f = await m2Fixture(); await f.db.exec(`insert into auth.users values('${id('0', 4)}','mom@example.test',now()),('${id('0', 5)}','dad@example.test',now());insert into public.parent_scout_links(scout_id,parent_email,created_by)values('${id('1', 1)}','mom@example.test','${id('0', 1)}'),('${id('1', 1)}','dad@example.test','${id('0', 1)}');update public.scouts set allergy='synthetic-secret',medication='synthetic-secret',source_values='{"Allergy":"synthetic-secret","__formulas":{"Medication":"synthetic-secret"},"Scout name":"Synthetic"}';`); for (const file of [healthFile, gateFile])
    await f.db.exec(await readFile(new URL('../supabase/migrations/' + file, import.meta.url), 'utf8')); const status = async (actor: number) => (await f.asUser(actor, () => f.db.query<{
    r: PolicyStatus;
}>('select public.get_site_policy_status()r'))).rows[0].r; const accept = async (actor: number, s?: PolicyStatus) => { s = s || await status(actor); return f.asUser(actor, () => f.db.query('select public.accept_site_policies($1,$2,$3)', [s!.version, s!.terms_hash, s!.privacy_hash])); }; return { ...f, status, accept }; }
test('Health removal erases dedicated fields and nested source copies; import cannot restore them', async () => { const f = await fixture(); try {
    const rows = (await f.db.query<{
        data: Record<string, unknown>;
    }>('select to_jsonb(s)data from public.scouts s')).rows;
    assert.ok(rows.every(r => !('allergy' in r.data) && !('medication' in r.data)));
    assert.ok(!JSON.stringify(rows).includes('synthetic-secret'));
    assert.match(JSON.stringify(rows), /Synthetic/);
    await assert.rejects(f.db.exec(`update public.scouts set source_values='{"nested":{"Medical condition":"secret"}}'`), /no_health_source/);
}
finally {
    await f.db.close();
} });
test('Acceptance is required for leader reads, direct RLS access and writes; it binds current document hashes to each user', async () => { const f = await fixture(); try {
    const status = await f.status(1);
    assert.equal(status.eligible, true);
    assert.equal(status.accepted, false);
    await assert.rejects(f.asUser(1, () => f.db.query('select public.read_roster_snapshot()')), /denied/);
    assert.equal((await f.asUser(1, () => f.db.query('select * from public.scouts'))).rows.length, 0);
    await assert.rejects(f.write(1, { action: 'create_activity', activity_id: id('6', 1), title: 'Test', kind: 'session', scouting_year: '2026-27', occurred_on: '2026-11-01' }), /denied/);
    await assert.rejects(f.accept(1, { ...status, terms_hash: 'forged' }), /changed/);
    await f.accept(1);
    await f.accept(1);
    assert.equal((await f.status(1)).accepted, true);
    assert.equal((await f.status(2)).accepted, false);
    assert.equal((await f.asUser(1, () => f.db.query('select public.read_roster_snapshot()'))).rows.length, 1);
    assert.equal((await f.db.query('select * from private.site_policy_acceptances')).rows.length, 1);
    await assert.rejects(f.asUser(1, () => f.db.query('delete from private.site_policy_acceptances')), /permission denied/);
    await assert.rejects(f.accept(3), /required/);
    await f.db.exec("update private.site_policy_versions set terms_hash='changed'");
    assert.equal((await f.status(1)).accepted, false);
    await assert.rejects(f.asUser(1, () => f.db.query('select public.read_roster_snapshot()')), /denied/);
}
finally {
    await f.db.close();
} });
test('Each parent must accept separately; acceptance grants no leader privileges and respects family revocation', async () => { const f = await fixture(); try {
    assert.equal((await f.status(4)).eligible, true);
    await assert.rejects(f.asUser(4, () => f.db.query('select public.claim_parent_links()')), /Accept/);
    await f.accept(4);
    await f.asUser(4, () => f.db.query('select public.claim_parent_links()'));
    const data = (await f.asUser(4, () => f.db.query<{
        r: {
            scouts: unknown[];
        };
    }>('select public.read_parent_portal()r'))).rows[0].r;
    assert.equal(data.scouts.length, 1);
    await assert.rejects(f.asUser(4, () => f.db.query('select public.read_roster_snapshot()')), /denied/);
    assert.equal((await f.status(5)).accepted, false);
    await f.db.exec(`update public.parent_scout_links set active=false where parent_email='mom@example.test'`);
    const revoked = (await f.asUser(4, () => f.db.query<{
        r: {
            scouts: unknown[];
        };
    }>('select public.read_parent_portal()r'))).rows[0].r;
    assert.equal(revoked.scouts.length, 0);
    await f.db.exec('set role anon');
    await assert.rejects(f.db.query('select public.get_site_policy_status()'), /permission denied/);
    await f.db.exec('reset role');
}
finally {
    await f.db.close();
} });
const status: PolicyStatus = { eligible: true, accepted: false, version: 'test', terms_hash: 't', privacy_hash: 'p', terms: '# Terms\n\nText', privacy: '# Privacy\n\nText' };
test('Policy gate requires both unchecked agreements, retains choices after failure, and closes only after acceptance succeeds', async () => { const win = new Window(), doc = win.document; doc.body.innerHTML = '<div id="app">Private content</div>'; let calls = 0; const result = showPolicyGate(doc as unknown as Document, status, async () => { calls++; if (calls === 1)
    throw Error('Retry safely'); }, async () => { }); try {
    const overlay = doc.querySelector('.policy-overlay')!;
    assert.equal(overlay.querySelectorAll('input:checked').length, 0);
    const form = overlay.querySelector('form')!;
    form.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 0));
    assert.equal(calls, 0);
    overlay.querySelectorAll('input').forEach(el => (el as unknown as HTMLInputElement).checked = true);
    form.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 0));
    assert.match(overlay.textContent, /Retry safely/);
    assert.equal(overlay.querySelectorAll('input:checked').length, 2);
    form.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
    await result;
    assert.equal(doc.querySelector('.policy-overlay'), null);
    assert.equal((doc.getElementById('app')! as unknown as HTMLElement).inert, false);
}
finally {
    await win.happyDOM.close();
} });
test('Declining signs out and never records acceptance; policy markdown cannot inject executable HTML', async () => { const win = new Window(); let saved = 0, signedOut = 0; const result = showPolicyGate(win.document as unknown as Document, status, async () => { saved++; }, async () => { signedOut++; }); const rejection = assert.rejects(result, /not accepted/); win.document.querySelector('[data-decline]')!.dispatchEvent(new win.MouseEvent('click', { bubbles: true })); await rejection; assert.equal(saved, 0); assert.equal(signedOut, 1); assert.match(policyMarkdown('<img src=x onerror=alert(1)>'), /&lt;img/); assert.ok(!policyMarkdown('[bad](javascript:alert(1))').includes('href="javascript:')); await win.happyDOM.close(); });
test('Sign-out while saving acceptance removes the gate and a late response cannot restore access', async () => { const win = new Window(); let signedOut = () => { }; let finish!: () => void; const result = showPolicyGate(win.document as unknown as Document, status, () => new Promise<void>(r => finish = r), async () => { }, callback => { signedOut = callback; return () => { }; }); const rejected = assert.rejects(result, /not accepted/); win.document.querySelectorAll('input').forEach(el => (el as unknown as HTMLInputElement).checked = true); win.document.querySelector('form')!.dispatchEvent(new win.Event('submit', { cancelable: true, bubbles: true })); signedOut(); await rejected; finish(); await new Promise(r => setTimeout(r, 0)); assert.equal(win.document.querySelector('.policy-overlay'), null); await win.happyDOM.close(); });
