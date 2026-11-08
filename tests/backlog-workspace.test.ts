import{test}from'node:test';import assert from'node:assert/strict';import{backlogFixture}from'./helpers/backlog.ts';import{id}from'./helpers/m2.ts';
const extra=['20261102211000_admin_exports_retention.sql','20261102212000_friendly_notifications_engagement.sql','20261102213000_workspace_views.sql','20261102214000_engagement_policy_version.sql','20261102215000_backlog_guard_refinements.sql'];
test('Each workspace enforces adult/admin boundaries, excludes internal payloads from parents and supplies per-value attribution',async()=>{
 const f=await backlogFixture(extra);try{
  await f.command(1,{action:'meeting',id:id('7',1),date:'2027-05-12',den:'1-Tigers',agenda:'INTERNAL PLANNING',requirements:[],revision:0});
  await f.command(2,{action:'event',id:id('7',2),title:'Den meeting',event_type:'den_meeting',date:'2027-05-12',den:'1-Tigers',location:'MAPS',details:'Bring a water bottle',mode:'none',revision:0});
  const read=(view:string,actor=4)=>f.asUser(actor,()=>f.db.query<{r:any}>('select public.read_pack_workspace($1,$2,$3)r',[view,actor>=4,'2026-27']));
  for(const view of['events','calendar','images']){const result=(await read(view)).rows[0].r;assert.ok(!JSON.stringify(result).includes('INTERNAL PLANNING'));assert.equal(result.meetings.length,0);}
  for(const view of['planner','notes','history','admin'])await assert.rejects(read(view),/leader|Administrator/);
  await assert.rejects(read('admin',2),/Administrator/);
  const leader=(await read('events',1)).rows[0].r;assert.ok(leader.attribution.some((v:any)=>v.field==='event_type'&&v.value==='den_meeting'));
  assert.equal((await read('planner',1)).rows[0].r.meetings[0].agenda,'INTERNAL PLANNING');
  await f.asUser(4,()=>f.db.query('select public.record_parent_portal_visit()'));await f.asUser(4,()=>f.db.query('select public.record_parent_portal_visit()'));
  assert.equal((await f.db.query('select * from private.pack_portal_visits')).rows.length,1);
 }finally{await f.db.close();}
});
test('Tracking is scoped to a sent mail, requires current policy acceptance and honors revocation and suppression',async()=>{
 const f=await backlogFixture(extra);try{
  await f.db.exec(`insert into public.pack_family_messages values('${id('9',1)}','${id('1',1)}','2026-27','Hello','leader','Leader','${id('0',1)}',now())`);
  const mails=(await f.db.query<{r:any[]}>('select public.claim_parent_emails()r')).rows[0].r;
  const mail=mails.find(q=>q.recipient==='mom@example.test');
  const context=(await f.db.query<{r:any}>('select public.parent_email_context($1)r',[mail.id])).rows[0].r;assert.ok(context.tracking_token);
  await f.db.query('select public.record_parent_email_result($1,true,$2,$3)',[mail.id,'','provider-id']);
  const track=()=>f.db.query<{r:any}>('select public.track_parent_email($1,$2,$3,false)r',[context.tracking_token,'clicked','portal']);
  assert.equal((await track()).rows[0].r.tracked,true);await track();assert.equal((await f.db.query('select * from private.pack_email_engagement')).rows.length,1);
  await assert.rejects(f.asUser(4,()=>f.db.query('select public.track_parent_email($1,$2,$3,false)',[context.tracking_token,'clicked','portal'])),/permission denied/);
  await f.asUser(1,()=>f.db.query('select public.set_pack_email_preference($1,$2,true)',[id('6',1),'mom@example.test']));assert.equal((await track()).rows[0].r.tracked,false);
  const admin=(await f.asUser(1,()=>f.db.query<{r:any}>('select public.read_pack_admin()r'))).rows[0].r;assert.ok(admin.tracking_started);assert.ok(admin.emails.length);
 }finally{await f.db.close();}
});
