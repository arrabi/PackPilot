import { dispatch } from './worker.ts';
type Environment = Parameters<typeof dispatch>[0] & { DISPATCH_SECRET: string };
async function reserveInvocation(env: Environment, nonce: string, issued: number): Promise<boolean> {
    const response = await fetch(env.SUPABASE_URL + '/rest/v1/rpc/reserve_parent_notification_run', {
        method: 'POST', headers: { apikey: env.SUPABASE_SECRET_KEY, Authorization: 'Bearer ' + env.SUPABASE_SECRET_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ invocation_nonce: nonce, issued_at: issued }),
    });
    if (!response.ok) throw Error('Scheduler authorization check failed');
    return await response.json() === true;
}
export async function handleDispatch(request: Request, env: Environment, run = dispatch, reserve = reserveInvocation): Promise<Response> {
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    const supplied = request.headers.get('x-pack99-dispatch-key') || '';
    const match = /^(\d{10}):([0-9a-f-]{36}):([0-9a-f]{64})$/.exec(supplied);
    if (!env.DISPATCH_SECRET || !match) return new Response('Unauthorized', { status: 401 });
    const issued = Number(match[1]), nonce = match[2], age = Date.now()/1000 - issued;
    if (age > 300 || age < -30) return new Response('Unauthorized', { status: 401 });
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', encoder.encode(env.DISPATCH_SECRET), {name:'HMAC',hash:'SHA-256'}, false, ['verify']);
    const signature = Uint8Array.from(match[3].match(/../g)!, byte => parseInt(byte,16));
    const valid = await crypto.subtle.verify('HMAC',key,signature,encoder.encode(`pack99-parent-notifications:${issued}:${nonce}`));
    if (!valid) return new Response('Unauthorized', { status: 401 });
    try {
        if (!await reserve(env,nonce,issued)) return new Response('Expired or repeated invocation', {status:409});
        const processed = await run(env);
        return Response.json({ processed });
    } catch {
        return Response.json({ error: 'Notification dispatch failed' }, { status: 500 });
    }
}
