import{test}from'node:test';import assert from'node:assert/strict';import{backlogFixture}from'./helpers/backlog.ts';import{id}from'./helpers/m2.ts';
const extra=['20261102211000_admin_exports_retention.sql'];
test('Admin retention and deletion guards, real receipt deadlines, renewal carry-forward and safe destructive retries',async()=>{
 const f=await backlogFixture(extra);const cmd=(n:number,c:object,actor=1)=>f.asUser(actor,()=>f.db.query('select public.record_pack_admin($1,$2)',[id('6',n),c]));
 try{
  for(const actor of[2,4,6])await assert.rejects(f.asUser(actor,()=>f.db.query('select public.read_pack_admin()')),/administrator/);
  await assert.rejects(cmd(1,{action:'retention',scout_id:id('1',1),scouting_year:'2026-27',year_end:'2027-06-30',deletion_due:'2027-07-01'}),/check constraint/);
  await cmd(1,{action:'retention',scout_id:id('1',1),scouting_year:'2026-27',year_end:'2027-06-30',deletion_due:'2027-09-30'});
  await f.db.exec(`insert into public.pack_registrations values('${id('1',1)}','2027-28','scouting.org','confirmed','2027-08-01',1,now(),'${id('0',1)}')`);
  const retention=(await f.db.query<{r:any}>('select to_jsonb(r)r from private.pack_retention r where scout_id=$1',[id('1',1)])).rows[0].r;
  assert.equal(retention.final_registered_year,'2027-28');assert.equal(retention.deletion_due,null);
  await cmd(2,{action:'deletion_request',id:id('7',50),scout_id:id('1',1),requester_email:'mom@example.test',received_on:'2026-11-01',scope:'all',verified:true});
  assert.equal((await f.db.query<{due_on:string}>('select due_on::text due_on from private.pack_deletion_requests')).rows[0].due_on,'2026-12-01');
  await assert.rejects(cmd(3,{action:'delete_scout',id:id('7',50),scout_id:id('1',1),confirm_name:'Wrong'}),/exact scout name/);
  const deletion={action:'delete_scout',id:id('7',50),scout_id:id('1',1),confirm_name:'First Synthetic'};
  await cmd(3,deletion);await cmd(3,deletion);
  assert.equal((await f.db.query('select * from public.scouts')).rows.length,1);
  assert.equal((await f.db.query<{n:number}>('select expected_rows n from public.roster_snapshots')).rows[0].n,1);
  assert.equal((await f.db.query('select * from private.pack_change_log where scout_id=$1',[id('1',1)])).rows.length,0);
  await assert.rejects(cmd(4,{action:'update_request',id:id('7',50),status:'completed'}),/remaining cleanup/);
  await cmd(4,{action:'update_request',id:id('7',50),status:'completed',verified:true,provider_cleanup:true,backup_cleanup:true,source_cleanup:true,identity_cleanup:true});
  const request=(await f.db.query<{r:any}>('select to_jsonb(r)r from private.pack_deletion_requests r')).rows[0].r;assert.equal(request.requester_email,'removed');assert.equal(request.status,'completed');
  assert.equal((await f.db.query("select * from private.pack_change_log where table_name='pack_deletion_requests'")).rows.length,0);
 }finally{await f.db.close();}
});
test('Private exports are family-scoped, exclude planning and notes, expire, notify the admin once and preserve other families',async()=>{
 const f=await backlogFixture(extra);try{
  await f.command(21,{action:'meeting',id:id('7',21),date:'2027-05-12',den:'1-Tigers',agenda:'INTERNAL-NOT-EXPORTED',requirements:[],revision:0});
  const prepare=(n:number,children:string[]|null=null,actor=4)=>f.asUser(actor,()=>f.db.query<{r:any}>('select public.prepare_pack_export($1,$2,$3)r',[id('6',n),children,'family']));
  await assert.rejects(prepare(21,[id('1',2)]),/scope denied/);
  const exported=(await prepare(22)).rows[0].r;assert.equal(exported.scouts.length,1);assert.ok(!JSON.stringify(exported).includes('INTERNAL-NOT-EXPORTED'));assert.ok(!('meetings'in exported));
  await prepare(22);assert.equal((await f.db.query("select * from private.pack_email_outbox where audience='admin'")).rows.length,1);
  await assert.rejects(f.asUser(6,()=>f.db.query('select public.record_pack_export_download($1)',[id('6',22)])),/unavailable/);
  await f.asUser(4,()=>f.db.query('select public.record_pack_export_download($1)',[id('6',22)]));
  await f.db.exec(`update private.pack_export_runs set expires_at=now()-interval '1 second'`);await assert.rejects(prepare(22),/expired/);
 }finally{await f.db.close();}
});
test('A parent-only exclusion preserves the other guardian and scout advancement; removal cannot be marked done without its action',async()=>{
 const f=await backlogFixture(extra);const cmd=(n:number,c:object)=>f.asUser(1,()=>f.db.query('select public.record_pack_admin($1,$2)',[id('6',n),c]));try{
  await f.db.exec(`insert into private.pack_portal_visits(user_id,visit_date)values('${id('0',4)}',current_date),('${id('0',5)}',current_date)`);
  await cmd(61,{action:'deletion_request',id:id('7',61),scout_id:id('1',1),requester_email:'mom@example.test',received_on:'2026-11-01',scope:'parent_access',verified:true});
  await assert.rejects(cmd(62,{action:'update_request',id:id('7',61),status:'app_removed'}),/confirmed removal action/);
  await assert.rejects(cmd(63,{action:'delete_extras',id:id('7',61),scout_id:id('1',1),confirm_name:'First Synthetic'}),/match.*scope/);
  await cmd(64,{action:'exclude_parent',id:id('7',61),scout_id:id('1',1),confirm_name:'First Synthetic',email:'mom@example.test'});
  assert.equal((await f.db.query('select * from public.scouts')).rows.length,2);assert.equal((await f.db.query('select * from public.parent_scout_links where scout_id=$1',[id('1',1)])).rows.length,1);
  assert.equal((await f.db.query('select * from private.pack_portal_visits where user_id=$1',[id('0',4)])).rows.length,0);assert.equal((await f.db.query('select * from private.pack_portal_visits where user_id=$1',[id('0',5)])).rows.length,1);
  await assert.rejects(f.asUser(4,()=>f.db.query('select public.prepare_pack_export($1)',[id('6',65)])),/Family access/);
  assert.equal((await f.asUser(5,()=>f.db.query<{r:any}>('select public.prepare_pack_export($1)r',[id('6',66)]))).rows[0].r.scouts.length,1);
 }finally{await f.db.close();}
});
