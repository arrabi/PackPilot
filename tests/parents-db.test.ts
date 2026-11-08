import {test} from 'node:test';import assert from 'node:assert/strict';import {m2Fixture,id} from './helpers/m2.ts';
test('parents claim only confirmed roster-approved emails and can read only linked active children',async()=>{
 const f=await m2Fixture();try{
 await f.db.exec(`insert into auth.users values('${id('0',4)}','mom.name+pack@gmail.com',now()),('${id('0',5)}','dad@example.test',now()),('${id('0',6)}','other@example.test',now()),('${id('0',7)}','pending@example.test',null),('${id('0',8)}','momname@gmail.com',now());
 insert into public.parent_scout_links(scout_id,parent_email,created_by)values('${id('1',1)}','mom.name@gmail.com','${id('0',1)}'),('${id('1',2)}','momname+family@googlemail.com','${id('0',1)}'),('${id('1',1)}','dad@example.test','${id('0',1)}'),('${id('1',2)}','pending@example.test','${id('0',1)}');
 update public.scouts set bsa_member_id='012345678',parent_1_name='Private parent contact',allergy='Private medical note' where id='${id('1',1)}';`);
 await f.db.exec(`insert into public.pack_adventures(id,name,rank,program_version,source_url,source_verified_on,requirements,completion_groups,catalog_context,recorded_by) values('${id('4',1)}','Tiger Synthetic','tiger','test','https://www.scouting.org/test/','2026-10-01','[{"code":"1","description":"Task"}]','[]','{"adventure_type":"Required (Core)"}','${id('0',1)}'),('${id('4',2)}','Lion Synthetic','lion','test','https://www.scouting.org/test/','2026-10-01','[{"code":"1","description":"Task"}]','[]','{"adventure_type":"Required (Core)"}','${id('0',1)}');
 insert into public.pack_advancement(scout_id,adventure_id,scouting_year,revision,earned_on,recorded_by) values('${id('1',1)}','${id('4',1)}','2026-27',1,'2026-10-14','${id('0',1)}'),('${id('1',2)}','${id('4',2)}','2026-27',1,'2026-10-14','${id('0',1)}'),('${id('1',1)}','${id('4',1)}','2025-26',1,'2026-04-14','${id('0',1)}');
 insert into public.pack_requirement_progress(scout_id,adventure_id,scouting_year,requirement_code,completed_on,completion_source,recorded_by) values('${id('1',1)}','${id('4',1)}','2026-27','1','2026-10-14','award','${id('0',1)}'),('${id('1',2)}','${id('4',2)}','2026-27','1','2026-10-14','award','${id('0',1)}');
 insert into public.pack_registrations(scout_id,platform,scouting_year,status,occurred_on,revision,recorded_by) values('${id('1',1)}','scouting.org','2026-27','confirmed','2026-10-14',1,'${id('0',1)}'),('${id('1',2)}','scouting.org','2026-27','confirmed','2026-10-14',1,'${id('0',1)}');`);
 const claim=(actor:number)=>f.asUser(actor,()=>f.db.query<{n:number}>('select public.claim_parent_links() n'));
 const read=(actor:number,year='2026-27')=>f.asUser(actor,()=>f.db.query<{data:{scouts:{id:string}[];adventures:unknown[];advancement:unknown[];progress:unknown[];registrations:unknown[]}}>('select public.read_parent_portal($1) data',[year]));
 assert.equal((await read(4)).rows[0].data.scouts.length,0);
 assert.equal((await claim(4)).rows[0].n,2);assert.equal((await claim(4)).rows[0].n,0);
 const mom=(await read(4)).rows[0].data;assert.equal(mom.scouts.length,2);assert.ok(!JSON.stringify(mom).includes('Private medical'));assert.ok(!JSON.stringify(mom).includes('parent_1_name'));assert.ok(!JSON.stringify(mom).includes('source_values'));
 assert.equal((await claim(5)).rows[0].n,1);assert.deepEqual((await read(5)).rows[0].data.scouts.map(s=>s.id),[id('1',1)]);
 const dad=(await read(5)).rows[0].data;assert.equal(dad.adventures.length,1);assert.equal(dad.advancement.length,1);assert.equal(dad.progress.length,1);assert.equal(dad.registrations.length,1);assert.ok(!JSON.stringify(dad).includes(id('1',2)));assert.ok(!JSON.stringify(dad).includes('recorded_by'));assert.equal((await read(5,'2025-26')).rows[0].data.advancement.length,1);
 assert.equal((await claim(6)).rows[0].n,0);assert.equal((await read(6)).rows[0].data.scouts.length,0);
 await assert.rejects(claim(7),/Verified email/);await assert.rejects(read(7),/Verified email/);
 assert.equal((await claim(8)).rows[0].n,0);assert.equal((await read(8)).rows[0].data.scouts.length,0);
 await assert.rejects(read(4,'2026-99'),/Invalid scouting year/);
 await assert.rejects(f.asUser(4,()=>f.db.query('select public.read_roster_snapshot()')),/Roster access denied/);
 assert.equal((await f.asUser(4,()=>f.db.query('select * from public.scouts'))).rows.length,0);
 assert.equal((await f.asUser(4,()=>f.db.query('select * from public.pack_registrations'))).rows.length,0);
 await assert.rejects(f.asUser(4,()=>f.db.query('select * from public.parent_scout_links')),/permission denied/);
 await assert.rejects(f.asUser(4,()=>f.db.exec("update public.parent_scout_links set active=true")),/permission denied/);
 await assert.rejects(f.asUser(4,()=>f.db.exec("insert into public.leader_access(email) values('momname@gmail.com')")),/permission denied/);
 await assert.rejects(f.write(200,{action:'record_registration',scout_id:id('1',1),platform:'scouting.org',scouting_year:'2026-27',status:'confirmed',expected_revision:0,occurred_on:'2026-11-01'},4),/denied/i);
 await f.db.exec(`update public.parent_scout_links set active=false where parent_email='dad@example.test'`);assert.equal((await read(5)).rows[0].data.scouts.length,0);
 await f.db.exec(`update public.scouts set den='(withdraw) 0-Lions' where id='${id('1',2)}'`);assert.equal((await read(4)).rows[0].data.scouts.length,1);
 await f.db.exec(`update auth.users set email='different@example.test' where id='${id('0',4)}'`);assert.equal((await read(4)).rows[0].data.scouts.length,0);
 await f.db.exec('set role anon');assert.deepEqual((await f.db.query<{status:{email_ready:boolean}}>('select public.get_parent_portal_status() status')).rows[0].status,{email_ready:false});await assert.rejects(f.db.query('select public.read_parent_portal()'),/permission denied/);await assert.rejects(f.db.query('select public.claim_parent_links()'),/permission denied/);await f.db.exec('reset role');
 }finally{await f.db.close();}
});

