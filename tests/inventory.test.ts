import { test } from "node:test";
import assert from "node:assert/strict";
import { m2Fixture, id } from "./helpers/m2.ts";
import { recordOperationSchema } from "../supabase/functions/_shared/operations.ts";

test("inventory preserves unknown counts, dated balances, retries, revisions and atomic batches", async () => {
 const { db, asUser, write } = await m2Fixture();
 try {
  const item=id("7",1), other=id("7",2), date="2026-10-14";
  const define={action:"define_inventory_item",item_id:item,name:"Synthetic neckerchief",den:"0-Lions",category:"neckerchief",occurred_on:date,note:"Opening stock; quantity not recorded"};
  const read=async()=> (await asUser(2,()=>db.query<{r:{rows:Record<string,unknown>[];total:number;next_offset:number|null}}>("select public.read_pack_inventory('items',null,0,1) r"))).rows[0].r;
  assert.equal(recordOperationSchema.safeParse({request_id:id("3",1),command:define}).success,true);
  await write(1,define);
  assert.equal((await read()).rows[0].quantity_on_hand,null);
  const change=(action:string,quantity:number,expected_revision:number,extra:object={})=>({action,item_id:item,quantity,expected_revision,note:"Synthetic stock change",occurred_on:date,...extra});
  await assert.rejects(write(2,change("inventory_receive",2,1)),/unknown; record a count first/);
  const count=change("inventory_count",3,1);
  assert.deepEqual(await write(3,count),await write(3,count));
  await assert.rejects(write(3,change("inventory_count",4,1)),/Request ID conflict/);
  await write(4,change("inventory_receive",2,2));
  await write(5,change("inventory_issue",1,3));
  assert.equal((await read()).rows[0].quantity_on_hand,4);
  await assert.rejects(write(6,change("inventory_issue",5,4)),/Insufficient inventory/);
  await assert.rejects(write(7,change("inventory_count",9,1)),/Revision conflict/);
  await assert.rejects(write(8,change("inventory_count",9,4,{occurred_on:"2099-01-01"})),/future/);
  await assert.rejects(write(9,change("inventory_count",9,4,{occurred_on:"2026-10-13"})),/precedes latest/);
  const entries=[{request_id:id("3",10),command:change("inventory_receive",2,4)},{request_id:id("3",11),command:change("inventory_issue",100,5)}];
  await assert.rejects(asUser(1,()=>db.query("select record_pack_batch($1::jsonb)",[JSON.stringify(entries)])),/Insufficient inventory/);
  assert.equal((await read()).rows[0].quantity_on_hand,4);
  assert.equal((await read()).rows[0].revision,4);
  await write(12,change("inventory_count",0,4));
  assert.equal((await read()).rows[0].quantity_on_hand,0);
  await write(13,{...define,item_id:other,name:"Another physical variant",quantity:2,counted_on:date});
  assert.equal((await read()).total,2);assert.equal((await read()).next_offset,1);
  const history=await asUser(2,()=>db.query<{r:{rows:unknown[]}}>("select read_pack_inventory('events',$1) r",[item]));
  assert.equal(history.rows[0].r.rows.length,5);
  // Scout handouts never silently subtract counted stock again.
  await write(14,{action:"issue_loan",scout_id:id("1",1),scouting_year:"2026-27",expected_revision:0,item:"neckerchief",quantity:1,occurred_on:date});
  assert.equal((await asUser(2,()=>db.query<{q:number}>("select quantity_on_hand q from pack_inventory_items where id=$1",[other]))).rows[0].q,2);
 } finally { await db.close(); }
});

test("inventory authorization gates reads/writes and prevents caller bypass of its ledger", async () => {
 const { db, asUser, write }=await m2Fixture();
 try {
  const cmd={action:"define_inventory_item",item_id:id("7",1),name:"Synthetic stock",category:"other",quantity:0,note:"Counted empty",occurred_on:"2026-10-14"};
  await assert.rejects(write(1,cmd,2),/Recording access denied/);
  await assert.rejects(asUser(3,()=>db.query("select read_pack_inventory('items')")),/Access denied/);
  await write(1,cmd);
  assert.equal((await asUser(3,()=>db.query("select * from pack_inventory_items"))).rows.length,0);
  for(const sql of ["update pack_inventory_items set quantity_on_hand=999","delete from pack_inventory_events"])
   await assert.rejects(asUser(1,()=>db.query(sql)),/permission denied/);
  await db.exec("update leader_access set can_record=true where email='reader@example.test'");
  await assert.rejects(write(1,cmd,2),/Request ID conflict/);
  await db.exec("update leader_access set active=false where email='admin@example.test'");
  await assert.rejects(write(2,{...cmd,item_id:id("7",2)}),/Recording access denied/);
 } finally { await db.close(); }
});
