import{test}from'node:test';import assert from'node:assert/strict';import{usabilityFixture}from'./helpers/usability.ts';import{id}from'./helpers/m2.ts';
test('The family action-center projection includes only authorized children, registration reports and participation, with no internal plans',async()=>{const f=await usabilityFixture();try{
 await f.command(340,{action:'event',id:id('7',340),title:'Lions event',den:'0-Lions',event_type:'den_meeting',date:'2027-05-12',mode:'none',revision:0});await f.command(341,{action:'meeting',id:id('7',341),den:'1-Tigers',date:'2027-05-12',agenda:'INTERNAL-NOTES',requirements:[],revision:0});await f.command(342,{action:'registration_report',id:id('1',1),year:'2026-27',platform:'scouting.org'},4);
 const read=(actor:number)=>f.asUser(actor,async()=>(await f.db.query<{r:any}>('select public.read_parent_dashboard($1)r',['2026-27'])).rows[0].r);const mom=await read(4),other=await read(6);assert.equal(mom.scouts.length,1);assert.equal(mom.registration_reports.length,1);assert.equal(other.registration_reports.length,0);assert.equal(mom.participation.events.length,0);assert.equal(other.participation.events.length,1);assert.ok(!JSON.stringify(mom).includes('INTERNAL-NOTES'));assert.ok(!JSON.stringify(mom).includes('First Synthetic')||mom.scouts[0].id===id('1',1));await assert.rejects(f.command(343,{action:'registration_report',id:id('1',2),year:'2026-27',platform:'active.com'},4),/Family access/);
 }finally{await f.db.close();}});

test('Notification links retain the original program year, child and message through the tracked destination',async()=>{const f=await usabilityFixture();try{
 await f.db.exec(`insert into public.pack_family_messages values('${id('9',440)}','${id('1',1)}','2025-26','Historical message','leader','Leader','${id('0',1)}',now())`);
 const mail=(await f.db.query<{id:string}>("select id from private.pack_email_outbox where dedupe_key=$1 and recipient='mom@example.test'",['message:'+id('9',440)+':mom@example.test'])).rows[0];assert.ok(mail);await f.db.query('select public.claim_parent_emails()');
 const context=(await f.db.query<{r:any}>('select public.parent_email_context($1)r',[mail.id])).rows[0].r;const link=new URL(context.links.portal);assert.equal(link.searchParams.get('year'),'2025-26');assert.equal(link.searchParams.get('child'),id('1',1));assert.equal(link.searchParams.get('section'),'messages');assert.equal(link.searchParams.get('item'),'message-'+id('9',440));
 assert.equal((await f.db.query<{content:any}>('select content from private.pack_email_outbox where id=$1',[mail.id])).rows[0].content.links.portal,context.links.portal);
 }finally{await f.db.close();}});

test('Photo next steps use only authorized scout portraits, update after upload/removal, and match the scoped admin preview',async()=>{const f=await usabilityFixture();try{
 const image='data:image/jpeg;base64,YQ==';
 await f.command(450,{action:'photo',id:id('1',1),kind:'family',image},4);await f.command(451,{action:'photo',id:id('1',2),kind:'scout',image},6);
 const read=(actor:number)=>f.asUser(actor,async()=>(await f.db.query<{r:any}>('select public.read_parent_dashboard()r')).rows[0].r);
 assert.deepEqual((await read(4)).scout_photos,[]);assert.deepEqual((await read(6)).scout_photos,[{scout_id:id('1',2)}]);
 await f.command(452,{action:'photo',id:id('1',1),kind:'scout',image},4);assert.deepEqual((await read(4)).scout_photos,[{scout_id:id('1',1)}]);assert.ok(!JSON.stringify(await read(4)).includes(image));
 const preview=(await f.asUser(1,()=>f.db.query<{r:any}>('select public.read_parent_preview_scope($1,$2,$3)r',['2026-27',null,id('1',1)]))).rows[0].r;assert.deepEqual(preview.scout_photos,[{scout_id:id('1',1)}]);
 await f.command(453,{action:'photo',id:id('1',1),kind:'scout',image:''},4);assert.deepEqual((await read(4)).scout_photos,[]);assert.deepEqual((await read(6)).scout_photos,[{scout_id:id('1',2)}]);await assert.rejects(f.asUser(4,()=>f.db.query('select public.read_parent_preview_scope()')),/Administrator/);
 }finally{await f.db.close();}});
