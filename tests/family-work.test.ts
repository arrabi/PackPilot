import{test}from'node:test';import assert from'node:assert/strict';import{m2Fixture,id}from'./helpers/m2.ts';
async function fixture(){const f=await m2Fixture();await f.db.exec(`
 insert into auth.users values('${id('0',4)}','mom@example.test',now()),('${id('0',5)}','dad@example.test',now()),('${id('0',6)}','other@example.test',now());
 update public.scouts set parent_1_name='Mom',parent_1_email='mom@example.test',parent_2_name='Dad',parent_2_email='dad@example.test'where id='${id('1',1)}';
 insert into public.parent_scout_links(scout_id,parent_email,created_by)values('${id('1',1)}','mom@example.test','${id('0',1)}'),('${id('1',1)}','dad@example.test','${id('0',1)}'),('${id('1',2)}','other@example.test','${id('0',1)}');
 insert into public.pack_adventures(id,name,rank,program_version,source_url,source_verified_on,requirements,completion_groups,catalog_context,recorded_by) values('${id('4',1)}','Tiger at home','tiger','test','https://www.scouting.org/test/','2026-10-01','[{"code":"1","description":"First task"},{"code":"2","description":"Second task"}]','[]','{"adventure_type":"Required (Core)"}','${id('0',1)}');`);
 for(const n of[4,5,6])await f.asUser(n,()=>f.db.query('select public.claim_parent_links()'));
 const cmd=async(n:number,c:object,actor=1)=>(await f.asUser(actor,()=>f.db.query<{result:Record<string,unknown>}>('select public.record_family_operation($1::uuid,$2::jsonb)result',[id('9',n),JSON.stringify(c)]))).rows[0].result;
 const data=async(actor=4)=>(await f.asUser(actor,()=>f.db.query<{result:{assignments:Record<string,unknown>[];familyMessages:Record<string,unknown>[]}}> ('select public.read_parent_portal()result'))).rows[0].result;
 return{...f,cmd,data};}
const base={scout_id:id('1',1),scouting_year:'2026-27'},assign={...base,action:'assign_requirement',adventure_id:id('4',1),requirement_code:'1',assigned_on:'2026-11-01',instructions:'Practice together',due_on:'2026-11-14'};
test('family assignments require parent submission and leader approval, preserve dates and are audited/idempotent',async()=>{
 const f=await fixture();try{
 const a=await f.cmd(1,assign);assert.equal(a.status,'assigned');assert.deepEqual(await f.cmd(1,assign),a);assert.equal((await f.cmd(2,assign)).status,'already_assigned');
 const aid=a.assignment_id;
 await assert.rejects(f.cmd(3,{...base,action:'submit_assignment',assignment_id:aid,expected_revision:1,completed_on:'2026-10-31'},6),/denied/);
 const submit={...base,action:'submit_assignment',assignment_id:aid,expected_revision:1,completed_on:'2026-10-31',parent_note:'We did it'};await f.cmd(3,submit,4);
 assert.equal((await f.db.query('select * from public.pack_requirement_progress')).rows.length,0);
 await assert.rejects(f.cmd(4,submit,5),/changed/);
 const review={...base,action:'review_assignment',assignment_id:aid,expected_revision:2,decision:'approve'};
 await assert.rejects(f.cmd(4,review,4),/denied/);await assert.rejects(f.cmd(4,review,2),/denied/);
 await f.cmd(4,review);await f.cmd(4,review);
 const p=await f.db.query<{completed_date:string}>("select completed_on::text completed_date from public.pack_requirement_progress");assert.equal(p.rows[0].completed_date,'2026-10-31');assert.equal((await f.data()).assignments[0].status,'completed');
 assert.equal((await f.cmd(5,assign)).status,'already_completed');
 assert.equal((await f.db.query('select * from public.pack_commands')).rows.length,1);
 }finally{await f.db.close();}
});
test('family messages stay child scoped, verify sender role, support replies, unread state, and revoke live access',async()=>{
 const f=await fixture();try{
 const send={...base,action:'send_family_message',as_role:'leader',body:'Hello family'};await f.cmd(20,send);await f.cmd(20,send);assert.equal((await f.data()).familyMessages.length,1);assert.equal((await f.data()).familyMessages[0].unread,true);
 assert.equal((await f.data(6)).familyMessages.length,0);
 await assert.rejects(f.cmd(21,send,4),/denied/);
 await f.cmd(21,{...send,as_role:'parent',body:'Thanks!'},4);assert.equal((await f.data(5)).familyMessages.length,2);
 await f.cmd(22,{...base,action:'mark_family_read',through_message_id:id('9',21)},5);assert.ok((await f.data(5)).familyMessages.every(m=>m.unread===false));
 await f.db.exec(`update public.parent_scout_links set active=false where parent_email='mom@example.test'`);
 await assert.rejects(f.cmd(23,{...send,as_role:'parent'},4),/denied/);assert.equal((await f.data()).familyMessages.length,0);
 await assert.rejects(f.asUser(5,()=>f.db.query('select * from public.pack_family_messages')),/permission denied/);
 await f.db.exec('set role anon');await assert.rejects(f.db.query('select public.read_leader_family_work()'),/permission denied/);await f.db.exec('reset role');
 }finally{await f.db.close();}
});

