import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {usabilityFixture} from './helpers/usability.ts';
import {id} from './helpers/m2.ts';
import {recordOperationSchema} from '../supabase/functions/_shared/operations.ts';
import {renderAccess} from '../auth-ui/access-ui.ts';
const migration=new URL('../supabase/migrations/20261104010000_progress_notification_choice.sql',import.meta.url);
const base={scout_id:id('1',1),scouting_year:'2026-27',adventure_id:id('4',1)};
const assign={...base,action:'assign_requirement',requirement_code:'1',assigned_on:'2026-11-01',instructions:'Practice together'};
const award={...base,action:'earn_adventure',occurred_on:'2026-11-01',expected_revision:0};
async function fixture(){
 const f=await usabilityFixture();
 await f.db.exec(await readFile(migration,'utf8'));
 await f.db.query(`insert into public.pack_adventures(id,name,rank,program_version,source_url,source_verified_on,requirements,completion_groups,recorded_by)values($1,'Tiger at home','tiger','test','https://www.scouting.org/test/','2026-10-01','[{"code":"1","description":"Practice"},{"code":"2","description":"Discuss"}]','[]',$2)`,[id('4',1),id('0',1)]);
 const op=async(n:number,c:object,channel='pack',actor=1)=>(await f.asUser(actor,()=>f.db.query<{r:any}>(`select public.record_${channel}_operation($1,$2)r`,[id('9',n),c]))).rows[0].r;
 const outbox=async()=>(await f.db.query<any>('select * from private.pack_email_outbox order by dedupe_key')).rows;
 return{...f,op,outbox};
}
test('silent homework is saved and audited once, survives retry, and remains in Saturday reminders',async()=>{
 const f=await fixture();try{
  const c={...assign,notify_parents:false},r=await f.op(1,c,'family');
  assert.equal(r.status,'assigned');assert.equal(r.notifications_queued,0);assert.equal(r.notify_parents,false);
  assert.equal((await f.outbox()).length,0);assert.deepEqual(await f.op(1,c,'family'),r);
  await assert.rejects(f.op(1,{...c,notify_parents:true},'family'),/Request ID conflict/);
  const rows=(await f.db.query<any>("select * from private.pack_change_log where action='NOTIFICATION_CHOICE'")).rows;
  assert.equal(rows.length,1);assert.equal(rows[0].changes.notify_parents.after,false);
  assert.equal((await f.db.query("select * from public.pack_home_assignments")).rows.length,1);
  await f.db.query(`select public.prepare_parent_reminders('2026-11-07T16:05:00Z')`);
  const emails=await f.outbox();assert.ok(emails.some(q=>q.recipient==='mom@example.test'&&JSON.stringify(q.content).includes('Tiger at home')));
  assert.ok(emails.every(q=>!q.dedupe_key.startsWith('homework:')));
 }finally{await f.db.close();}
});
test('default notifications, silent awards and badge handouts preserve existing types and opt-outs',async()=>{
 const f=await fixture();try{
  const a=await f.op(1,assign,'family');assert.equal(a.notifications_queued,2);assert.equal(a.notify_parents,true);
  assert.deepEqual(await f.op(1,{...assign,notify_parents:true},'family'),a);
  const silent=await f.op(2,{...award,notify_parents:false});assert.equal(silent.notifications_queued,0);
  assert.equal((await f.outbox()).filter(q=>q.dedupe_key.startsWith('earned:')).length,0);
  const badge=await f.op(3,{...base,action:'deliver_badge',badge_form:'belt_loop',occurred_on:'2026-11-02',expected_revision:1});
  assert.equal(badge.notifications_queued,2);
  assert.deepEqual(await f.op(3,{...base,action:'deliver_badge',badge_form:'belt_loop',occurred_on:'2026-11-02',expected_revision:1}),badge);
  assert.equal((await f.outbox()).filter(q=>q.dedupe_key.startsWith('badge:')).length,2);
 }finally{await f.db.close();}
 const g=await fixture();try{
  await g.db.exec(`insert into private.pack_email_preferences(email,suppressed,changed_by)values('mom@example.test',true,'${id('0',1)}')`);
  const r=await g.op(4,award);assert.equal(r.notifications_queued,1);assert.equal((await g.outbox())[0].recipient,'dad@example.test');
 }finally{await g.db.close();}
});
test('notification choices validate server-side, preserve permissions and restore context after failure and batches',async()=>{
 const f=await fixture();try{
  for(const notify_parents of ['false',null,0])await assert.rejects(f.op(1,{...assign,notify_parents},'family'),/boolean/);
  await assert.rejects(f.op(1,{...assign,notify_parents:false},'family',4),/denied/);
  await assert.rejects(f.op(1,{...award,notify_parents:false},'pack',2),/denied/);
  await assert.rejects(f.op(1,{...award,expected_revision:99,notify_parents:false}),/changed|revision/i);
  const context=await f.db.query<any>("select current_setting('pack99.notification_request',true)r");assert.ok(!context.rows[0].r);
  await f.asUser(1,()=>f.db.query(`select public.record_family_batch($1)`,[[{request_id:id('9',2),command:{...assign,notify_parents:false}},{request_id:id('9',3),command:{...assign,requirement_code:'2'}}]]));
  const emails=await f.outbox();assert.equal(emails.length,2);assert.ok(emails.every(q=>q.notification_request_id===id('9',3)));
  await assert.rejects(f.asUser(4,()=>f.db.query('select * from private.pack_notification_choices')),/permission denied/);
  await assert.rejects(f.asUser(1,()=>f.db.query('select private.record_family_before_notification_choice($1,$2)',[id('9',8),assign])),/permission denied/);
  await assert.rejects(f.op(4,{...base,action:'revoke_adventure',occurred_on:'2026-11-01',expected_revision:0,reason:'Correction',notify_parents:false}),/unavailable/);
  const r=await f.op(5,{...base,action:'record_requirement',requirement_code:'1',status:'completed',occurred_on:'2026-11-01',expected_revision:0,notify_parents:true});assert.equal(r.notifications_queued,0);
 }finally{await f.db.close();}
});
test('notification choice keeps strict command schemas and contacts never grant a second login',async()=>{
 const parsed=recordOperationSchema.parse({request_id:id('9',1),command:{...award,notify_parents:false}});assert.equal(parsed.command.action==='earn_adventure'&&parsed.command.notify_parents,false);
 assert.throws(()=>recordOperationSchema.parse({request_id:id('9',1),command:{...award,notify_parents:'false'}}));
 const f=await fixture();try{
  await f.db.query(`update public.leader_access set display_name='Test Leader',assigned_den='5-AOL',default_den='AOL',contact_emails=array['reader@example.test','alias@example.test']where email='reader@example.test'`);
  const data=await f.asUser(1,async()=>(await f.db.query<any>('select public.read_pack_access()r')).rows[0].r);
  const l=data.leaders.find((l:any)=>l.email==='reader@example.test');assert.equal(l.display_name,'Test Leader');assert.equal(l.contact_emails.length,2);
  assert.match(renderAccess(data,'2026-27'),/Assigned den: AOL/);assert.match(renderAccess(data,'2026-27'),/alias@example.test/);
  assert.equal((await f.db.query("select * from public.leader_access where email='alias@example.test'")).rows.length,0);
 }finally{await f.db.close();}
});
test('legacy retries cannot change the email choice and revoked recorders cannot reuse a receipt',async()=>{
 const f=await fixture();try{
  await f.db.query("select set_config('request.jwt.claim.sub',$1,false)",[id('0',1)]);
  await f.db.query('select private.record_family_before_notification_choice($1,$2)',[id('9',90),assign]);
  await f.db.query("select set_config('request.jwt.claim.sub','',false)");
  await assert.rejects(f.op(90,{...assign,notify_parents:false},'family'),/Request ID conflict/);
  assert.equal((await f.op(90,assign,'family')).notifications_queued,0);
  await f.db.exec(`update public.leader_access set active=false where email='admin@example.test'`);
  await assert.rejects(f.op(90,assign,'family'),/denied/);
 }finally{await f.db.close();}
});
