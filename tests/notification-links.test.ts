import{test}from'node:test';import assert from'node:assert/strict';import{handleNotificationLink}from'../notifications/tracking.ts';
test('Notification links never accept arbitrary redirects or credentials and recover to the login-protected portal',async()=>{
 const original=globalThis.fetch;const env={SUPABASE_URL:'https://example.test',SUPABASE_SECRET_KEY:'private-key'};let calls=0;
 globalThis.fetch=async(_url,init)=>{calls++;const body=JSON.parse(String(init?.body));assert.equal(body.target_key,'portal');return Response.json({url:'javascript:alert(1)'});};
 try{assert.equal((await handleNotificationLink(new Request('https://example.test/?t=bad&kind=clicked'),env)).status,400);assert.equal(calls,0);
 const url='https://example.test/?t=00000000-0000-4000-8000-000000000001&kind=clicked';const result=await handleNotificationLink(new Request(url),env);assert.equal(result.status,302);assert.equal(result.headers.get('location'),'https://packpilot.example/parents');assert.equal(result.headers.get('cache-control'),'no-store');assert.equal(result.headers.get('referrer-policy'),'no-referrer');
 globalThis.fetch=async()=>{throw Error('offline');};assert.equal((await handleNotificationLink(new Request(url.replace('clicked','opened')),env)).headers.get('content-type'),'image/gif');assert.equal((await handleNotificationLink(new Request(url,{method:'POST'}),env)).status,405);
 }finally{globalThis.fetch=original;}
});
