import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

test('Maintenance blocks application and service writes, including truncation, and restricts the control',async()=>{
 const db=new PGlite();
 try{
  await db.exec('create schema private;create role anon;create role authenticated;create role service_role;create table public.synthetic(id int);grant usage on schema public,private to authenticated,service_role;grant all on public.synthetic to authenticated,service_role;');
  await db.exec(await readFile(new URL('../supabase/migrations/20261105090000_release_maintenance.sql',import.meta.url),'utf8'));
  await db.exec('insert into public.synthetic values(1);select private.set_release_maintenance(true);');
  for(const role of ['authenticated','service_role']){
   await db.exec('set role '+role);
   for(const sql of ['insert into public.synthetic values(2)','update public.synthetic set id=2','delete from public.synthetic','truncate public.synthetic'])await assert.rejects(db.exec(sql),/maintenance/);
   await assert.rejects(db.exec('select private.set_release_maintenance(false)'),/permission denied/);
   await db.exec('reset role');
  }
  await db.exec('select private.set_release_maintenance(false);insert into public.synthetic values(2)');
  assert.equal((await db.query('select * from public.synthetic')).rows.length,2);
 }finally{await db.close();}
});
