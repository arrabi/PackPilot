import{test}from'node:test';import assert from'node:assert/strict';import{backlogFixture}from'./helpers/backlog.ts';import{id}from'./helpers/m2.ts';
test('Parents receive no internal plans; independent plans share a date; notes and their audit remain owner/admin only',async()=>{
 const f=await backlogFixture();try{
  await f.command(1,{action:'meeting',id:id('7',1),date:'2027-05-12',den:'1-Tigers',agenda:'Leader only',requirements:[],revision:0});
  await f.command(2,{action:'meeting',id:id('7',2),date:'2027-05-12',den:'1-Tigers',agenda:'Independent plan',requirements:[],revision:0});
  const read=(actor:number)=>f.asUser(actor,()=>f.db.query<{r:any}>('select public.read_pack_community($1)r',[actor>=4]));
  assert.equal((await read(1)).rows[0].r.meetings.length,2);assert.equal((await read(4)).rows[0].r.meetings.length,0);
  await assert.rejects(f.command(3,{action:'meeting',id:id('7',3),date:'2027-05-12',requirements:[],revision:0},4),/Leader/);
  const note={action:'note',id:id('7',4),den:'1-Tigers',body:'My private planning note',revision:0};
  await f.command(4,note,2);await f.command(4,note,2);
  const notes=(actor:number)=>f.asUser(actor,()=>f.db.query<{r:any[]}>('select public.read_leader_notes()r'));
  assert.equal((await notes(2)).rows[0].r.length,1);assert.equal((await notes(1)).rows[0].r.length,1);await assert.rejects(notes(4),/Leader/);
  await f.db.exec(`insert into public.leader_access(email)values('stranger@example.test')`);
  await f.asUser(3,async()=>{const r=(await f.db.query<{s:any}>('select public.get_site_policy_status()s')).rows[0].s;await f.db.query('select public.accept_site_policies($1,$2,$3)',[r.version,r.terms_hash,r.privacy_hash]);});
  assert.equal((await notes(3)).rows[0].r.length,0);
  const history=await f.asUser(3,()=>f.db.query<{r:any}>('select public.read_pack_history()r'));
  assert.ok(!JSON.stringify(history.rows).includes('My private'));
  await assert.rejects(f.command(5,{...note,revision:1,body:'Other leader edit'},3),/owner/);
 }finally{await f.db.close();}
});
test('Field history records actor, per-value attribution, effective dates and scoped reads across direct/import writes',async()=>{
 const f=await backlogFixture();try{
  await f.db.exec(`update public.scouts set grade='2'where id='${id('1',1)}'`);
  const attribution=(await f.asUser(4,()=>f.db.query<{r:any[]}>('select public.read_pack_attribution($1)r',[id('1',1)]))).rows[0].r;
  assert.equal(attribution.find(x=>x.field==='grade').value,'2');assert.match(attribution.find(x=>x.field==='grade').actor_kind,/import|automation/);
  await assert.rejects(f.asUser(6,()=>f.db.query('select public.read_pack_attribution($1)',[id('1',1)])),/denied/);
  await f.db.exec(`update public.scouts set grade='3'where id='${id('1',1)}'`);
  const history=(await f.asUser(4,()=>f.db.query<{r:any}>('select public.read_pack_history($1)r',[{scout_id:id('1',1),field:'grade'}]))).rows[0].r;
  assert.equal(history.total,2);assert.equal(history.rows[0].changes.grade.before,'2');assert.equal(history.rows[0].changes.grade.after,'3');
 }finally{await f.db.close();}
});
