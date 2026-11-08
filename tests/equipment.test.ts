import {test} from "node:test";
import assert from "node:assert/strict";
import {m2Fixture,id} from "./helpers/m2.ts";
import {recordOperationSchema} from "../supabase/functions/_shared/operations.ts";

test("equipment enforces dated entitlements, partial loan/payment balances, purchases, correction dependencies and authorization",async()=>{
 const {db,asUser,write,read}=await m2Fixture();
 try {
  const scout=id("1",1),other=id("1",2),year="2026-27";
  let revision=0,sequence=0;
  const command=(action:string,extra:object={})=>({action,scout_id:scout,scouting_year:year,expected_revision:revision,occurred_on:"2026-10-01",...extra});
  const apply=async(action:string,extra:object={})=>{const c=command(action,extra);assert.equal(recordOperationSchema.safeParse({request_id:id("3",sequence+1),command:c}).success,true);const out=await write(++sequence,c);revision++;return out;};
  assert.equal((await read("eligibility",scout,year)).rows[0].free_shirt_eligibility,"unknown");
  await assert.rejects(write(999,command("review_shirt_history",{note:"checked"}),2),/Recording access denied/);
  await assert.rejects(read("events",scout,year,3),/Access denied/);
  await assert.rejects(write(999,command("give_free_item",{item:"tshirt",quantity:1})),/history must be reviewed/);
  await apply("review_shirt_history",{note:"Leader verified current and previous year's records"});
  assert.equal((await read("eligibility",scout,year)).rows[0].free_shirt_eligibility,"eligible");
  const free=await apply("give_free_item",{item:"tshirt",quantity:1,size:"YM"});
  assert.equal((await read("eligibility",scout,year)).rows[0].free_shirt_eligibility,"ineligible");
  await assert.rejects(write(999,command("give_free_item",{item:"tshirt",quantity:1})),/two-year interval/);
  await assert.rejects(write(999,command("record_historical_shirt",{scouting_year:"2025-26",note:"Late historical entry"})),/two-year interval/);
  await assert.rejects(write(999,command("give_free_item",{item:"lion_book",quantity:1,rank_at_issue:"tiger"})),/matching Lion or Tiger/);
  await apply("give_free_item",{item:"tiger_book",quantity:1,rank_at_issue:"tiger"});
  await apply("give_free_item",{item:"first_aid_kit",quantity:1});
  for(const item of ["neckerchief","slider"]) {
   const invalid=command("give_free_item",{item,quantity:1});
   assert.equal(recordOperationSchema.safeParse({request_id:id("3",999),command:invalid}).success,false);
   await assert.rejects(write(999,invalid),/Item is not a free distribution/);
  }
  const loan=await apply("issue_loan",{item:"neckerchief",quantity:2});
  const slider=await apply("issue_loan",{item:"slider",quantity:1});
  const returned=await apply("return_loan",{target_id:loan.event_id,quantity:1,occurred_on:"2026-10-02"});
  await assert.rejects(write(999,command("return_loan",{target_id:loan.event_id,quantity:2,occurred_on:"2026-10-02"})),/exceeds outstanding/);
  await assert.rejects(write(999,command("return_loan",{target_id:loan.event_id,quantity:1,scouting_year:"2025-26"})),/target scouting year/);
  await assert.rejects(write(999,{...command("return_loan",{target_id:loan.event_id,quantity:1}),scout_id:other,expected_revision:0}),/Unknown active target/);
  const loss=await apply("report_loan_loss",{target_id:loan.event_id,quantity:1,amount_minor:1000,currency:"USD",occurred_on:"2026-10-02"});
  const paid1=await apply("pay_loan_loss",{target_id:loss.event_id,amount_minor:400,currency:"USD",occurred_on:"2026-10-03"});
  await assert.rejects(write(999,command("pay_loan_loss",{target_id:loss.event_id,amount_minor:700,currency:"USD",occurred_on:"2026-10-03"})),/exceeds outstanding/);
  const paid2=await apply("pay_loan_loss",{target_id:loss.event_id,amount_minor:600,currency:"USD",occurred_on:"2026-10-03"});
  const loans=await read("loans",scout,year);
  assert.equal(loans.rows.find(r=>r.id===loan.event_id)?.outstanding_quantity,0);
  assert.equal(loans.rows.find(r=>r.id===loan.event_id)?.returned_quantity,1);
  assert.equal(loans.rows.find(r=>r.id===slider.event_id)?.outstanding_quantity,1);
  assert.equal((await read("losses",scout,year)).rows[0].balance_minor,0);
  await assert.rejects(write(999,command("void_equipment_event",{target_id:loss.event_id,note:"Mistake",occurred_on:"2026-10-04"})),/dependent events first/);
  const purchase=await apply("request_purchase",{item:"tshirt",quantity:2,size:"YL"});
  await assert.rejects(write(999,command("pay_purchase",{target_id:purchase.event_id,amount_minor:1000,currency:"USD"})),/Known purchase price/);
  const price=await apply("set_purchase_price",{target_id:purchase.event_id,amount_minor:2000,currency:"USD"});
  await apply("pay_purchase",{target_id:purchase.event_id,amount_minor:1000,currency:"USD"});
  await apply("deliver_purchase",{target_id:purchase.event_id,quantity:1});
  let order=(await read("purchases",scout,year)).rows[0];
  assert.equal(order.balance_minor,1000);assert.equal(order.unfulfilled_quantity,1);
  await assert.rejects(write(999,command("set_purchase_price",{target_id:purchase.event_id,amount_minor:500,currency:"USD"})),/invalidate recorded payments/);
  await assert.rejects(write(999,command("void_equipment_event",{target_id:price.event_id,note:"Bad price"})),/Void payments/);
  await apply("pay_purchase",{target_id:purchase.event_id,amount_minor:1000,currency:"USD"});
  order=(await read("purchases",scout,year)).rows[0];
  assert.equal(order.balance_minor,0);assert.equal(order.unfulfilled_quantity,1); // Paid is not delivered.
  await assert.rejects(write(999,command("deliver_purchase",{target_id:purchase.event_id,quantity:2})),/exceeds unfulfilled/);
  assert.equal((await read("eligibility",scout,year)).rows[0].free_shirt_eligibility,"ineligible"); // Paid shirts never reset entitlement.
  await apply("void_equipment_event",{target_id:paid1.event_id,note:"Correct payment",occurred_on:"2026-10-04"});
  await apply("void_equipment_event",{target_id:paid2.event_id,note:"Correct payment",occurred_on:"2026-10-04"});
  await apply("void_equipment_event",{target_id:loss.event_id,note:"Loss reported in error",occurred_on:"2026-10-04"});
  assert.equal((await read("loans",scout,year)).rows.find(r=>r.id===loan.event_id)?.outstanding_quantity,1);
  const events=await read("events",scout,year);
  assert.equal(events.rows.find(r=>r.id===loss.event_id)?.voided,true);
  assert.equal(events.rows.find(r=>r.id===returned.event_id)?.occurred_on,"2026-10-02");
  await assert.rejects(write(999,command("void_equipment_event",{target_id:loan.event_id,note:"Remove loan",occurred_on:"2026-10-04"})),/dependent events/);
  await assert.rejects(write(999,command("give_free_item",{item:"first_aid_kit",quantity:1,expected_revision:0})),/Revision conflict/);
  // Retries return original result even after newer revisions, never reapply an event.
  const retry=await write(1,{action:"review_shirt_history",scout_id:scout,scouting_year:year,expected_revision:0,occurred_on:"2026-10-01",note:"Leader verified current and previous year's records"});
  assert.equal(retry.revision,1);
  await assert.rejects(write(1,{...command("review_shirt_history"),note:"different"}),/Request ID conflict/);
  await write(900,{action:"record_historical_shirt",scout_id:other,scouting_year:"2025-26",expected_revision:0,occurred_on:"2025-10-01",note:"Historical source supplied by leader"});
  assert.equal((await read("eligibility",other,year)).rows[0].free_shirt_eligibility,"ineligible");
  await assert.rejects(asUser(1,()=>db.exec("delete from public.pack_equipment_events")),/permission denied/);
  await db.exec("update public.leader_access set can_record=false where email='admin@example.test'");
  await assert.rejects(write(1,command("give_free_item",{item:"first_aid_kit",quantity:1})),/Recording access denied/);
  assert.ok(free.event_id);
 } finally {await db.close();}
});

