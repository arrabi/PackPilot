import {test} from 'node:test';import assert from 'node:assert/strict';import {m2Fixture,id} from './helpers/m2.ts';
test('shirt source history protects adult and unconfirmed records; only free scout receipts affect eligibility',async()=>{
 const f=await m2Fixture();try{
 await f.db.exec(`insert into public.pack_shirt_import_history(id,source_sha256,source_file,source_row,recipient_name,recipient_type,scouting_year,distribution_type,receipt_status,received_on,quantity,source_values,recorded_by) values('${id('8',1)}',repeat('b',64),'synthetic.csv',2,'Adult Synthetic','adult','2025-26','free','confirmed','2026-04-29',1,'{}','${id('0',1)}'),('${id('8',2)}',repeat('b',64),'synthetic.csv',3,'Unconfirmed Synthetic','youth','2025-26','free','not_recorded',null,1,'{}','${id('0',1)}')`);
 assert.equal((await f.asUser(2,()=>f.db.query('select * from public.pack_shirt_import_history'))).rows.length,2);
 assert.equal((await f.asUser(3,()=>f.db.query('select * from public.pack_shirt_import_history'))).rows.length,0);
 await assert.rejects(f.asUser(2,()=>f.db.exec("delete from public.pack_shirt_import_history")),/permission denied/);
 await f.db.exec('set role anon');await assert.rejects(f.db.query('select * from public.pack_shirt_import_history'),/permission denied/);await f.db.exec('reset role');
 const result=()=>f.asUser(2,()=>f.db.query<{value:string}>(`select public.pack_shirt_eligibility('${id('1',1)}','2026-27') value`));
 assert.equal((await result()).rows[0].value,'unknown');
 await f.write(500,{action:'request_purchase',scout_id:id('1',1),scouting_year:'2025-26',occurred_on:'2026-04-29',expected_revision:0,item:'tshirt',quantity:2});
 assert.equal((await result()).rows[0].value,'unknown');
 await f.write(501,{action:'record_historical_shirt',scout_id:id('1',1),scouting_year:'2025-26',occurred_on:'2026-04-29',expected_revision:1,note:'Confirmed free distribution; synthetic source row.'});
 assert.equal((await result()).rows[0].value,'ineligible');
 assert.equal((await f.asUser(2,()=>f.db.query<{value:string}>(`select public.pack_shirt_eligibility('${id('1',1)}','2027-28') value`))).rows[0].value,'unknown');
 }finally{await f.db.close();}
});
