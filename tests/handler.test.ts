import { test } from "node:test";
import assert from "node:assert/strict";
import { createHandler, supabaseAuthenticator, type Config } from "../supabase/functions/_shared/handler.ts";

const config: Config = { supabaseUrl: "https://project.supabase.co", publishableKey: "public-test-key", resourceUrl: "https://project.supabase.co/functions/v1/scouts-mcp", allowedOrigin: "https://login.example.test" };
const base = config.resourceUrl;
const headers = { authorization: "Bearer valid", "content-type": "application/json", accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26" };
const call = (method: string, params: unknown = {}) => new Request(base, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
const read = async (response: Response) => {
  const text = await response.text();
  if (text.startsWith("event:") || text.startsWith("data:")) {
    const data = text.split("\n").filter(l => l.startsWith("data: ")).map(l => l.slice(6));
    return JSON.parse(data[data.length - 1]);
  }
  return JSON.parse(text);
};

test("OAuth metadata is public but all MCP methods require verified approval", async () => {
  let accessed = 0;
  const handler = createHandler(config, async token => token === "invalid" ? null : { approved: async () => token === "valid", read: async () => { accessed++; return []; } });
  const metadata = await handler(new Request(`${base}/.well-known/oauth-protected-resource`));
  assert.equal(metadata.status, 200);
  assert.equal((await metadata.json()).resource, base);
  const internalMetadata = await handler(new Request('http://edge-runtime/scouts-mcp/.well-known/oauth-protected-resource'));
  assert.equal(internalMetadata.status, 200);
  assert.equal((await internalMetadata.json()).resource, base);
  const denied = await handler(new Request(base));
  assert.equal(denied.status, 401);
  assert.match(denied.headers.get("www-authenticate")!, /resource_metadata=/);
  assert.equal((await handler(new Request(base, { headers: { authorization: "Bearer invalid" } }))).status, 401);
  assert.equal((await handler(new Request(base, { headers: { authorization: "Bearer stranger" } }))).status, 403);
  assert.equal((await handler(new Request(base, { headers: { origin: "https://evil.test" } }))).status, 403);
  assert.equal(accessed, 0);
});
test("SDK handles initialize, tools/list and actual read-only query calls", async () => {
  let approved = true;
  const handler = createHandler(config, async () => ({ approved: async () => approved, read: async () => [{ id: "a", source_row: 2, scout_name: "Adam Synthetic", den: "0-Lions" }] }));
  const init = await read(await handler(call("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } })));
  assert.equal(init.result.serverInfo.name, "packpilot");
  const tools = await read(await handler(call("tools/list")));
  assert.deepEqual(tools.result.tools.map((t: { name: string }) => t.name).sort(), ["describe_roster", "query_roster"]);
  const answer = await read(await handler(call("tools/call", { name: "query_roster", arguments: { filters: [{ field: "first_name", op: "eq", value: "Adam" }] } })));
  assert.equal(answer.result.structuredContent.total, 1);
  assert.equal(answer.result.structuredContent.rows[0].scout_name, "Adam Synthetic");
  const invalid = await read(await handler(call("tools/call", { name: "query_roster", arguments: { sql: "delete from scouts" } })));
  assert.ok(invalid.error || invalid.result?.isError);
  const write = await read(await handler(call("tools/call", { name: "update_scout", arguments: {} })));
  assert.ok(write.error || write.result?.isError);
  approved = false;
  assert.equal((await handler(call("tools/list"))).status, 403);
});
test("oversized input and unavailable access checks fail closed", async () => {
  const handler = createHandler(config, async () => ({ approved: async () => true, read: async () => [] }));
  assert.equal((await handler(new Request(base, { method: "POST", headers, body: "x".repeat(65537) }))).status, 413);
  const failed = createHandler(config, async () => { throw new Error("secret details"); });
  const response = await failed(call("tools/list"));
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /secret/);
});
test("production authentication calls Supabase verification rather than trusting a decoded token", async () => {
  const oldFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = async input => {
    requests.push(String(input));
    return Response.json({ msg: "invalid token" }, { status: 401 });
  };
  try {
    assert.equal(await supabaseAuthenticator(config)("forged.jwt.token"), null);
    assert.ok(requests.some(url => url.includes("/auth/v1/user")));
  } finally { globalThis.fetch = oldFetch; }
});

test("M2 tools expose write semantics and forward validated commands without caller identity", async () => {
  let input: unknown;
  let allowed = true;
  const handler = createHandler(config, async () => ({
    approved: async () => true, read: async () => [],
    operations: {
      read: async () => ({ total: 0, rows: [], next_offset: null }),
      record: async value => { if (!allowed) throw new Error("Recording access denied"); input = value; return { revision: 1, occurred_on: "2026-10-10" }; },
    },
  }));
  const listed = await read(await handler(call("tools/list")));
  const tool = listed.result.tools.find((t: { name: string }) => t.name === "record_pack_operation");
  assert.equal(tool.annotations.readOnlyHint, false);
  const args = { request_id: "30000000-0000-4000-8000-000000000001", command: {
    action: "record_attendance", activity_id: "20000000-0000-4000-8000-000000000001",
    scout_id: "10000000-0000-4000-8000-000000000001", status: "present", expected_revision: 0,
  } };
  const result = await read(await handler(call("tools/call", { name: "record_pack_operation", arguments: args })));
  assert.equal(result.result.isError, undefined);
  assert.deepEqual(input, args);
  input = undefined;
  const invalid = await read(await handler(call("tools/call", { name: "record_pack_operation", arguments: { ...args, command: { ...args.command, recorded_by: "pretend-admin" } } })));
  assert.ok(invalid.error || invalid.result?.isError);
  assert.equal(input, undefined);
  allowed = false;
  const denied = await read(await handler(call("tools/call", { name: "record_pack_operation", arguments: args })));
  assert.equal(denied.result.isError, true);
  assert.match(denied.result.content[0].text, /Recording access denied/);
  const page = await read(await handler(call("tools/call", { name: "read_pack_operations", arguments: { entity: "attendance" } })));
  assert.deepEqual(JSON.parse(page.result.content[0].text), { total: 0, rows: [], next_offset: null });
});

test("M2 advancement MCP calls expose dated progress, award and delivery separately", async () => {
  const forwarded: unknown[] = [];
  const handler = createHandler(config, async () => ({
    approved: async () => true, read: async () => [],
    operations: {
      read: async () => ({ total: 0, rows: [], next_offset: null }),
      readAdvancement: async input => { forwarded.push(input); return { total: 1, rows: [{ revision: 2, earned_on: "2026-10-10", badge_delivered_on: null }], next_offset: null }; },
      record: async input => { forwarded.push(input); return { revision: 2, earned_on: "2026-10-10", badge_delivered_on: null }; },
    },
  }));
  const list = await read(await handler(call("tools/list")));
  assert.ok(list.result.tools.some((t: { name: string }) => t.name === "read_pack_advancement"));
  const args = { request_id: "30000000-0000-4000-8000-000000000012", command: {
    action: "earn_adventure", scout_id: "10000000-0000-4000-8000-000000000001", adventure_id: "40000000-0000-4000-8000-000000000001",
    scouting_year: "2026-27", expected_revision: 1, occurred_on: "2026-10-10",
  } };
  const result = await read(await handler(call("tools/call", { name: "record_pack_operation", arguments: args })));
  assert.equal(JSON.parse(result.result.content[0].text).earned_on, "2026-10-10");
  assert.equal(JSON.parse(result.result.content[0].text).badge_delivered_on, null);
  assert.deepEqual(forwarded[0], args);
  const response = await read(await handler(call("tools/call", { name: "read_pack_advancement", arguments: { entity: "advancement", scouting_year: "2026-27" } })));
  assert.equal(JSON.parse(response.result.content[0].text).total, 1);
  assert.deepEqual(forwarded[1], { entity: "advancement", scouting_year: "2026-27", page_offset: 0, page_limit: 50 });
});

test("equipment, report and batch MCP tools preserve write annotations and dispatch validated inputs",async()=>{
 const seen:unknown[]=[];
 const handler=createHandler(config,async()=>({approved:async()=>true,read:async()=>[],operations:{
  read:async()=>({total:0,rows:[]}),record:async input=>{seen.push(input);return {revision:1};},
  readEquipment:async input=>{seen.push(input);return {total:1,rows:[{free_shirt_eligibility:"unknown",revision:0}],next_offset:null};},
  readReport:async input=>{seen.push(input);return {total:1,rows:[{scouting_registration:"unknown"}],next_offset:null};},
  readInventory:async input=>{seen.push(input);return {total:1,rows:[{quantity_on_hand:null,revision:1}],next_offset:null};},
  batch:async input=>{seen.push(input);return [{revision:1}];},
 }}));
 const listed=await read(await handler(call("tools/list")));
 assert.equal(listed.result.tools.find((t:{name:string})=>t.name==='record_pack_batch').annotations.readOnlyHint,false);
 assert.equal(listed.result.tools.find((t:{name:string})=>t.name==='read_pack_equipment').annotations.readOnlyHint,true);
 const query=await read(await handler(call('tools/call',{name:'read_pack_equipment',arguments:{entity:'eligibility',scouting_year:'2026-27'}})));
 assert.equal(JSON.parse(query.result.content[0].text).rows[0].free_shirt_eligibility,'unknown');
 const report=await read(await handler(call('tools/call',{name:'read_pack_report',arguments:{report:'registration_gaps',scouting_year:'2026-27'}})));
 assert.equal(JSON.parse(report.result.content[0].text).rows[0].scouting_registration,'unknown');
 const entry={request_id:'30000000-0000-4000-8000-000000000090',command:{action:'issue_loan',scout_id:'10000000-0000-4000-8000-000000000001',scouting_year:'2026-27',expected_revision:0,item:'slider',quantity:1,occurred_on:'2026-10-01'}};
 const batch=await read(await handler(call('tools/call',{name:'record_pack_batch',arguments:{entries:[entry]}})));
 assert.equal(JSON.parse(batch.result.content[0].text)[0].revision,1);
 assert.deepEqual(seen[2],{entries:[entry]});
 const inventory=await read(await handler(call('tools/call',{name:'read_pack_inventory',arguments:{entity:'items'}})));
 assert.equal(JSON.parse(inventory.result.content[0].text).rows[0].quantity_on_hand,null);
 assert.equal(listed.result.tools.find((t:{name:string})=>t.name==='read_pack_inventory').annotations.readOnlyHint,true);
});

test("MCP advertises loan defaults and rejects free neckerchiefs/sliders before any recording", async () => {
 const recorded: unknown[] = [];
 const handler=createHandler(config,async()=>({approved:async()=>true,read:async()=>[],operations:{
  read:async()=>({rows:[]}),record:async input=>{recorded.push(input);return {revision:1};},
  batch:async input=>{recorded.push(input);return [{revision:1}];},
 }}));
 const listed=await read(await handler(call('tools/list')));
 for(const name of ['describe_operations','record_pack_operation','record_pack_batch']) {
  const tool=listed.result.tools.find((t:{name:string})=>t.name===name);
  assert.match(tool.description,/issue_loan/);
  assert.match(tool.description,/explicitly/);
 }
 const guideResult=await read(await handler(call('tools/call',{name:'describe_operations',arguments:{}})));
 const defaults=JSON.parse(guideResult.result.content[0].text).equipment_defaults;
 assert.match(defaults.neckerchief_and_slider,/DEFAULT TO LOANS/);
 assert.match(defaults.purchase_exception,/only when the leader explicitly/);
 const key={scout_id:'10000000-0000-4000-8000-000000000001',scouting_year:'2026-27',expected_revision:0,quantity:1,occurred_on:'2026-10-01'};
 for(const item of ['neckerchief','slider']) {
  const entry={request_id:'30000000-0000-4000-8000-000000000091',command:{...key,item,action:'give_free_item'}};
  for(const [name,args] of [['record_pack_operation',entry],['record_pack_batch',{entries:[entry]}]] as const) {
   const response=await read(await handler(call('tools/call',{name,arguments:args})));
   assert.ok(response.error||response.result?.isError);
   assert.equal(recorded.length,0);
  }
 }
 for(const item of ['neckerchief','slider']) {
  for(const action of ['issue_loan','request_purchase']) {
   const entry={request_id:'30000000-0000-4000-8000-000000000092',command:{...key,item,action}};
   const response=await read(await handler(call('tools/call',{name:'record_pack_operation',arguments:entry})));
   assert.equal(response.error,undefined);assert.equal(response.result.isError,undefined);
  }
 }
 assert.equal(recorded.length,4);
});

test("custom portal and original Pages origin are allowed without admitting lookalike hosts",async()=>{
 const handler=createHandler({...config,allowedOrigins:['https://legacy.packpilot.example','https://packpilot-site.pages.dev']},async()=>null);
 for(const origin of [config.allowedOrigin,'https://legacy.packpilot.example','https://packpilot-site.pages.dev']){
  const response=await handler(new Request(base,{method:'OPTIONS',headers:{origin}}));
  assert.equal(response.status,204);assert.equal(response.headers.get('access-control-allow-origin'),origin);assert.equal(response.headers.get('vary'),'Origin');
 }
 for(const origin of ['https://legacy.packpilot.example.evil.test','http://legacy.packpilot.example','https://unapproved.example.test']){
  const response=await handler(new Request(base,{method:'OPTIONS',headers:{origin}}));
  assert.equal(response.status,403);assert.equal(response.headers.get('access-control-allow-origin'),null);
 }
});