test("atomic batches roll back on stale revisions and reports distinguish unrecorded attendance/registration",async()=>{
 const {db,asUser,write}=await m2Fixture();
 try {
  const year="2026-27",activity=id("2",1);
  await write(1,{action:"create_activity",activity_id:activity,title:"Synthetic meeting",kind:"session",scouting_year:year,occurred_on:"2026-10-01"});
  const entries=[1,2].map((n)=>({request_id:id("3",n+10),command:{action:"record_attendance",scout_id:id("1",n),activity_id:activity,status:"present",expected_revision:0}}));
  const batch=(value:unknown,actor=1)=>asUser(actor,()=>db.query("select public.record_pack_batch($1::jsonb)",[JSON.stringify(value)]));
  await assert.rejects(batch(entries,2),/Recording access denied/);
  await assert.rejects(batch([entries[0],{...entries[1],command:{...entries[1].command,expected_revision:9}}]),/Revision conflict/);
  assert.equal((await db.query<{n:number}>("select count(*)::int n from pack_attendance")).rows[0].n,0);
  await batch(entries);
  assert.equal((await db.query<{n:number}>("select count(*)::int n from pack_attendance")).rows[0].n,2);
  await batch(entries); // same IDs retry as one batch
  const report=async(name:string,act:string|null=null)=>{
   const r=await asUser(2,()=>db.query<{r:{total:number;rows:Record<string,unknown>[]}}>("select public.read_pack_report($1,$2,null,$3::uuid) r",[name,year,act]));return r.rows[0].r;
  };
  assert.equal((await report("activity_attendance",activity)).rows[0].attendance_status,"present");
  assert.equal((await report("registration_gaps")).total,2);
  assert.equal((await report("registration_gaps")).rows[0].scouting_registration,"unknown");
  await write(30,{action:"record_registration",scout_id:id("1",1),scouting_year:year,platform:"active.com",status:"confirmed",expected_revision:0,occurred_on:"2026-09-01"});
  await write(31,{action:"record_registration",scout_id:id("1",1),scouting_year:year,platform:"scouting.org",status:"not_registered",expected_revision:0,occurred_on:"2026-10-01"});
  const gap=(await report("registration_gaps")).rows.find(r=>r.scout_id===id("1",1))!;
  assert.equal(gap.active_registration,"confirmed");assert.equal(gap.scouting_registration,"not_registered");
  assert.equal((await report("badges_pending")).total,0);
  const activity2=id("2",2);
  await write(40,{action:"create_activity",activity_id:activity2,title:"Other meeting",kind:"session",scouting_year:year,occurred_on:"2026-10-02"});
  assert.equal((await report("activity_attendance",activity2)).rows[0].attendance_status,"not_recorded");
  await assert.rejects(asUser(3,()=>db.query("select public.read_pack_report('scout_summary',$1)",[year])),/Access denied/);
 } finally {await db.close();}
});
