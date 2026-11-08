import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {usabilityFixture} from './helpers/usability.ts';
import {id} from './helpers/m2.ts';

const migration=new URL('../supabase/migrations/20261104003000_family_attention_indicators.sql',import.meta.url);
test('Family Hub metadata retains child access, original assignment time and per-user/year unread state',async()=>{
 const f=await usabilityFixture();
 try{
  await f.db.exec(await readFile(migration,'utf8'));
  await f.db.query(`insert into public.pack_adventures(id,name,rank,program_version,source_url,source_verified_on,requirements,completion_groups,recorded_by)values($1,'Test','tiger','test','https://www.scouting.org/test/','2026-11-03','[]','[]',$2)`,[id('2',99),id('0',1)]);
  await f.db.query(`insert into public.pack_home_assignments(id,scout_id,adventure_id,scouting_year,requirement_code,assigned_on,created_by,created_at,updated_at)values($1,$2,$3,'2026-27','1','2026-10-01',$4,'2026-10-01T12:00:00Z',now())`,[id('9',99),id('1',1),id('2',99),id('0',1)]);
  for(const [n,child,actor,year]of [[1,1,1,'2026-27'],[2,2,1,'2026-27'],[3,1,4,'2026-27'],[4,1,1,'2025-26']]as const)await f.db.query(`insert into public.pack_family_messages(id,scout_id,scouting_year,body,sender_role,sender_name,recorded_by)values($1,$2,$3,'Test note',$4,'Sender',$5)`,[id('9',n),id('1',child),year,actor===4?'parent':'leader',id('0',actor)]);
  const workspace=(actor:number)=>f.asUser(actor,async()=>(await f.db.query<{r:any}>(`select public.read_pack_workspace('events',true,'2026-27')r`)).rows[0].r);
  assert.equal((await workspace(4)).unread_family_messages,1);assert.equal((await workspace(4)).unread_family_message_child,id('1',1));assert.equal((await workspace(5)).unread_family_messages,2);assert.equal((await workspace(6)).unread_family_messages,1);
  const dashboard=await f.asUser(4,async()=>(await f.db.query<{r:any}>(`select public.read_parent_dashboard('2026-27')r`)).rows[0].r);
  assert.equal(Date.parse(dashboard.assignments[0].created_at),Date.parse('2026-10-01T12:00:00Z'));assert.equal(dashboard.assignments.length,1);
  await f.asUser(4,()=>f.db.query('select public.record_family_operation($1,$2)',[id('9',100),{action:'mark_family_read',scout_id:id('1',1),scouting_year:'2026-27',through_message_id:id('9',3)}]));
  assert.equal((await workspace(4)).unread_family_messages,0);assert.equal((await workspace(5)).unread_family_messages,2);
  await assert.rejects(workspace(3),/denied|access|policy|policies/i);
  await f.db.query(`update public.parent_scout_links set active=false where parent_email='mom@example.test'`);
  await assert.rejects(workspace(4),/denied|access|parent/i);
 }finally{await f.db.close();}
});

test('event and volunteer publication times survive edits and only enrich already-visible items',async()=>{
 const f=await usabilityFixture();
 try{
  await f.db.exec(await readFile(migration,'utf8'));
  await f.command(900,{action:'event',id:id('7',900),title:'Tiger event',den:'1-Tigers',date:'2027-05-12',mode:'none',revision:0});
  await f.command(901,{action:'signup',id:id('7',901),title:'Camp roles',details:'Help together',event_id:'',signup_date:'2027-05-12',revision:0,items:[{id:id('7',902),title:'Snacks',capacity:'3',capacity_unit:'family'}]});
  const read=(actor:number)=>f.asUser(actor,async()=>(await f.db.query<{r:any}>(`select public.read_pack_workspace('events',true,'2026-27')r`)).rows[0].r);
  const before=await read(4);assert.ok(before.events[0].created_at);assert.ok(before.jobs[0].created_at);assert.ok(before.signups[0].created_at);
  await f.command(903,{action:'event',id:id('7',900),title:'Updated Tiger event',den:'1-Tigers',date:'2027-05-12',mode:'none',revision:1});
  assert.equal((await read(4)).events[0].created_at,before.events[0].created_at);assert.equal((await read(6)).events.length,0);
  await assert.rejects(f.asUser(4,()=>f.db.query('select private.family_work_data($1,$2)',[[id('1',2)],'2026-27'])),/permission denied/);
 }finally{await f.db.close();}
});
