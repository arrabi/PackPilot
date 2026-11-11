import {assistantEnvironmentEnabled} from '../supabase/functions/_shared/assistant-environment.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {m2Fixture,id} from './helpers/m2.ts';
import {createAssistantHandler,prepareAssistantChange,runAssistantChat,adventureStatus,type AssistantStore} from '../supabase/functions/_shared/assistant.ts';
import {createAssistantSelfTest} from '../supabase/functions/_shared/assistant-self-test.ts';

const scout=id('1',1),activity=id('2',1);
const config={supabaseUrl:'https://staging.example.test',publishableKey:'public',origins:['https://app.example.test'],enabled:true};
const request=(body:unknown,token='test')=>new Request('https://api.example.test',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`,Origin:'https://app.example.test'},body:JSON.stringify(body)});
const command={action:'record_attendance' as const,scout_id:scout,activity_id:activity,occurred_on:'2026-10-01',status:'present' as const};
const toolResponse=(name:string,args:unknown,callId='call')=>Response.json({status:'completed',output:[{type:'function_call',call_id:callId,name,arguments:JSON.stringify(args)}]});
const textResponse=(text:string)=>Response.json({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text}]}]});

test('a real-model-style count call with null filters can finish in plain text after one read',async()=>{
 let round=0,reads=0;
 const store:AssistantStore={async roster(){reads++;return[{id:scout,scout_name:'First',den:'0-Lions'},{id:id('1',2),scout_name:'Withdrawn',den:'(withdraw) 0-Lions'}];},async rpc(){return true;}};
 const fetcher:typeof fetch=async(_url,options)=>{
  const body=JSON.parse(String(options?.body));
  if(round++===0){assert.equal(body.tool_choice,'required');return toolResponse('count_scouts',{den:null});}
  assert.equal(body.tool_choice,'auto');
  const data=JSON.parse(body.input.at(-1).output);assert.equal(data.active_count,1);assert.equal(data.roster_count,2);
  return textResponse('There is 1 active scout and 2 total roster records.');
 };
 const reply=await runAssistantChat(store,{action:'chat',context:{den:'',year:'2026-27'},messages:[{role:'user',content:'Who still needs Bobcat?'},{role:'user',content:'how many scouts are there?'}]},'fake','fake',fetcher);
 assert.equal(reads,1);assert.match(reply.message,/1 active scout/);
});

test('a short respond call needs no artificial title/items, and validation feedback identifies the failed field',async()=>{
 let round=0;
 const store:AssistantStore={async roster(){return[];},async rpc(){return true;}};
 const fetcher:typeof fetch=async(_url,options)=>{
  const body=JSON.parse(String(options?.body));
  if(round++===0)return toolResponse('find_scouts',{offset:-1});
  const error=JSON.parse(body.input.at(-1).output);assert.equal(error.issues[0].path,'offset');assert.equal(error.issues[0].code,'too_small');
  return toolResponse('respond',{message:'Please choose a den.'});
 };
 const reply=await runAssistantChat(store,{action:'chat',context:{den:'',year:'2026-27'},messages:[{role:'user',content:'Help with my scouts'}]},'fake','fake',fetcher);
 assert.equal(reply.message,'Please choose a den.');
});

test('null or empty arguments for an unfiltered count are read as an empty object, not a database failure',async()=>{
 for(const argumentsText of ['null','', '{}']){
  let calls=0;
  const store:AssistantStore={async roster(){return[{id:scout,scout_name:'Synthetic',den:'0-Lions'}];},async rpc(){return true;}};
  const fetcher:typeof fetch=async(_url,options)=>{
   const body=JSON.parse(String(options?.body));
   if(calls++===0)return Response.json({status:'completed',output:[{type:'function_call',call_id:'call',name:'count_scouts',arguments:argumentsText}]});
   const data=JSON.parse(body.input.at(-1).output);assert.equal(data.active_count,1);
   return textResponse('There is 1 active scout.');
  };
  const reply=await runAssistantChat(store,{action:'chat',context:{den:'',year:'2026-27'},messages:[{role:'user',content:'how many scouts are there?'}]},'fake','fake',fetcher);
  assert.match(reply.message,/1 active/);assert.equal(calls,2);
 }
});

test('Bobcat status joins all ranks and pages, excludes withdrawn scouts and preserves unknown award state',async()=>{
 const store:AssistantStore={async roster(){return[{id:scout,scout_name:'Earned',den:'0-Lions'},{id:id('1',2),scout_name:'No record',den:'1-Tigers'},{id:id('1',3),scout_name:'Withdrawn',den:'(withdraw) 1-Tigers'}];},async rpc(_name,args){
  if(args?.entity==='adventures')return{rows:[{id:id('4',1),name:'Bobcat',rank:'lion'},{id:id('4',2),name:'Bobcat',rank:'tiger'}],next_offset:null};
  if(!args?.page_offset)return{rows:[{scout_id:scout,adventure_id:id('4',1),earned_on:'2026-10-01'}],next_offset:100};
  return{rows:[],next_offset:null};
 }};
 const result=await adventureStatus(store,{name:'Bobcat',scouting_year:'2026-27'});
 assert.equal(result.total,1);assert.equal(result.earned,1);assert.equal(result.rows[0].scout_name,'No record');assert.equal(result.rows[0].status,'no award recorded');
});

test('live-model self-test requires a trusted deployment and cannot be invoked by an ordinary leader token',async()=>{
 let calls=0;
 const fetcher:typeof fetch=async()=>{calls++;return toolResponse('respond',{message:'There are 3 active scouts in the synthetic fixture.'});};
 const req=(token:string)=>new Request('https://example.test/self-test',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({scenario:'count'})});
 assert.equal((await createAssistantSelfTest({enabled:false,serviceKey:'admin',model:'fake'},fetcher)(req('admin'))).status,404);
 const handler=createAssistantSelfTest({enabled:true,serviceKey:'admin',apiKey:'fake',model:'fake'},fetcher);
 assert.equal((await handler(req('ordinary-leader'))).status,401);assert.equal(calls,0);
 const result=await handler(req('admin'));assert.equal(result.status,200);assert.equal((await result.json()).passed,true);assert.equal(calls,1);
});

test('assistant authenticates before setup and rejects foreign origins and disabled deployments',async()=>{
 const handler=createAssistantHandler(config,{authenticate:async()=>null});
 assert.equal((await handler(request({action:'chat'}))).status,401);
 const foreign=request({});foreign.headers.set('Origin','https://evil.example.test');
 assert.equal((await handler(foreign)).status,403);
 assert.equal((await createAssistantHandler({...config,enabled:false})(request({}))).status,404);
 const store:AssistantStore={async rpc(){return true;},async roster(){return[];}};
 const setup=await createAssistantHandler(config,{authenticate:async()=>store})(request({action:'chat',context:{den:'',year:'2026-27'},messages:[{role:'user',content:'Hello'}]}));
 assert.equal(setup.status,503);assert.equal((await setup.json()).code,'setup');
 const huge=await createAssistantHandler(config,{authenticate:async()=>store})(request({text:'x'.repeat(49000)}));assert.equal(huge.status,413);
});

test('assistant loop only exposes read tools and draft proposals, not confirmation or arbitrary SQL',async()=>{
 const names:string[]=[];
 const store:AssistantStore={async rpc(name){names.push(name);return true;},async roster(){return[{id:scout,scout_name:'Synthetic Scout',den:'0-Lions',parent_1_email:'private@example.test'}];}};
 let round=0;
 const fakeFetch:typeof fetch=async(_url,options)=>{
  const body=JSON.parse(String(options?.body));
  assert.equal(body.store,false);
  const tools=body.tools.map((t:any)=>t.name);
  assert(!tools.includes('confirm_pack_assistant_change'));assert(!tools.includes('record_pack_operation'));
  if(round===1){const data=JSON.parse(body.input.at(-1).output);assert(!JSON.stringify(data).includes('private@example.test'));}
  const name=round++===0?'find_scouts':'respond';
  const args=name==='find_scouts'?{name:'Synthetic'}:{kind:'results',message:'One scout found.',title:'Matching scouts',items:[{label:'Synthetic Scout',detail:'Lions',scout_id:scout}]};
  return toolResponse(name,args,'call'+round);
 };
 const result=await runAssistantChat(store,{action:'chat',context:{den:'0-Lions',year:'2026-27'},messages:[{role:'user',content:'Find Synthetic'}]},'not-a-real-key','test-model',fakeFetch);
 assert.equal(result.card?.kind,'results');assert.deepEqual(names,['consume_pack_assistant_budget']);
});

test('database proposals are owner-bound, atomic, revocable and replay-safe; canonical reviews use actual records',async()=>{
 const f=await m2Fixture();
 try{
  await f.db.exec(await readFile(new URL('../supabase/migrations/20261109010000_fieldbook_assistant.sql',import.meta.url),'utf8'));
  await f.write(90,{action:'create_activity',activity_id:activity,title:'Synthetic meeting',kind:'session',scouting_year:'2026-27',occurred_on:'2026-10-01'});
  const rpc=async(name:string,args:Record<string,unknown>={})=>{
   const keys=Object.keys(args);assert(/^[a-z_]+$/.test(name));assert(keys.every(k=>/^[a-z_]+$/.test(k)));
   const result=await f.asUser(1,()=>f.db.query<{result:any}>(`select public.${name}(${keys.map((k,i)=>`${k} => $${i+1}`).join(',')}) result`,keys.map(k=>typeof args[k]==='object'?JSON.stringify(args[k]):args[k])));
   return result.rows[0].result;
  };
  const store:AssistantStore={rpc,async roster(){return[{id:scout,scout_name:'First Synthetic',den:'1-Tigers'}];}};
  const review=await prepareAssistantChange(store,[command]);assert.equal(review.card?.kind,'review');
  if(review.card?.kind!=='review')throw Error('Missing review');
  const proposal=review.card;
  assert.equal(proposal.rows[0].label,'First Synthetic');assert(proposal.rows[0].detail.includes('Synthetic meeting'));
  assert.equal((await f.db.query('select * from public.pack_attendance')).rows.length,0);
  await assert.rejects(f.asUser(2,()=>f.db.query('select public.confirm_pack_assistant_change($1)',[proposal.id])),/Recording access denied/);
  await assert.rejects(f.asUser(2,()=>f.db.query('select public.read_pack_assistant_change($1)',[proposal.id])),/Proposal unavailable/);
  await f.db.exec("insert into public.leader_access(email,can_record) values('stranger@example.test',true)");
  await assert.rejects(f.asUser(3,()=>f.db.query('select public.confirm_pack_assistant_change($1)',[proposal.id])),/Proposal unavailable/);
  await assert.rejects(f.asUser(1,()=>f.db.query('select * from private.pack_assistant_proposals')),/permission denied/);
  await rpc('confirm_pack_assistant_change',{proposal_id:proposal.id});
  await rpc('confirm_pack_assistant_change',{proposal_id:proposal.id});
  assert.equal((await f.db.query('select * from public.pack_attendance')).rows.length,1);
  assert.equal((await f.db.query<{revision:number}>('select revision from public.pack_attendance')).rows[0].revision,1);
  const old=await prepareAssistantChange(store,[{...command,status:'absent'}]);
  const newer=await prepareAssistantChange(store,[{...command,status:'excused'}]);
  if(old.card?.kind!=='review'||newer.card?.kind!=='review')throw Error('Missing reviews');
  await assert.rejects(rpc('confirm_pack_assistant_change',{proposal_id:old.card.id}),/expired or cancelled/);
  await f.write(91,{...command,status:'absent',expected_revision:1});
  await assert.rejects(rpc('confirm_pack_assistant_change',{proposal_id:newer.card.id}),/Revision conflict/);
  assert.equal((await f.db.query<{status:string}>('select status from public.pack_attendance')).rows[0].status,'absent');
  await rpc('cancel_pack_assistant_change',{proposal_id:newer.card.id});
  await assert.rejects(rpc('confirm_pack_assistant_change',{proposal_id:newer.card.id}),/cancelled/);
  const expiring=await prepareAssistantChange(store,[command]);if(expiring.card?.kind!=='review')throw Error('Missing review');
  await f.db.query("update private.pack_assistant_proposals set expires_at=now()-interval '1 second' where id=$1",[expiring.card.id]);
  await assert.rejects(rpc('confirm_pack_assistant_change',{proposal_id:expiring.card.id}),/expired/);
  for(let i=0;i<40;i++)await rpc('consume_pack_assistant_budget');
  await assert.rejects(rpc('consume_pack_assistant_budget'),/hourly limit/);
  await f.db.query('delete from public.pack_attendance where scout_id=$1',[scout]);
  await f.db.query('delete from public.scouts where id=$1',[scout]);
  assert.equal((await f.db.query('select * from private.pack_assistant_proposals')).rows.length,0);
 }finally{await f.db.close();}
});

test('adventure search resolves names and rank across catalog pages without returning the entire catalog to the model',async()=>{
 let pages=0,round=0;
 const store:AssistantStore={async roster(){return[];},async rpc(name,args){
  if(name==='consume_pack_assistant_budget')return;
  assert.equal(name,'read_pack_advancement');pages++;
  return args?.page_offset===0?{rows:[{id:id('4',1),name:'Other adventure',rank:'lion'}],next_offset:100}:{rows:[{id:id('4',2),name:'Bobcat',rank:'lion',requirements:[{code:'1',description:'Synthetic requirement'}]},{id:id('4',3),name:'Bobcat',rank:'tiger'}],next_offset:null};
 }};
 const fetcher:typeof fetch=async(_url,options)=>{
  const body=JSON.parse(String(options?.body));
  if(round){const result=JSON.parse(body.input.at(-1).output);assert.equal(result.total,1);assert.equal(result.rows[0].rank,'lion');}
  const name=round++?'respond':'find_adventures';
  const args=name==='find_adventures'?{name:'Bobcat',rank:'lion'}:{kind:'text',message:'Found the Lion Bobcat definition.',title:'',items:[]};
  return toolResponse(name,args,'call'+round);
 };
 const result=await runAssistantChat(store,{action:'chat',context:{den:'0-Lions',year:'2026-27'},messages:[{role:'user',content:'Find Bobcat'}]},'synthetic','synthetic',fetcher);
 assert.equal(pages,2);assert.equal(result.message,'Found the Lion Bobcat definition.');
});

test('a bad member of a proposal rolls back the full batch',async()=>{
 const f=await m2Fixture();
 try{
  await f.db.exec(await readFile(new URL('../supabase/migrations/20261109010000_fieldbook_assistant.sql',import.meta.url),'utf8'));
  await f.write(90,{action:'create_activity',activity_id:activity,title:'Synthetic meeting',kind:'session',scouting_year:'2026-27',occurred_on:'2026-10-01'});
  const entries=[{request_id:id('3',92),command:{...command,expected_revision:0}},{request_id:id('3',93),command:{...command,scout_id:id('1',999),expected_revision:0}}];
  const p=await f.asUser(1,()=>f.db.query<{proposal:any}>('select public.prepare_pack_assistant_change($1,$2) proposal',[JSON.stringify(entries),JSON.stringify({rows:[]})]));
  await assert.rejects(f.asUser(1,()=>f.db.query('select public.confirm_pack_assistant_change($1)',[p.rows[0].proposal.id])));
  assert.equal((await f.db.query('select * from public.pack_attendance')).rows.length,0);
 }finally{await f.db.close();}
});


test('scout cards recover omitted IDs only from unique authorized full names and reject unknown IDs',async()=>{
 const store:AssistantStore={async rpc(){return true;},async roster(){return[{id:scout,scout_name:'Maya Test',den:'0-Lions'},{id:id('1',2),scout_name:'Sam Test',den:'0-Lions'},{id:id('1',3),scout_name:'Sam Test',den:'1-Tigers'}];}};
 for(const kind of ['results','choices']){
  const fetcher:typeof fetch=async()=>toolResponse('respond',{kind,message:'Matching scouts.',items:[{label:'Maya Test',detail:'Bobcat not earned'},{label:'Sam Test',detail:'Bobcat not earned'},{label:'Maya',detail:'Partial name'},{label:'Maya Test',detail:'Invalid explicit identity',scout_id:id('1',999)},{label:'Total',detail:'3 scouts'}]});
  const reply=await runAssistantChat(store,{action:'chat',context:{den:'',year:'2026-27'},messages:[{role:'user',content:'Who needs Bobcat?'}]},'fake','fake',fetcher);
  assert(reply.card?.kind==='results'||reply.card?.kind==='choices');
  assert.deepEqual(reply.card.items.map(item=>item.scout_id),[scout,undefined,undefined,undefined,undefined]);
 }
});

test('model compatibility diagnostics distinguish a working minimal chat from a rejected tool request without exposing provider bodies',async()=>{
 const calls:Record<string,any>[]=[];
 const fetcher:typeof fetch=async(url,options)=>{
  assert.equal(url,'https://api.openai.com/v1/responses');
  const body=JSON.parse(String(options?.body));calls.push(body);
  assert.equal(body.temperature,1);assert.equal(body.store,false);assert.equal(body.max_output_tokens,3000);assert.equal(body.model,'gpt-6-luna');
  if(!body.tools)return textResponse('READY');
  return Response.json({error:{code:'unsupported_parameter',type:'invalid_request_error',param:'parallel_tool_calls',message:'Secret prompt and sk-private-key-must-not-leak',api_key:'sk-private-key-must-not-leak'}},{status:400});
 };
 const handler=createAssistantSelfTest({enabled:true,serviceKey:'admin',apiKey:'fake',model:'gpt-6-luna'},fetcher);
 const req=(scenario:string,token='admin')=>new Request('https://example.test/self-test',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({scenario})});
 assert.equal((await handler(req('provider','leader'))).status,401);assert.equal(calls.length,0);
 const minimal=await handler(req('provider'));assert.equal(minimal.status,200);assert.equal((await minimal.json()).passed,true);assert.equal(calls.length,1);
 assert.equal(calls[0].tools,undefined);assert(!JSON.stringify(calls[0]).includes('Synthetic'));
 const full=await handler(req('count'));assert.equal(full.status,502);
 const value=await full.json();assert.deepEqual(value.provider,{status:400,code:'unsupported_parameter',type:'invalid_request_error',param:'parallel_tool_calls'});
 assert(!JSON.stringify(value).includes('Secret prompt'));assert(!JSON.stringify(value).includes('sk-private'));
 assert.equal(calls[1].store,false);assert.equal(calls[1].max_output_tokens,3000);
 assert.equal((await createAssistantSelfTest({enabled:false,serviceKey:'admin',apiKey:'fake',model:'gpt-6-luna'},fetcher)(req('provider'))).status,404);
});

test('provider diagnostics suppress unrecognized error fields and malformed non-JSON responses',async()=>{
 const handler=(response:()=>Response)=>createAssistantSelfTest({enabled:true,serviceKey:'admin',apiKey:'fake',model:'fake'},async()=>response());
 const req=()=>new Request('https://example.test/self-test',{method:'POST',headers:{Authorization:'Bearer admin','Content-Type':'application/json'},body:JSON.stringify({scenario:'provider'})});
 for(const response of [()=>Response.json({error:{code:'sk-secret-token',type:'key@example.test',param:'sk-secret-token',message:'private'}},{status:401}),()=>new Response('private provider HTML',{status:502})]){
  const value=await(await handler(response)(req())).json();
  assert.deepEqual(value.provider,{status:response().status});assert(!JSON.stringify(value).includes('private'));
 }
});

test('unsupported provider options adapt within bounds while retaining tools, privacy, temperature and token limits',async()=>{
 const bodies:Record<string,any>[]=[],reads:string[]=[],trace:any[]=[];
 const store:AssistantStore={async rpc(name){reads.push(name);},async roster(){return[{id:scout,scout_name:'Synthetic Scout',den:'0-Lions'}];}};
 const fetcher:typeof fetch=async(_url,options)=>{
  const body=JSON.parse(String(options?.body));bodies.push(body);
  assert.equal(body.temperature,1);assert.equal(body.store,false);assert(body.tools.length>0);
  assert.equal(body.max_output_tokens,3000);
  if('parallel_tool_calls'in body)return Response.json({error:{code:'unsupported_parameter',param:'parallel_tool_calls'}},{status:400});
  if('tool_choice'in body)return Response.json({error:{code:'unsupported_value',param:'tool_choice'}},{status:400});
  if(bodies.length===3)return toolResponse('count_scouts',{});
  return textResponse('There is 1 active scout.');
 };
 const result=await runAssistantChat(store,{action:'chat',context:{den:'',year:'2026-27'},messages:[{role:'user',content:'How many scouts?'}]},'fake','gpt-6-luna',fetcher,event=>trace.push(event));
 assert.match(result.message,/1 active scout/);assert.equal(bodies.length,4);
 assert.equal(reads.filter(name=>name==='consume_pack_assistant_budget').length,1);
 assert.deepEqual(trace.filter(t=>t.outcome==='provider_retry').map(t=>t.provider.param),['parallel_tool_calls','tool_choice']);
 assert(!reads.some(name=>/prepare|confirm|record/.test(name)));
});

test('compatibility handling never drops tools or storage protection, retries auth failures, or accepts an answer before a read',async()=>{
 const store:AssistantStore={async rpc(){},async roster(){return[];}};
 for(const [status,param] of [[400,'store'],[400,'tools'],[401,'tool_choice'],[429,'parallel_tool_calls']] as const){
  let calls=0;
  await assert.rejects(runAssistantChat(store,{action:'chat',context:{den:'',year:'2026-27'},messages:[{role:'user',content:'How many scouts?'}]},'fake','fake',async()=>{calls++;return Response.json({error:{code:'unsupported_parameter',param}},{status});}));
  assert.equal(calls,1);
 }
 let calls=0;
 await assert.rejects(runAssistantChat(store,{action:'chat',context:{den:'',year:'2026-27'},messages:[{role:'user',content:'How many scouts?'}]},'fake','fake',async()=>++calls===1?Response.json({error:{code:'unsupported_parameter',param:'tool_choice'}},{status:400}):textResponse('An unverified invented answer.')),/could not finish/);
 assert.equal(calls,2);
});

test('technical provider messages are available only in fixed fictional admin probes and redact configured keys',async()=>{
 const handler=createAssistantSelfTest({enabled:true,serviceKey:'test-admin-token',apiKey:'test-private-api-token',model:'fake'},async()=>Response.json({error:{type:'invalid_request_error',message:'Unsupported option for test-private-api-token and Bearer test-admin-token and sk-masked-key'}},{status:400}));
 const req=new Request('https://example.test/self-test',{method:'POST',headers:{Authorization:'Bearer test-admin-token','Content-Type':'application/json'},body:JSON.stringify({scenario:'provider'})});
 const value=await(await handler(req)).json();assert.match(value.providerMessage,/Unsupported option/);
 assert(!JSON.stringify(value).includes('test-private-api-token'));assert(!JSON.stringify(value).includes('test-admin-token'));assert(!JSON.stringify(value).includes('sk-masked'));
});

test('Responses preserves encrypted reasoning and call_id correlation without storing state or disabling reasoning',async()=>{
 const requests:Record<string,any>[]=[],rpcCalls:unknown[]=[],trace:unknown[]=[];
 const reasoning={type:'reasoning',id:'rs_test',summary:[],encrypted_content:'opaque-private-reasoning'};
 const store:AssistantStore={async rpc(name,args){rpcCalls.push({name,args});},async roster(){return[{id:scout,scout_name:'Synthetic Scout',den:'0-Lions'}];}};
 const fetcher:typeof fetch=async(url,options)=>{
  assert.equal(url,'https://api.openai.com/v1/responses');
  const body=JSON.parse(String(options?.body));requests.push(body);
  assert.equal(body.store,false);assert.equal(body.temperature,1);assert.equal(body.max_output_tokens,3000);
  assert.deepEqual(body.include,['reasoning.encrypted_content']);
  for(const field of ['messages','max_tokens','max_completion_tokens','previous_response_id','conversation','reasoning_effort','reasoning'])assert(!Object.hasOwn(body,field),field);
  assert(body.tools.every((tool:any)=>tool.type==='function'&&tool.strict===false&&typeof tool.name==='string'&&!tool.function));
  if(requests.length===1)return Response.json({status:'completed',output:[reasoning,{type:'function_call',id:'fc_not_the_call_id',call_id:'call_count',name:'count_scouts',arguments:'{}'}]});
  assert.deepEqual(body.input.find((item:any)=>item.type==='reasoning'),reasoning);
  const output=body.input.at(-1);assert.equal(output.type,'function_call_output');assert.equal(output.call_id,'call_count');assert.equal(JSON.parse(output.output).active_count,1);
  return Response.json({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'There is 1 active scout.'},{type:'output_text',text:'All are Lions.'}]}]});
 };
 const reply=await runAssistantChat(store,{action:'chat',context:{den:'',year:'2026-27'},messages:[{role:'user',content:'How many scouts?'}]},'fake','gpt-6-luna',fetcher,event=>trace.push(event));
 assert.equal(reply.message,'There is 1 active scout.\nAll are Lions.');assert.equal(requests.length,2);
 assert(!JSON.stringify({reply,rpcCalls,trace}).includes(reasoning.encrypted_content));
});

test('incomplete, refused and invalid Responses calls cannot execute record tools or return partial answers',async()=>{
 const call={type:'function_call',call_id:'call_one',name:'prepare_changes',arguments:JSON.stringify({commands:[command]})};
 const variants=[{status:'incomplete',output:[call]}, {status:'completed',output:[{...call,status:'incomplete'}]}, {status:'completed',output:[{...call,call_id:''}]}, {status:'completed',output:[{...call,arguments:null}]}, {status:'completed',output:[{...call,status:'in_progress'}]}, {status:'completed',output:[call,call]}, {status:'completed',output:[{type:'message',content:[{type:'refusal',refusal:'Unable to answer.'}]},call]}, {status:'completed',output:[{type:'message',role:'assistant',content:[{type:'refusal',refusal:'Unable to answer.'}]}]}, {status:'failed',output:[]}];
 for(const body of variants){
  const calls:string[]=[];let fetchCalls=0;
  const store:AssistantStore={async rpc(name){calls.push(name);},async roster(){calls.push('roster');throw new Error('No lookup should execute');}};
  await assert.rejects(runAssistantChat(store,{action:'chat',context:{den:'',year:'2026-27'},messages:[{role:'user',content:'Update the records'}]},'fake','gpt-6-luna',async()=>{fetchCalls++;return Response.json(body);}));
  assert.deepEqual(calls,['consume_pack_assistant_budget']);assert.equal(fetchCalls,1);
 }
});

test('the last Responses round uses a flat forced respond tool and cached reads keep matching call IDs',async()=>{
 let round=0,rosterReads=0;
 const store:AssistantStore={async rpc(){},async roster(){rosterReads++;return[{id:scout,scout_name:'Synthetic Scout',den:'0-Lions'}];}};
 const fetcher:typeof fetch=async(_url,options)=>{
  const body=JSON.parse(String(options?.body));
  if(round>0){const result=body.input.at(-1);assert.equal(result.type,'function_call_output');assert.equal(result.call_id,'call'+round);}
  if(++round===8){assert.deepEqual(body.tool_choice,{type:'function',name:'respond'});return toolResponse('respond',{message:'There is 1 active scout.'},'call8');}
  return toolResponse('count_scouts',{},'call'+round);
 };
 const reply=await runAssistantChat(store,{action:'chat',context:{den:'',year:'2026-27'},messages:[{role:'user',content:'How many scouts?'}]},'fake','gpt-6-luna',fetcher);
 assert.equal(reply.message,'There is 1 active scout.');assert.equal(round,8);assert.equal(rosterReads,1);
});


test('fictional diagnostic failures redact reasoning echoed by an upstream validation error',async()=>{
 let round=0;
 const handler=createAssistantSelfTest({enabled:true,serviceKey:'test-admin-token',apiKey:'test-private-token',model:'gpt-6-luna'},async()=>{
  if(round++===0)return Response.json({status:'completed',output:[{type:'reasoning',id:'rs_test',summary:[{type:'summary_text',text:'private reasoning summary'}],encrypted_content:'opaque-private-reasoning'},{type:'function_call',call_id:'call_count',name:'count_scouts',arguments:'{}'}]});
  return Response.json({error:{type:'invalid_request_error',message:'Invalid reasoning opaque-private-reasoning with private reasoning summary'}},{status:400});
 });
 const req=new Request('https://example.test/self-test',{method:'POST',headers:{Authorization:'Bearer test-admin-token','Content-Type':'application/json'},body:JSON.stringify({scenario:'count'})});
 const response=await handler(req),body=await response.json();assert.equal(response.status,502);
 assert.equal(body.providerMessage,undefined);assert.deepEqual(body.provider,{status:400,type:'invalid_request_error'});assert(!JSON.stringify(body).includes('opaque-private-reasoning'));assert(!JSON.stringify(body).includes('private reasoning summary'));
});


test('production activation preserves leader authentication and rejects staging origins',async()=>{
 assert(assistantEnvironmentEnabled('production'));assert(assistantEnvironmentEnabled('staging'));
 for(const environment of [undefined,'development','preview',''])assert(!assistantEnvironmentEnabled(environment));
 const store:AssistantStore={async rpc(name){return name==='is_approved_leader'?true:undefined;},async roster(){return[{id:scout,scout_name:'Synthetic Scout',den:'0-Lions'}];}};
 let calls=0;
 const handler=createAssistantHandler({...config,supabaseUrl:'https://aaaaaaaaaaaaaaaaaaaa.supabase.co',origins:['https://packpilot.example'],enabled:assistantEnvironmentEnabled('production'),apiKey:'fake',model:'gpt-6-luna'},{authenticate:async token=>token==='leader'?store:null,fetcher:async()=>++calls===1?toolResponse('count_scouts',{}):textResponse('There is 1 active scout.')});
 const body={action:'chat',context:{den:'',year:'2026-27'},messages:[{role:'user',content:'How many scouts?'}]};
 const productionRequest=(token:string,origin='https://packpilot.example')=>{const req=request(body,token);req.headers.set('Origin',origin);return req;};
 assert.equal((await handler(productionRequest('stranger'))).status,401);
 assert.equal((await handler(productionRequest('leader','https://staging.packpilot.example'))).status,403);assert.equal(calls,0);
 const response=await handler(productionRequest('leader'));assert.equal(response.status,200);assert.match((await response.json()).message,/1 active scout/);
});

test('scheduled retention expires only old assistant copies and usage, keeping current reviews and scout records',async()=>{
 const f=await m2Fixture();
 try{
  await f.db.exec(await readFile(new URL('../supabase/migrations/20261109010000_fieldbook_assistant.sql',import.meta.url),'utf8'));
  await f.db.exec(`insert into private.pack_assistant_proposals(actor_id,entries,preview,created_at,state)values('${id('0',1)}','[]','{}',now()-interval '8 days','saved'),('${id('0',1)}','[]','{}',now()-interval '8 days','pending'),('${id('0',1)}','[]','{}',now(),'pending');insert into private.pack_assistant_usage(actor_id,hour,requests)values('${id('0',1)}',now()-interval '3 days',1),('${id('0',1)}',now(),1);`);
  await f.db.exec(await readFile(new URL('../scripts/release/assistant-retention.sql',import.meta.url),'utf8'));
  assert.equal((await f.db.query('select * from private.pack_assistant_proposals')).rows.length,1);
  assert.equal((await f.db.query('select * from private.pack_assistant_usage')).rows.length,1);
  assert.equal((await f.db.query('select * from public.scouts')).rows.length,2);
 }finally{await f.db.close();}
});
