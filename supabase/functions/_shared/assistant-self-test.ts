import {readProviderError} from './assistant-provider-error.ts';
import {runAssistantChat,type AssistantStore,type AssistantTrace,AssistantError} from './assistant.ts';

const uuid=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const scouts=[
 {id:uuid(1),scout_name:'Synthetic Ada',den:'0-Lions'},
 {id:uuid(2),scout_name:'Synthetic Ben',den:'0-Lions'},
 {id:uuid(3),scout_name:'Synthetic Carol',den:'1-Tigers'},
 {id:uuid(4),scout_name:'Synthetic Withdrawn',den:'(withdraw) 0-Lions'},
];
const catalog=[{id:uuid(10),name:'Bobcat',rank:'lion',program_version:'synthetic',requirements:[]},{id:uuid(11),name:'Bobcat',rank:'tiger',program_version:'synthetic',requirements:[]}];
const store:AssistantStore={
 async roster(){return scouts;},
 async rpc(name,args){
  if(name==='consume_pack_assistant_budget')return;
  if(name==='read_pack_advancement'){
   const rows=args?.entity==='adventures'?catalog:args?.entity==='advancement'?[{scout_id:uuid(1),adventure_id:uuid(10),earned_on:'2026-10-01'}]:[];
   return{total:rows.length,rows,next_offset:null};
  }
  if(name==='read_pack_report')return{total:scouts.length,rows:scouts.map(s=>({scout_id:s.id,scout_name:s.scout_name,den:s.den})),next_offset:null};
  throw new Error('The self-test cannot access real records or write operations.');
 },
};
export interface SelfTestConfig {enabled:boolean;serviceKey?:string;apiKey?:string;model:string}
/** Admin-only staging probe. The model receives fixed fictional data only. */
export function createAssistantSelfTest(config:SelfTestConfig,fetcher:typeof fetch=fetch){
 return async(req:Request)=>{
  const headers={'Content-Type':'application/json','Cache-Control':'no-store'};
  const reply=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers});
  if(!config.enabled)return reply({error:'Not found'},404);
  if(req.method!=='POST')return reply({error:'Method not allowed'},405);
  if(!config.serviceKey||req.headers.get('authorization')!==`Bearer ${config.serviceKey}`)return reply({error:'Administrator authentication required'},401);
  if(!config.apiKey)return reply({configured:false,skipped:true});
  let input;try{input=await req.json();}catch{return reply({error:'Invalid request'},400);}
  if(!['provider','count','bobcat'].includes(input?.scenario))return reply({error:'Choose provider, count or bobcat'},400);
  let providerMessage:string|undefined;
  const diagnosticFetch:typeof fetch=async(...args)=>{
   const response=await fetcher(...args);
   if(response.status===400){
    try{
     const message=(await response.clone().json())?.error?.message;
     if(typeof message==='string'&&/^(unsupported|invalid|unknown|unrecognized|missing|this model|the model|only|parameter|tool|function|maximum|context|expected|max_output_tokens)\b/i.test(message.trim())){
      // This wrapper is used ONLY with the fixed fictional self-test inputs.
      // Never attach upstream prose to requests using real leader/scout data.
      const sent=JSON.parse(String(args[1]?.body));
      // Even a fixture's validation error can echo encrypted reasoning. Keep
      // diagnostics structural once reasoning has entered the conversation.
      const hasReasoning=Array.isArray(sent.input)&&sent.input.some((item:any)=>item.type==='reasoning');
      providerMessage=hasReasoning?undefined:message.replaceAll(config.apiKey!,'[redacted]').replaceAll(config.serviceKey!,'[redacted]').replace(/sk-[A-Za-z0-9_.*-]+/g,'[redacted]').replace(/Bearer\s+[^\s"']+/gi,'Bearer [redacted]').slice(0,1200);
     }
    }catch{/* Structural metadata is still available for non-JSON errors. */}
   }
   return response;
  };
  if(input.scenario==='provider'){
   try{
    // Match a minimal Responses request using the configured staging key/model.
    // This fixed public prompt cannot access tools, scout data or changes.
    const response=await diagnosticFetch('https://api.openai.com/v1/responses',{method:'POST',headers:{Authorization:`Bearer ${config.apiKey}`,'Content-Type':'application/json'},body:JSON.stringify({model:config.model,temperature:1,store:false,max_output_tokens:3000,input:[{role:'user',content:'Reply with the word READY.'}]}),signal:AbortSignal.timeout(30000)});
    if(!response.ok)return reply({configured:true,scenario:'provider',passed:false,provider:await readProviderError(response),...(providerMessage?{providerMessage}:{})},502);
    const body=await response.json();
    if(body.status!=='completed')return reply({configured:true,scenario:'provider',passed:false,error:'The provider response did not complete.'},502);
    return reply({configured:true,scenario:'provider',passed:true});
   }catch{return reply({configured:true,scenario:'provider',passed:false,error:'The provider probe did not complete.'},502);}
  }
  const trace:AssistantTrace[]=[];
  const messages=input.scenario==='count'?[
   {role:'user' as const,content:'Who still needs Bobcat?'},
   {role:'assistant' as const,content:'The preceding request failed. No answer or changes were produced.'},
   {role:'user' as const,content:'how many scouts are there?'},
  ]:[{role:'user' as const,content:'Who still needs Bobcat?'}];
  try{
   const result=await runAssistantChat(store,{action:'chat',context:{den:'',year:'2026-27'},messages},config.apiKey,config.model,diagnosticFetch,event=>trace.push(event));
   const text=JSON.stringify(result);
   const listed=result.card?.kind==='results'?JSON.stringify(result.card.items):'';
   const passed=input.scenario==='count'?/\b3\b|\bthree\b/i.test(result.message):/Ben/.test(text)&&/Carol/.test(text)&&!/Synthetic Ada/.test(listed);
   return reply({configured:true,scenario:input.scenario,passed,result,trace},passed?200:502);
  }catch(error){return reply({configured:true,scenario:input.scenario,passed:false,error:error instanceof AssistantError?error.message:'Self-test failed',...(error instanceof AssistantError&&error.provider?{provider:error.provider}:{}),...(providerMessage?{providerMessage}:{}),trace},502);}
 };
}
