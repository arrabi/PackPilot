import type { SupabaseClient } from '@supabase/supabase-js';
import { escapePolicy as h, policyMarkdown, type PolicyStatus } from './policy-model.ts';
const pending = new WeakMap<object, Promise<void>>();
export async function requirePolicies(client: SupabaseClient): Promise<void> {
    const existing = pending.get(client);
    if (existing)
        return existing;
    const attempt = checkPolicies(client);
    pending.set(client, attempt);
    try {
        await attempt;
    }
    finally {
        pending.delete(client);
    }
}
async function checkPolicies(client: SupabaseClient) {
    const { data, error } = await client.rpc('get_site_policy_status').abortSignal(AbortSignal.timeout(15000));
    if (error)
        throw new Error('Unable to check policy acceptance. Please reload and try again.');
    const status = data as PolicyStatus;
    if (!status.eligible || status.accepted)
        return;
    await showPolicyGate(document, status, async () => {
        const { error } = await client.rpc('accept_site_policies', { policy_version: status.version, terms_hash: status.terms_hash, privacy_hash: status.privacy_hash }).abortSignal(AbortSignal.timeout(15000));
        if (error)
            throw new Error('Acceptance could not be confirmed. Please retry, or reload if the policies have changed.');
    }, async () => { const { error } = await client.auth.signOut({ scope: 'local' }); if (error)
        throw new Error('Sign-out did not complete. Please try again.'); }, callback => {
        const { data } = client.auth.onAuthStateChange(event => { if (event === 'SIGNED_OUT')
            callback(); });
        return () => data.subscription.unsubscribe();
    });
}
export function showPolicyGate(doc: Document, status: PolicyStatus, accept: () => Promise<void>, decline: () => Promise<void>, onSignOut?: (callback: () => void) => () => void): Promise<void> {
    return new Promise((resolve, reject) => {
        const overlay = doc.createElement('div');
        overlay.className = 'policy-overlay';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-labelledby', 'policy-title');
        const app = doc.getElementById('app'), wasInert = app?.inert;
        if (app)
            app.inert = true;
        overlay.innerHTML = `<section class="policy-card"><p class="eyebrow">PACKPILOT · BEFORE YOU CONTINUE</p><h1 id="policy-title" tabindex="-1">Terms of Use & Privacy Policy</h1><p>Please review and accept both documents to access your account. This applies separately to every parent and leader.</p><p><a href="/terms" target="_blank" rel="noopener noreferrer">Open Terms of Use</a> · <a href="/privacy" target="_blank" rel="noopener noreferrer">Open Privacy Policy</a></p><details><summary>Read Terms of Use</summary><article class="policy-document">${policyMarkdown(status.terms)}</article></details><details><summary>Read Privacy Policy</summary><article class="policy-document">${policyMarkdown(status.privacy)}</article></details><p class="policy-error" role="alert"></p><form><label class="policy-choice"><input type="checkbox" name="terms" required><span>I have read and agree to the Terms of Use.</span></label><label class="policy-choice"><input type="checkbox" name="privacy" required><span>I have read and agree to the Privacy Policy.</span></label><p>Allergy and medical information belongs in Active.com. Do not enter it in this website.</p><button type="submit">Accept and continue</button><button type="button" data-decline>Decline and sign out</button></form><small>Policy version ${h(status.version)}</small></section>`;
        doc.body.append(overlay);
        overlay.querySelector<HTMLElement>('#policy-title')?.focus();
        let busy = false, closed = false, unsub = () => { };
        const close = (accepted: boolean) => { if (closed)
            return; closed = true; unsub(); overlay.remove(); if (app)
            app.inert = !!wasInert; if (accepted)
            resolve();
        else
            reject(Object.assign(new Error('Policies were not accepted. Sign in again to continue.'), { code: 'POLICY_DECLINED' })); };
        const state = (value: boolean) => { busy = value; overlay.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,button').forEach(e => e.disabled = value); };
        const showError = (error: unknown) => { overlay.querySelector<HTMLElement>('[role=alert]')!.textContent = error instanceof Error ? error.message : 'Unable to save. Please retry.'; };
        overlay.querySelector('form')!.addEventListener('submit', async (e) => { e.preventDefault(); if (busy || closed)
            return; if (!overlay.querySelector<HTMLInputElement>('[name=terms]')!.checked || !overlay.querySelector<HTMLInputElement>('[name=privacy]')!.checked) {
            showError(new Error('Please accept both documents to continue.'));
            return;
        } state(true); try {
            await accept();
            close(true);
        }
        catch (e) {
            if (!closed) {
                showError(e);
                state(false);
            }
        } });
        overlay.querySelector('[data-decline]')!.addEventListener('click', async () => { if (busy || closed)
            return; state(true); try {
            await decline();
            close(false);
        }
        catch (e) {
            if (!closed) {
                showError(e);
                state(false);
            }
        } });
        overlay.addEventListener('keydown', e => { if (e.key !== 'Tab')
            return; const nodes = [...overlay.querySelectorAll<HTMLElement>('a,summary,input,button')].filter(e => !e.hasAttribute('disabled') && !e.closest('details:not([open]) article')); const first = nodes[0], last = nodes.at(-1); if (e.shiftKey && doc.activeElement === first) {
            e.preventDefault();
            last?.focus();
        }
        else if (!e.shiftKey && doc.activeElement === last) {
            e.preventDefault();
            first?.focus();
        } });
        unsub = onSignOut?.(() => close(false)) || (() => { });
    });
}
