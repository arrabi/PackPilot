import{test}from'node:test';import assert from'node:assert/strict';import{readFile}from'node:fs/promises';
import{renderPackEmail,type EmailContext}from'../notifications/template.ts';import{handleNotificationLink}from'../notifications/tracking.ts';import{usabilityFixture}from'./helpers/usability.ts';import{id}from'./helpers/m2.ts';
const token='12345678-1234-4123-8123-123456789abc';
const context:EmailContext={kind:'earned',parent_name:'Parent <safe>',scout_names:['Adam'],items:[{kind:'earned',text:'Legacy body'}],links:{portal:'https://packpilot.example/parents?child=one&section=progress',survey:'https://example.test/survey'},spotlight:{scout_name:'Adam',adventure_id:'b4fe30dd-67b4-5179-9160-f3d703b7bb60',adventure:'Bobcat',rank:'lion',earned_on:'2026-11-03'},media_token:token,portraits:[{name:'Adam',index:0}]};
test('Family Hub email celebrates real milestones, uses scoped photo links and official remote badge references, and retains accessible alternatives',()=>{
 const email=renderPackEmail(context,'https://example.test/notification-links');
 assert.match(email.html,/A big moment for Adam!/);assert.match(email.html,/ADVENTURE EARNED/);assert.match(email.html,/FAMILY HUB/);assert.match(email.html,/media=portrait/);assert.match(email.html,/src="https:\/\/www\.scouting\.org\/wp-content\/uploads\//);assert.match(email.html,/referrerpolicy="no-referrer"/);assert.match(email.html,/Bobcat/);assert.match(email.html,/Parent &lt;safe&gt;/);assert.match(email.html,/role="presentation"/);assert.match(email.html,/viewport/);assert.match(email.text,/November 3, 2026/);assert.doesNotMatch(email.html,/data:image|cid:/);assert.doesNotMatch(email.text,/Legacy body/);
 const homework=renderPackEmail({...context,kind:'homework',items:[{kind:'homework',adventure:'Bobcat',requirement:'1',description:'Read <together>',due_on:null}]},'https://example.test/notification-links');
 assert.match(homework.html,/Busy week\? We understand/);assert.match(homework.html,/Read &lt;together&gt;/);assert.match(homework.text,/send for review/);assert.doesNotMatch(homework.text,/About 10 minutes|No special supplies|complete it by|ADVENTURE EARNED/);
 const missing=renderPackEmail({...context,portraits:[],spotlight:null},'https://example.test/notification-links');assert.doesNotMatch(missing.html,/<img/);
 const admin=renderPackEmail({...context,admin:true},'https://example.test/notification-links');assert.doesNotMatch(admin.html,/media=portrait/);assert.match(admin.html,/Pack administration update/);assert.match(admin.html,/Open administrator workspace/);assert.match(admin.html,/href="https:\/\/packpilot.example\/admin"/);
});
test('Email portrait endpoint is noncacheable, validates inputs and cannot accept arbitrary image sources or record engagement',async()=>{
 const saved=globalThis.fetch;let calls=0;const env={SUPABASE_URL:'https://example.test',SUPABASE_SECRET_KEY:'private'};
 globalThis.fetch=async(url,init)=>{calls++;assert.match(String(url),/read_parent_email_portrait$/);assert.equal(JSON.parse(String(init?.body)).portrait_index,0);return Response.json('data:image/jpeg;base64,/9j/YQ==');};
 try{
  const url='https://example.test/?media=portrait&t='+token;
  for(const suffix of ['&index=-1','&index=31','&index=1.5'])assert.equal((await handleNotificationLink(new Request(url+suffix),env)).status,404);assert.equal(calls,0);
  const response=await handleNotificationLink(new Request(url),env);assert.equal(response.status,200);assert.equal(response.headers.get('Content-Type'),'image/jpeg');assert.equal(response.headers.get('Cache-Control'),'no-store');assert.equal(response.headers.get('Referrer-Policy'),'no-referrer');assert.equal(calls,1);
  globalThis.fetch=async()=>Response.json('https://evil.test/image.jpg');assert.equal((await handleNotificationLink(new Request(url),env)).status,404);
 }finally{globalThis.fetch=saved;}
});
test('Portraits are bound to one eligible mailbox and child, expire, disappear on removal/revocation, and never enter outbox content',async()=>{
 const f=await usabilityFixture();try{
  await f.db.exec(await readFile(new URL('../supabase/migrations/20261103202859_portal_domain_pack99.sql',import.meta.url),'utf8'));
  await f.db.exec(await readFile(new URL('../supabase/migrations/20261103210712_family_hub_email_design.sql',import.meta.url),'utf8'));
  await f.db.query(`insert into public.pack_adventures(id,name,rank,program_version,source_url,source_verified_on,requirements,completion_groups,recorded_by)values($1,'Test Adventure','tiger','test','https://www.scouting.org/test/','2026-11-03','[]','[]',$2)`,[id('2',1),id('0',1)]);
  const image='data:image/jpeg;base64,/9j/YQ==';
  await f.command(900,{action:'photo',id:id('1',1),kind:'scout',image},4);await f.command(901,{action:'photo',id:id('1',2),kind:'scout',image},6);
  await f.db.query(`insert into private.pack_email_outbox(dedupe_key,scout_id,recipient,subject,body,status,claimed_at)values($1,$2,'mom@example.test','Congratulations','Body','sending',now())`,['earned:'+id('1',1)+':'+id('2',1)+':2026-27:mom@example.test',id('1',1)]);
  const mail=(await f.db.query<{id:string;media_token:string}>(`select id,media_token from private.pack_email_outbox where subject='Congratulations'`)).rows[0];
  const read=async()=> (await f.db.query<{image:string|null}>('select public.read_parent_email_portrait($1,0)image',[mail.media_token])).rows[0].image;
  const c=(await f.db.query<{r:EmailContext}>('select public.parent_email_context($1)r',[mail.id])).rows[0].r;
  assert.equal(c.portraits?.length,1);assert.equal(c.spotlight?.adventure,'Test Adventure');assert.equal(c.spotlight?.scout_name,'First Synthetic');assert.equal(await read(),image);assert.ok(!JSON.stringify(c).includes(image));assert.ok(!JSON.stringify((await f.db.query('select content from private.pack_email_outbox where id=$1',[mail.id])).rows).includes(image));
  assert.equal((await f.db.query<{image:null}>('select public.read_parent_email_portrait($1,1)image',[mail.media_token])).rows[0].image,null);
  await assert.rejects(f.asUser(4,()=>f.db.query('select public.read_parent_email_portrait($1,0)',[mail.media_token])),/permission denied/);
  await f.db.query("update private.pack_email_outbox set status='sent',sent_at=now()-interval '31 days'where id=$1",[mail.id]);assert.equal(await read(),null);
  await f.db.query('update private.pack_email_outbox set sent_at=now()where id=$1',[mail.id]);assert.equal(await read(),image);
  await f.db.query("update public.parent_scout_links set active=false where scout_id=$1 and parent_email='mom@example.test'",[id('1',1)]);assert.equal(await read(),null);
  await f.db.query("update public.parent_scout_links set active=true where scout_id=$1 and parent_email='mom@example.test'",[id('1',1)]);
  await f.command(902,{action:'photo',id:id('1',1),kind:'scout',image:''},4);assert.equal(await read(),null);
  await f.db.query(`insert into public.parent_scout_links(scout_id,parent_email,created_by)values($1,'mom@example.test',$2)`,[id('1',2),id('0',1)]);
  await f.db.query(`update private.pack_email_outbox set status='sending',claimed_at=now(),scout_id=null,child_ids=$2::uuid[],dedupe_key='weekly:test:mom@example.test' where id=$1`,[mail.id,[id('1',1),id('1',2)]]);
  const digest=(await f.db.query<{r:EmailContext}>('select public.parent_email_context($1)r',[mail.id])).rows[0].r;
  assert.deepEqual(digest.portraits,[{name:'Second Synthetic',index:1}]);assert.equal(await read(),null);
  assert.equal((await f.db.query<{image:string}>('select public.read_parent_email_portrait($1,1)image',[mail.media_token])).rows[0].image,image);
  await f.db.query(`insert into private.pack_email_preferences(email,suppressed,changed_by)values('mom@example.test',true,$1)on conflict(email)do update set suppressed=true`,[id('0',1)]);
  assert.equal((await f.db.query<{image:string|null}>('select public.read_parent_email_portrait($1,1)image',[mail.media_token])).rows[0].image,null);
 }finally{await f.db.close();}
});
