import {test} from 'node:test';
import assert from 'node:assert/strict';
import {emailAllowed, stagingContent} from '../notifications/email-policy.ts';
import {dispatch} from '../notifications/worker.ts';
import {handleAuthEmail} from '../notifications/auth-email.ts';
import {createHmac} from 'node:crypto';

const staging = {PACK99_ENVIRONMENT:'staging', PACK99_EMAIL_ALLOWLIST:'staging@example.test', PACK99_AUTH_UI_ORIGIN:'https://staging.packpilot.example'};
test('Staging allows only the configured test address; missing configuration, mixed recipients and unknown environments fail closed',()=>{
 assert.equal(emailAllowed(staging,[' STAGING@EXAMPLE.TEST ']),true);
 for(const recipients of [[],['parent@example.test'],['staging@example.test','parent@example.test'],['staging@example.test, parent@example.test']])assert.equal(emailAllowed(staging,recipients),false);
 for(const env of [{...staging,PACK99_EMAIL_ALLOWLIST:''},{...staging,PACK99_AUTH_UI_ORIGIN:'https://packpilot.example'},{...staging,PACK99_ENVIRONMENT:'test'},{}])assert.equal(emailAllowed(env,['staging@example.test']),false);
 assert.equal(emailAllowed({SUPABASE_URL:'https://aaaaaaaaaaaaaaaaaaaa.supabase.co'},['parent@example.test']),true);
 assert.equal(emailAllowed({SUPABASE_URL:'https://abcdefghijklmnopqrst.supabase.co'},['parent@example.test']),false);
 assert.equal(stagingContent(staging,'https://packpilot.example/parents?x=1'),'https://staging.packpilot.example/parents?x=1');
});
test('Dispatcher blocks real parent notifications on every retry without redirecting addresses',async()=>{
 const saved=globalThis.fetch;const delivered:any[]=[];const recorded:any[]=[];
 globalThis.fetch=async(input,init)=>{
  const url=String(input);const body=JSON.parse(String(init?.body||'{}'));
  if(url.includes('/rest/v1/rpc/'))assert.equal(new Headers(init?.headers).get('Authorization'),'Bearer synthetic');
  if(url.endsWith('claim_parent_emails'))return Response.json([{id:'blocked',recipient:'parent@example.test',subject:'Update'},{id:'allowed',recipient:'staging@example.test',subject:'Update'}]);
  if(url.endsWith('can_send_parent_email'))return Response.json(true);
  if(url.endsWith('parent_email_context'))return Response.json({kind:'update',scout_names:[],items:[],links:{portal:'https://packpilot.example/parents'}});
  if(url.endsWith('record_parent_email_result'))recorded.push(body);
  if(url.endsWith('parent_email_delivery_pending'))return Response.json([]);
  if(url.includes('api.brevo.com')){delivered.push(body);return Response.json({messageId:'synthetic'});}
  return Response.json(null);
 };
 try{
  for(let retry=0;retry<2;retry++)await dispatch({...staging,SUPABASE_URL:'https://abcdefghijklmnopqrst.supabase.co',SUPABASE_SECRET_KEY:'synthetic',BREVO_API_KEY:'synthetic',FROM_EMAIL:'sender@example.test'});
  assert.equal(delivered.length,2);assert.ok(delivered.every(d=>d.to.length===1&&d.to[0].email==='staging@example.test'));
  assert.ok(delivered.every(d=>d.subject.startsWith('[STAGING]')&&!d.htmlContent.includes('https://packpilot.example')));
  assert.equal(recorded.filter(d=>d.email_id==='blocked'&&!d.success).length,2);
 }finally{globalThis.fetch=saved;}
});
test('Auth email requires signed payloads, blocks real parents, rejects production redirects and unsupported email changes',async()=>{
 const secret=Buffer.from('synthetic webhook signing secret').toString('base64');
 const env={...staging,SUPABASE_URL:'https://abcdefghijklmnopqrst.supabase.co',PACK99_DATABASE_KEY:'synthetic-service',AUTH_EMAIL_HOOK_SECRET:'v1,whsec_'+secret,BREVO_API_KEY:'synthetic',FROM_EMAIL:'sender@example.test'};
 const request=(email:string,redirect='https://staging.packpilot.example/parents',type='magiclink',signed=true)=>{
  const body=JSON.stringify({user:{email},email_data:{email_action_type:type,token_hash:'synthetic',redirect_to:redirect}});
  const timestamp=String(Math.floor(Date.now()/1000)),id='synthetic-hook';
  const signature=createHmac('sha256',Buffer.from(secret,'base64')).update(`${id}.${timestamp}.${body}`).digest('base64');
  return new Request('https://example.test',{method:'POST',body,headers:{'webhook-id':id,'webhook-timestamp':timestamp,'webhook-signature':signed?'v1,'+signature:'v1,bad'}});
 };
 const saved=globalThis.fetch;const sent:any[]=[];const audit:any[]=[];
 globalThis.fetch=async(input,init)=>{
  const body=JSON.parse(String(init?.body));
  if(String(input).endsWith('/record_staging_auth_mail_check')){audit.push(body);return new Response(null,{status:204});}
  sent.push(body);return Response.json({messageId:'synthetic'});
 };
 try{
  assert.equal((await handleAuthEmail(request('parent@example.test'),env)).status,200);assert.equal(sent.length,0);
  assert.equal((await handleAuthEmail(request('staging@example.test',undefined,undefined,false),env)).status,401);
  assert.equal((await handleAuthEmail(request('staging@example.test','https://packpilot.example/parents'),env)).status,400);
  assert.equal((await handleAuthEmail(request('staging@example.test',undefined,'email_change'),env)).status,400);
  assert.equal((await handleAuthEmail(request('staging@example.test'),env)).status,200);
  assert.equal(sent.length,1);assert.equal(sent[0].to[0].email,'staging@example.test');
  assert.ok(!sent[0].textContent.includes('aaaaaaaaaaaaaaaaaaaa'));
  assert.deepEqual(audit.map(row=>row.decision),['blocked','accepted']);
  assert.equal(audit[0].provider_message_id,null);assert.equal(audit[1].provider_message_id,'synthetic');
  assert.ok(audit.every(row=>/^[a-f0-9]{64}$/.test(row.recipient_sha256)&&!JSON.stringify(row).includes('@')));
  globalThis.fetch=async()=>new Response(null,{status:503});
  assert.equal((await handleAuthEmail(request('parent@example.test'),env)).status,400);
 }finally{globalThis.fetch=saved;}
});
