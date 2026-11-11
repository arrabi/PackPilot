import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {usabilityFixture} from './helpers/usability.ts';
import {id} from './helpers/m2.ts';

test('Personal and existing den notes are owner-only across reads, history, attribution and writes, including admins',async()=>{
 const f=await usabilityFixture();
 try {
  // Create a note using the old schema, then upgrade without altering its body or ID.
  const legacy={action:'note',id:id('7',800),den:'1-Tigers',body:'LEGACY PRIVATE',revision:0};
  await f.command(800,legacy,2);
  await f.db.exec(await readFile(new URL('../supabase/migrations/20261110001000_personal_notes.sql',import.meta.url),'utf8'));
  const personal={action:'note',id:id('7',801),den:'',body:'PERSONAL PRIVATE',revision:0};
  await f.command(801,personal,2);await f.command(801,personal,2);
  const read=async(actor:number)=>(await f.asUser(actor,()=>f.db.query<{r:any[]}>('select public.read_leader_notes()r'))).rows[0].r;
  const mine=await read(2);
  assert.equal(mine.length,2);assert.equal(mine.find(n=>n.id===legacy.id).body,legacy.body);
  assert.equal(mine.find(n=>n.id===personal.id).revision,1);
  assert.deepEqual(await read(1),[]); // Administrator receives no other leader's notes.
  for(const actor of [1,2,4]){
   const history=(await f.asUser(actor,()=>f.db.query<{r:any}>('select public.read_pack_history($1)r',[{table:'pack_leader_notes'}]))).rows[0].r;
   assert.equal(history.total>0,actor===2);
   if(actor<4){
    const workspace=(await f.asUser(actor,()=>f.db.query<{r:any}>('select public.read_pack_workspace($1,false,$2)r',['notes','2026-27']))).rows[0].r;
    assert.equal(workspace.notes.length,actor===2?2:0);
    assert.equal(workspace.attribution.length>0,actor===2);
   }
   await assert.rejects(f.asUser(actor,()=>f.db.query('select body from public.pack_leader_notes')),/permission denied/);
  }
  await assert.rejects(read(4),/Leader/);
  await assert.rejects(f.command(802,{...personal,revision:1,body:'ADMIN EDIT'},1),/owner/);
  await assert.rejects(f.command(803,{...personal,revision:1},4),/Leader/);
  await f.command(804,{...personal,revision:1,body:'UPDATED PRIVATE'},2);
  await assert.rejects(f.command(805,{...personal,revision:1,body:'STALE TAB'},2),/changed/);
  await assert.rejects(f.command(806,{...personal,id:id('7',802)},2),/unique/);
  await assert.rejects(f.command(807,{...personal,id:id('7',803),den:'2-Wolves',body:'x'.repeat(20001)},2),/check constraint/);
  await f.command(808,{action:'note',id:id('7',804),den:'',body:'ADMIN OWN NOTE',revision:0},1);
  assert.equal((await read(1))[0].body,'ADMIN OWN NOTE');
  assert.equal((await read(2)).find(n=>n.id===personal.id).body,'UPDATED PRIVATE');
  await f.db.exec("update public.leader_access set active=false where email='reader@example.test'");
  await assert.rejects(read(2),/Leader/);
 } finally {await f.db.close();}
});
