import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {usabilityFixture} from './helpers/usability.ts';

test('domain migration preserves function privileges while updating live link generators',async()=>{
 const {db}=await usabilityFixture();
 try{
  const metadata=`select n.nspname,p.proname,p.proacl::text,p.prosecdef,p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private') and p.prokind='f' order by n.nspname,p.proname,p.oid`;
  const before=await db.query(metadata);
  await db.exec(await readFile(new URL('../supabase/migrations/20261103202859_portal_domain_pack99.sql',import.meta.url),'utf8'));
  assert.deepEqual((await db.query(metadata)).rows,before.rows);
  const count=async(host:string)=>(await db.query<{count:number}>(`select count(*)::int as count from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private') and p.prokind='f' and position($1 in p.prosrc)>0`,[host])).rows[0].count;
  assert.equal(await count('legacy.packpilot.example'),0);
  assert.equal(await count('packpilot.example'),10);
 }finally{await db.close();}
});
