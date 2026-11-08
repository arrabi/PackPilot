import{test}from'node:test';import assert from'node:assert/strict';import{renderPackEmail}from'../notifications/template.ts';import{backlogFixture}from'./helpers/backlog.ts';import{id}from'./helpers/m2.ts';
const extra=['20261102211000_admin_exports_retention.sql','20261102212000_friendly_notifications_engagement.sql'];
test('Friendly email explains actions, escapes names, omits unset deadlines and uses the shared footer',()=>{
 const email=renderPackEmail({kind:'reminder',parent_name:'Parent <safe>',scout_names:['Adam','Yousef'],links:{portal:'https://legacy.packpilot.example/parents',survey:'https://example.test/skills-survey','item-0':'https://www.scouting.org/test'},items:[{kind:'homework',scout_name:'Adam',adventure:'Outdoor',requirement:'1',due_on:null},{kind:'volunteer',title:'Salads',remaining:2,instructions:'Bring <salad>'}]},'https://example.test/track');
 assert.match(email.text,/^Salamu Alaikum/);assert.match(email.text,/parent of Adam and Yousef/);assert.match(email.text,/send for review/);assert.ok(!email.text.includes('complete it by'));assert.match(email.text,/unsubscribe.*contact@example.test/);assert.match(email.html,/Parent &lt;safe&gt;/);assert.ok(!email.html.includes('Parent <safe>'));assert.match(email.html,/parents-skills survey/);
});
test('Manual reminders are admin-only, idempotent, include available volunteer roles and leave Saturday scheduling untouched',async()=>{
 const f=await backlogFixture(extra);try{
  await f.db.exec('create function private.invoke_parent_notification_dispatch()returns bigint language sql as $$select 1::bigint$$');
  await f.command(40,{action:'job',id:id('7',40),title:'Salads',capacity:2});
  await assert.rejects(f.asUser(4,()=>f.db.query('select public.send_parent_reminders_now($1)',[id('6',40)])),/Administrator/);
  const send=()=>f.asUser(1,()=>f.db.query<{r:any}>('select public.send_parent_reminders_now($1)r',[id('6',40)]));
  assert.equal((await send()).rows[0].r.recipient_count,3);await send();
  const queue=await f.db.query<{content:any}>('select content from private.pack_email_outbox where batch_id=$1',[id('6',40)]);assert.equal(queue.rows.length,3);assert.ok(queue.rows.every(r=>r.content.items.some((i:any)=>i.kind==='volunteer')));
  assert.equal((await f.db.query('select * from private.pack_reminder_runs')).rows.length,0);
  await f.asUser(1,()=>f.db.query('select public.set_pack_email_preference($1,$2,true)',[id('6',41),'mom@example.test']));
  const claimed=(await f.db.query<{r:any[]}>('select public.claim_parent_emails()r')).rows[0].r;assert.ok(!claimed.some(q=>q.recipient==='mom@example.test'));
 }finally{await f.db.close();}
});
