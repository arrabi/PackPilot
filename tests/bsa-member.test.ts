import {test} from 'node:test';import assert from 'node:assert/strict';import {m2Fixture,id} from './helpers/m2.ts';
test('BSA identifiers retain leading zeros, reject duplicates and use approved roster access',async()=>{
 const f=await m2Fixture();try{
 await f.db.query('update public.scouts set bsa_member_id=$1 where id=$2',['001234567',id('1',1)]);
 const r=await f.asUser(2,()=>f.db.query<{roster:{id:string;bsa_member_id:string|null}[]}>('select public.read_roster_snapshot() roster'));
 assert.equal(r.rows[0].roster.find(s=>s.id===id('1',1))?.bsa_member_id,'001234567');assert.equal(r.rows[0].roster.find(s=>s.id===id('1',2))?.bsa_member_id,null);
 await assert.rejects(f.db.query('update public.scouts set bsa_member_id=$1 where id=$2',['001234567',id('1',2)]),/unique constraint/);
 await assert.rejects(f.db.query('update public.scouts set bsa_member_id=$1 where id=$2',['invalid',id('1',2)]),/check constraint/);
 await assert.rejects(f.asUser(2,()=>f.db.exec("update public.scouts set bsa_member_id='123'")),/permission denied/);
 await assert.rejects(f.asUser(3,()=>f.db.query('select public.read_roster_snapshot()')),/Roster access denied/);
 }finally{await f.db.close();}
});
