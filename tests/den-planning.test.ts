import { test } from "node:test";
import assert from "node:assert/strict";
import { m2Fixture, id } from "./helpers/m2.ts";
import { denRecommendations, needsAdventureAction } from "../auth-ui/portal-planning.ts";
import { emptyData, type Adventure } from "../auth-ui/portal-model.ts";

test("recommendations prioritize the most scouts, respect earned awards and never infer completion from missing history", () => {
 const data=emptyData();
 data.scouts=[{id:id("1",1),scout_name:"First",den:"0-Lions"},{id:id("1",2),scout_name:"Second",den:"0-Lions"},{id:id("1",3),scout_name:"Withdrawn",den:"(withdraw) 0-Lions"}];
 const adventure=(n:number,name:string):Adventure=>({id:id("4",n),name,rank:"lion",program_version:"synthetic",source_url:"https://example.test/",requirements:[{code:"1",description:"First"},{code:"2",description:"Second"}],readiness_mode:"automatic",catalog_context:{adventure_type:"Required (Core)"}});
 data.adventures=[adventure(1,"A required"),adventure(2,"B required")];
 data.advancement=[{scout_id:id("1",1),adventure_id:id("4",1),revision:1,earned_on:"2026-10-01",badge_delivered_on:null,badge_form:null}];
 data.progress=[{scout_id:id("1",2),adventure_id:id("4",2),requirement_code:"1",completed_on:"2026-10-01",completion_source:"individual"}];
 const next=denRecommendations(data,"0-Lions");
 assert.equal(next.scouts.length,2);assert.equal(next.pending[0].adventure.id,id("4",2));
 assert.equal(next.pending[0].requirements[0].code,"2");assert.equal(next.pending[0].requirements[0].needed,2);
 assert.equal(next.allRequiredEarned,false);
 assert.equal(needsAdventureAction(data,data.scouts[0],data.adventures[0],"record_requirement","1"),false);
 assert.equal(needsAdventureAction(data,data.scouts[0],data.adventures[0],"deliver_badge"),true);
 assert.equal(needsAdventureAction(data,data.scouts[1],data.adventures[0],"deliver_badge"),false);
 for(const s of data.scouts.slice(0,2)) for(const a of data.adventures) data.advancement.push({scout_id:s.id,adventure_id:a.id,revision:1,earned_on:"2026-10-01",badge_delivered_on:null,badge_form:null});
 assert.equal(denRecommendations(data,"0-Lions").allRequiredEarned,true);
 assert.equal(denRecommendations({...data,adventures:[]},"0-Lions").allRequiredEarned,false);
});

test("den priorities validate two rank-matching electives, recording permission, revisions and retry identity", async () => {
 const {db,asUser,write}=await m2Fixture();
 try {
  for(const [n,rank,type] of [[1,"lion","Elective"],[2,"lion","Elective"],[3,"lion","Required (Core)"],[4,"tiger","Elective"],[5,"lion","Elective"],[6,"lion","Elective"]] as const)
   await db.query("insert into pack_adventures(id,name,rank,program_version,source_url,source_verified_on,requirements,completion_groups,catalog_context,recorded_by) values($1,$2,$3,'test','https://example.test/','2026-10-01','[]','[]',$4::jsonb,$5)",[id("4",n),`Synthetic ${n}`,rank,JSON.stringify({adventure_type:type}),id("0",1)]);
  const cmd={action:"set_den_priorities",den:"0-Lions",scouting_year:"2026-27",adventure_ids:[id("4",1),id("4",2)],expected_revision:0};
  await assert.rejects(write(1,cmd,2),/Recording access denied/);
  for(const ids of [[id("4",1),id("4",1)],[id("4",1),id("4",3)],[id("4",1),id("4",4)]])
   await assert.rejects(write(2,{...cmd,adventure_ids:ids}),/distinct electives/);
  assert.deepEqual(await write(3,cmd),await write(3,cmd));
  await assert.rejects(write(4,cmd),/Revision conflict/);
  await assert.rejects(write(3,{...cmd,adventure_ids:[id("4",2),id("4",1)]}),/Request ID conflict/);
  const next=await write(5,{...cmd,adventure_ids:[id("4",5),id("4",6)],expected_revision:1});
  assert.equal(next.revision,2);
  const read=await asUser(2,()=>db.query<{r:unknown[]}>("select read_pack_den_plans('2026-27') r"));
  assert.equal(read.rows[0].r.length,1);
  await assert.rejects(asUser(3,()=>db.query("select read_pack_den_plans('2026-27')")),/Access denied/);
  await assert.rejects(asUser(1,()=>db.query("update pack_den_plans set revision=99")),/permission denied/);
 } finally {await db.close();}
});