test('assignment returns, cancellation and atomic batches protect history and reject invalid scope',async()=>{
 const f=await fixture();try{
 await assert.rejects(f.cmd(40,{...assign,assigned_on:'2099-01-01'}),/Invalid assignment/);
 const a=await f.cmd(40,assign);await f.cmd(41,{...base,action:'submit_assignment',assignment_id:a.assignment_id,expected_revision:1,completed_on:'2026-10-31'},4);
 await assert.rejects(f.cmd(42,{...base,action:'review_assignment',assignment_id:a.assignment_id,expected_revision:2,decision:'return'}),/Explain/);
 await f.cmd(42,{...base,action:'review_assignment',assignment_id:a.assignment_id,expected_revision:2,decision:'return',review_note:'Please revisit task 1'});
 assert.equal((await f.data()).assignments[0].status,'returned');
 await f.cmd(43,{...base,action:'submit_assignment',assignment_id:a.assignment_id,expected_revision:3,completed_on:'2026-10-30',parent_note:'Tried again'},5);
 await f.cmd(44,{...base,action:'cancel_assignment',assignment_id:a.assignment_id,expected_revision:4,review_note:'We will do this at the next meeting'});
 assert.equal((await f.data()).assignments[0].status,'cancelled');assert.equal((await f.db.query('select * from public.pack_requirement_progress')).rows.length,0);
 const entries=[{request_id:id('9',45),command:assign},{request_id:id('9',46),command:{...assign,scout_id:id('1',2)}}];
 await assert.rejects(f.asUser(1,()=>f.db.query('select public.record_family_batch($1::jsonb)',[JSON.stringify(entries)])),/valid requirement/);
 assert.equal((await f.db.query("select * from public.pack_home_assignments where status='todo'")).rows.length,0);
 await assert.rejects(f.cmd(47,{...assign,recorded_by:id('0',4)}),/Invalid family command fields/);
 }finally{await f.db.close();}
});

test('leader completion closes home work without replacing earlier completion dates',async()=>{
 const f=await fixture();try{
 const a=await f.cmd(60,assign);await f.cmd(61,{...base,action:'submit_assignment',assignment_id:a.assignment_id,expected_revision:1,completed_on:'2026-10-31'},4);
 await f.write(62,{...base,action:'record_requirement',adventure_id:id('4',1),expected_revision:0,requirement_code:'1',status:'completed',occurred_on:'2026-10-20'});
 assert.equal((await f.data()).assignments[0].status,'completed');
 await f.cmd(63,{...base,action:'review_assignment',assignment_id:a.assignment_id,expected_revision:2,decision:'approve'});
 const p=await f.db.query<{completed_date:string}>('select completed_on::text completed_date from public.pack_requirement_progress');assert.equal(p.rows[0].completed_date,'2026-10-20');
 }finally{await f.db.close();}
});
