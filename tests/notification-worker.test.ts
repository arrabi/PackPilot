import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatch } from '../notifications/worker.ts';
test('Release pause stops notification generation, claims, retries and provider reconciliation',async()=>{
 const original=globalThis.fetch;
 globalThis.fetch=async()=>{throw Error('Paused dispatcher must not make any network request');};
 try{
  assert.equal(await dispatch({SUPABASE_URL:'https://aaaaaaaaaaaaaaaaaaaa.supabase.co',SUPABASE_SECRET_KEY:'synthetic',BREVO_API_KEY:'synthetic',FROM_EMAIL:'sender@example.invalid',PACK99_DELIVERY_PAUSED:'true'}),0);
 }finally{globalThis.fetch=original;}
});
test('Dispatcher sends separate messages with stable provider retry key and records failures without leaking message content', async () => { const saved = globalThis.fetch, calls: {
    url: string;
    body: any;
}[] = []; globalThis.fetch = async (input, init) => { const url = String(input), body = JSON.parse(String(init?.body || '{}')); calls.push({ url, body }); if (url.endsWith('claim_parent_emails'))
    return Response.json([{ id: 'one', recipient: 'mom@example.test', subject: 'Homework', body: 'Portal link' }, { id: 'two', recipient: 'dad@example.test', subject: 'Homework', body: 'Portal link' }, {id:'suppressed', recipient:'off@example.test',subject:'No mail',body:'Hidden'}]); if (url.endsWith('can_send_parent_email')) return Response.json(body.email_id !== 'suppressed'); if(url.endsWith('parent_email_context'))return Response.json({kind:'homework',parent_name:'Test parent',scout_names:['Test scout'],items:[{kind:'update',text:'Homework assigned'}],links:{portal:'https://example.test/parents',survey:'https://example.test/survey'}});if(url.endsWith('parent_email_delivery_pending'))return Response.json([]);if (url.includes('brevo'))
    return Response.json(body.to[0].email.startsWith('mom')?{messageId:'provider-one'}:{code:'rate_limit'}, { status: body.to[0].email.startsWith('mom') ? 201 : 429 }); return Response.json(null); }; try {
    assert.equal(await dispatch({ SUPABASE_URL: 'https://aaaaaaaaaaaaaaaaaaaa.supabase.co', SUPABASE_SECRET_KEY: 'test', BREVO_API_KEY: 'test', FROM_EMAIL: 'sender@example.test' }), 3);
    const sent = calls.filter(c => c.url.includes('brevo'));
    assert.equal(sent.length, 2);
    assert.equal(sent[0].body.replyTo.email, 'contact@example.test');
    assert.match(sent[0].body.textContent, /To unsubscribe from PackPilot notification emails at this address, please email contact@example.test\./);
    assert.equal(sent[0].body.to.length, 1);
    assert.equal(sent[0].body.headers.idempotencyKey, 'one');
    assert.deepEqual(calls.filter(c => c.url.endsWith('record_parent_email_result')).map(c => c.body.success), [true, false]);
}
finally {
    globalThis.fetch = saved;
} });
test('Scheduled endpoint validates short-lived HMAC proofs, reserves one-use nonces and hides failures',async()=>{
 const {handleDispatch}=await import('../notifications/handler.ts');
 const {createHmac,randomUUID}=await import('node:crypto');
 const env={SUPABASE_URL:'https://aaaaaaaaaaaaaaaaaaaa.supabase.co',SUPABASE_SECRET_KEY:'database-secret',BREVO_API_KEY:'provider-secret',FROM_EMAIL:'sender@example.test',DISPATCH_SECRET:'scheduler-secret'};
 let calls=0, used=false;
 const run=async()=>{calls++;return 0;};
 const reserve=async()=>{if(used)return false;used=true;return true;};
 assert.equal((await handleDispatch(new Request('https://example.test'),env,run,reserve)).status,405);
 const request=(key:string)=>new Request('https://example.test',{method:'POST',headers:{'x-pack99-dispatch-key':key}});
 for(const key of ['', 'wrong'])assert.equal((await handleDispatch(request(key),env,run,reserve)).status,401);
 const proof=(age=0,secret=env.DISPATCH_SECRET)=>{const issued=Math.floor(Date.now()/1000)-age,nonce=randomUUID();return `${issued}:${nonce}:`+createHmac('sha256',secret).update(`pack99-parent-notifications:${issued}:${nonce}`).digest('hex');};
 assert.equal((await handleDispatch(request(proof(600)),env,run,reserve)).status,401);
 assert.equal((await handleDispatch(request(proof(0,'wrong')),env,run,reserve)).status,401);
 assert.equal(calls,0);
 const signed=proof();
 const result=await handleDispatch(request(signed),env,run,reserve);
 assert.equal(result.status,200);assert.deepEqual(await result.json(),{processed:0});assert.equal(calls,1);
 assert.equal((await handleDispatch(request(signed),env,run,reserve)).status,409);assert.equal(calls,1);
 const failure=await handleDispatch(request(proof()),env,async()=>{throw Error('provider-secret private data');},async()=>true);
 assert.equal(failure.status,500);assert.deepEqual(await failure.json(),{error:'Notification dispatch failed'});
});
test('An HTTP success without a provider message ID remains a retryable delivery failure',async()=>{
 const original=globalThis.fetch;let result:any;
 globalThis.fetch=async(input,init)=>{const url=String(input);if(url.endsWith('claim_parent_emails'))return Response.json([{id:'one',recipient:'parent@example.test',subject:'Update',body:''}]);if(url.endsWith('can_send_parent_email'))return Response.json(true);if(url.endsWith('parent_email_context'))return Response.json({kind:'update',parent_name:'Parent',scout_names:['Scout'],items:[],links:{portal:'https://example.test/parents',survey:'https://example.test/survey'}});if(url.endsWith('record_parent_email_result'))result=JSON.parse(String(init?.body));if(url.endsWith('parent_email_delivery_pending'))return Response.json([]);return Response.json({});};
 try{await dispatch({SUPABASE_URL:'https://aaaaaaaaaaaaaaaaaaaa.supabase.co',SUPABASE_SECRET_KEY:'private',BREVO_API_KEY:'private',FROM_EMAIL:'sender@example.test'});assert.equal(result.success,false);assert.equal(result.message_id,null);assert.match(result.error_text,/no delivery reference/);}finally{globalThis.fetch=original;}
});
