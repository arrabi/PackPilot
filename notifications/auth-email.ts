import {emailAllowed, stagingOrigin, type EmailPolicy} from './email-policy.ts';

interface AuthEmailEnv extends EmailPolicy {
  SUPABASE_URL: string;
  PACK99_DATABASE_KEY: string;
  AUTH_EMAIL_HOOK_SECRET: string;
  BREVO_API_KEY: string;
  FROM_EMAIL: string;
}

async function authentic(request: Request, raw: string, secret: string): Promise<boolean> {
  const id = request.headers.get('webhook-id') || '';
  const timestamp = request.headers.get('webhook-timestamp') || '';
  const age = Date.now() / 1000 - Number(timestamp);
  if (!id || !/^\d+$/.test(timestamp) || age > 300 || age < -30) return false;
  try {
    const encoded = secret.replace(/^v1,/, '').replace(/^whsec_/, '');
    const key = await crypto.subtle.importKey('raw', Uint8Array.from(atob(encoded), c => c.charCodeAt(0)), {name: 'HMAC', hash: 'SHA-256'}, false, ['verify']);
    for (const signature of (request.headers.get('webhook-signature') || '').split(' ')) {
      if (!signature.startsWith('v1,')) continue;
      const bytes = Uint8Array.from(atob(signature.slice(3)), c => c.charCodeAt(0));
      if (await crypto.subtle.verify('HMAC', key, bytes, new TextEncoder().encode(`${id}.${timestamp}.${raw}`))) return true;
    }
  } catch { return false; }
  return false;
}

export async function handleAuthEmail(request: Request, env: AuthEmailEnv): Promise<Response> {
  if (request.method !== 'POST') return new Response('Method not allowed', {status: 405});
  if (env.PACK99_ENVIRONMENT !== 'staging' || !env.AUTH_EMAIL_HOOK_SECRET ||
      !env.PACK99_DATABASE_KEY || !env.BREVO_API_KEY || !env.FROM_EMAIL || !emailAllowed(env, ['staging@example.test'])) {
    return new Response('Staging mail configuration unavailable', {status: 503});
  }
  try {
    const backend = new URL(env.SUPABASE_URL);
    if (!/^https:\/\/[a-z]{20}\.supabase\.co$/.test(backend.origin) ||
        backend.hostname === 'aaaaaaaaaaaaaaaaaaaa.supabase.co' || backend.href !== backend.origin + '/') throw Error();
  } catch { return new Response('Invalid staging backend', {status: 503}); }
  // Bound memory use before parsing an authenticated callback.
  const reader = request.body?.getReader();
  if (!reader) return new Response('Missing payload', {status: 400});
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const {value, done} = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 65536) { await reader.cancel(); return new Response('Payload too large', {status: 413}); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const raw = new TextDecoder().decode(bytes);
  if (!await authentic(request, raw, env.AUTH_EMAIL_HOOK_SECRET)) return new Response('Unauthorized', {status: 401});
  try {
    const payload = JSON.parse(raw);
    const user = payload.user, data = payload.email_data;
    if (typeof user?.email !== 'string' || !data) return new Response('Invalid payload', {status: 400});
    const record = async (decision: 'blocked' | 'accepted', messageId: string | null) => {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(user.email.trim().toLowerCase()));
      const response = await fetch(env.SUPABASE_URL + '/rest/v1/rpc/record_staging_auth_mail_check', {
        method: 'POST', headers: {apikey: env.PACK99_DATABASE_KEY, Authorization: 'Bearer ' + env.PACK99_DATABASE_KEY, 'Content-Type': 'application/json'},
        signal: AbortSignal.timeout(10000), body: JSON.stringify({webhook_id: request.headers.get('webhook-id'),
          recipient_sha256: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join(''),
          decision, provider_message_id: messageId}),
      });
      if (!response.ok) throw Error('Staging mail evidence unavailable');
    };
    // Acknowledge blocked addresses without rewriting or contacting the provider.
    if (!emailAllowed(env, [user.email])) { await record('blocked', null); return Response.json({}); }
    if (!['signup', 'invite', 'magiclink', 'recovery'].includes(data.email_action_type)) {
      return new Response('Auth mail flow is not enabled in staging', {status: 400});
    }
    if (typeof data.token_hash !== 'string' || !data.token_hash || data.token_hash.length > 1024) throw Error();
    const origin = stagingOrigin(env);
    const redirect = new URL(data.redirect_to || origin + '/parents');
    if (redirect.origin !== origin || redirect.username || redirect.password) throw Error();
    const verify = new URL(env.SUPABASE_URL + '/auth/v1/verify');
    verify.search = new URLSearchParams({token: data.token_hash, type: data.email_action_type, redirect_to: redirect.href}).toString();
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST', headers: {'api-key': env.BREVO_API_KEY, 'Content-Type': 'application/json'},
      signal: AbortSignal.timeout(20000),
      body: JSON.stringify({sender: {email: env.FROM_EMAIL, name: 'PackPilot staging'}, to: [{email: user.email}],
        subject: '[STAGING] PackPilot sign in', textContent: 'Staging access only.\n\n' + verify.href,
        headers: {idempotencyKey: request.headers.get('webhook-id')}}),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || typeof result.messageId !== 'string') return new Response('Delivery unavailable', {status: 502});
    await record('accepted', result.messageId);
    return Response.json({});
  } catch { return new Response('Invalid Auth email request', {status: 400}); }
}