test('Lions parent preview is read-only and requires the existing approved Google administrator',async()=>{
 const f=await m2Fixture();try{
 const preview=(actor:number)=>f.asUser(actor,()=>f.db.query<{data:{scouts:{id:string}[]}}>('select public.read_parent_preview() data'));
 const before=(await f.db.query<{n:number}>('select count(*)::int n from public.parent_scout_links')).rows[0].n;
 const data=(await preview(1)).rows[0].data;assert.deepEqual(data.scouts.map(s=>s.id),[id('1',2)]);assert.ok(!JSON.stringify(data).includes(id('1',1)));
 assert.equal((await f.db.query<{n:number}>('select count(*)::int n from public.parent_scout_links')).rows[0].n,before);
 assert.equal((await f.asUser(1,()=>f.db.query<{data:{scouts:unknown[]}}>('select public.read_parent_portal() data'))).rows[0].data.scouts.length,0);
 for(const actor of[2,3])await assert.rejects(preview(actor),/administrator access/);
 await assert.rejects(f.asUser(2,()=>f.db.query(`select private.parent_portal_projection(array['${id('1',2)}'::uuid],'2026-27')`)),/permission denied/);
 await f.db.exec(`update public.leader_access set active=false where email='admin@example.test'`);await assert.rejects(preview(1),/administrator access/);
 await f.db.exec(`update public.leader_access set active=true where email='admin@example.test';delete from auth.identities where user_id='${id('0',1)}'`);await assert.rejects(preview(1),/administrator access/);
 await f.db.exec('set role anon');await assert.rejects(f.db.query('select public.read_parent_preview()'),/permission denied/);await f.db.exec('reset role');
 }finally{await f.db.close();}
});
