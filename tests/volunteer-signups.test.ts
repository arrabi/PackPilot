import{test}from'node:test';import assert from'node:assert/strict';import{readFile}from'node:fs/promises';import{backlogFixture}from'./helpers/backlog.ts';import{id}from'./helpers/m2.ts';
const before=['20261102211000_admin_exports_retention.sql','20261102212000_friendly_notifications_engagement.sql','20261102213000_workspace_views.sql','20261102214000_engagement_policy_version.sql','20261102215000_backlog_guard_refinements.sql'];
const migration='20261102220000_multi_item_volunteer_signups.sql';const signup=()=>({action:'signup',id:id('7',100),title:'Family Camp roles',details:'Please help our camp run smoothly.',event_id:'',signup_date:'2027-05-12',revision:0,items:[{id:id('7',101),title:'Main dish',capacity:'6',capacity_unit:'family'},{id:id('7',102),title:'Dessert',capacity:'3',capacity_unit:'family'},{id:id('7',103),title:'Activities Lead',capacity:'1',capacity_unit:'person'},{id:id('7',104),title:'Kitchen lead',capacity:'1',capacity_unit:'person'},{id:id('7',105),title:'Kitchen volunteers',capacity:'4',capacity_unit:'person'}]});
const fixture=()=>backlogFixture([...before,migration]);
const read=(f:Awaited<ReturnType<typeof fixture>>,actor=4)=>f.asUser(actor,async()=>(await f.db.query<{r:any}>('select public.read_pack_workspace($1,$2,$3)r',['events',actor>=4,'2026-27'])).rows[0].r);
test('A single signup creates multiple independently limited items atomically, with leader-only revision-checked editing',async()=>{
 const f=await fixture();try{const c=signup();await assert.rejects(f.command(1,c,4),/Leader recording/);await assert.rejects(f.command(1,c,2),/Leader recording/);
 await f.command(1,c);await f.command(1,c);let data=await read(f);assert.equal(data.signups.length,1);assert.equal(data.jobs.length,5);assert.deepEqual(data.jobs.map((j:any)=>j.capacity).sort((a:number,b:number)=>a-b),[1,1,3,4,6]);
 await assert.rejects(f.command(2,{...c,items:[...c.items,{id:id('7',106),title:'',capacity:'2',capacity_unit:'family'}],revision:1}),/check constraint/);assert.equal((await read(f)).signups[0].revision,1);
 await assert.rejects(f.command(2,c),/changed/);await assert.rejects(f.command(2,{...c,revision:1,items:c.items.slice(0,4)}),/Keep existing/);
 await f.command(2,{...c,revision:1,title:'Camp kitchen & activities',items:[...c.items,{id:id('7',106),title:'Water bottles',capacity:'',capacity_unit:'family'}]});data=await read(f);assert.equal(data.jobs.length,6);assert.equal(data.jobs.find((j:any)=>j.id===id('7',106)).capacity,null);assert.equal(data.signups[0].title,'Camp kitchen & activities');
 await f.command(3,{action:'close_job',id:id('7',106)});await f.command(3,{action:'close_job',id:id('7',106)});assert.equal((await read(f)).signups[0].revision,3);
 await assert.rejects(f.command(4,{...c,revision:2}),/changed/);
 await assert.rejects(f.command(5,{id:id('7',106),join:false},4),/Unknown community action/);
 const audit=await f.asUser(1,()=>f.db.query<{r:any}>('select public.read_pack_history($1)r',[{table:'pack_volunteer_signups'}]));assert.ok(audit.rows[0].r.rows.some((l:any)=>l.actor_id===id('0',1)&&l.changes.title));
 }finally{await f.db.close();}
});
test('Parents can choose multiple items; family places are shared across guardians and person limits remain independent',async()=>{
 const f=await fixture();try{const c=signup();c.items[0].capacity='1';await f.command(1,c);
 const choose=(n:number,role:number,actor=4,join=true)=>f.command(n,{action:'volunteer',id:id('7',role),join,scout_id:id('1',actor===6?2:1)},actor);
 await choose(2,101);await choose(3,102);await choose(4,101,5);let data=await read(f,5);assert.ok(data.jobs.find((j:any)=>j.id===id('7',101)).mine);assert.equal(data.jobs.find((j:any)=>j.id===id('7',101)).used,1);
 await assert.rejects(choose(5,101,6),/full/);assert.equal((await f.db.query('select * from public.pack_volunteers where job_id=$1',[id('7',101)])).rows.length,1);
 await choose(6,103);await assert.rejects(choose(7,103,5),/full/);assert.equal((await read(f,5)).jobs.find((j:any)=>j.id===id('7',103)).mine,false);
 await choose(8,101,5,false);assert.equal((await read(f)).jobs.find((j:any)=>j.id===id('7',101)).used,0);await choose(5,101,6);assert.equal((await read(f,6)).jobs.find((j:any)=>j.id===id('7',101)).mine,true);
 const exported=(await f.asUser(5,()=>f.db.query<{r:any}>('select public.prepare_pack_export($1,$2)r',[id('6',180),[id('1',1)]]))).rows[0].r;assert.equal(exported.volunteering.length,2);assert.ok(exported.volunteering.every((v:any)=>v.signup_title==='Family Camp roles'&&v.scout_id===id('1',1)));
 await assert.rejects(f.command(9,{...c,revision:1,items:c.items.map((j,i)=>i===1?{...j,capacity_unit:'person'}:j)}),/Cannot change/);
 }finally{await f.db.close();}
});
test('Closed and den-scoped signups remain private, permit release, and do not appear as open reminder items',async()=>{
 const f=await fixture();try{await f.command(1,{action:'event',id:id('7',110),title:'Tiger camp',date:'2027-05-12',den:'1-Tigers',mode:'none',revision:0});const c={...signup(),event_id:id('7',110)};await f.command(2,c);
 assert.equal((await read(f,6)).signups.length,0);await assert.rejects(f.command(3,{action:'volunteer',id:id('7',101),join:true,scout_id:id('1',2)},6),/available signup/);
 await f.command(4,{action:'volunteer',id:id('7',101),join:true,scout_id:id('1',1)},4);
 const roles=(await f.db.query<{r:any[]}>('select private.parent_reminder_items($1,$2)r',['dad@example.test','2026-27'])).rows[0].r.filter(i=>i.kind==='volunteer');assert.equal(roles.length,4);assert.ok(roles.every(i=>i.title.startsWith('Family Camp roles — ')));assert.ok(roles.some(i=>i.unit==='person'));
 await f.command(5,{...c,revision:1,closed:true});await assert.rejects(f.command(6,{action:'volunteer',id:id('7',102),join:true,scout_id:id('1',1)},4),/closed/);
 await f.command(7,{action:'volunteer',id:id('7',101),join:false},5);assert.equal((await f.db.query('select * from public.pack_volunteers')).rows.length,0);
 assert.equal((await f.db.query<{r:any[]}>('select private.parent_reminder_items($1,$2)r',['mom@example.test','2026-27'])).rows[0].r.filter(i=>i.kind==='volunteer').length,0);
 }finally{await f.db.close();}
});
test('Existing single-item signups, reservations, dates and old item links survive the migration',async()=>{
 const f=await backlogFixture(before);try{await f.command(1,{action:'job',id:id('7',120),title:'Bring salads',capacity:2,signup_date:'2027-05-12'});await f.command(2,{action:'volunteer',id:id('7',120),join:true,scout_id:id('1',1)},4);
 await f.db.exec(await readFile(new URL('../supabase/migrations/'+migration,import.meta.url),'utf8'));let data=await read(f);assert.equal(data.jobs[0].id,id('7',120));assert.equal(data.jobs[0].mine,true);assert.equal(data.jobs[0].used,1);assert.equal(data.signups[0].signup_date,'2027-05-12');assert.equal(data.jobs[0].capacity_unit,'person');
 await f.command(3,{action:'job',id:id('7',121),title:'Old client role',signup_date:'2027-05-26'});data=await read(f);assert.equal(data.signups.length,2);assert.equal(data.signups.find((s:any)=>s.id===id('7',121)).signup_date,'2027-05-26');
 }finally{await f.db.close();}
});
