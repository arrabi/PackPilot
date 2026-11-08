import{renderPackEmail,cubmaster,type EmailContext}from'./template.ts';
import {emailAllowed, stagingContent, type EmailPolicy} from './email-policy.ts';
export interface Env extends EmailPolicy{SUPABASE_URL:string;SUPABASE_SECRET_KEY:string;BREVO_API_KEY:string;FROM_EMAIL:string;PACK99_DELIVERY_PAUSED?:string;}
async function concurrent<T>(items:T[],run:(item:T)=>Promise<void>){let index=0;await Promise.all(Array.from({length:Math.min(4,items.length)},async()=>{while(index<items.length){const item=items[index++];await run(item);}}));}
interface Mail{id:string;recipient:string;subject:string;body:string;}
export async function dispatch(env:Env){
 if(env.PACK99_DELIVERY_PAUSED==='true')return 0;
 const rpc=async(name:string,args:Record<string,unknown>={})=>{const response=await fetch(env.SUPABASE_URL+'/rest/v1/rpc/'+name,{method:'POST',headers:{apikey:env.SUPABASE_SECRET_KEY,Authorization:'Bearer '+env.SUPABASE_SECRET_KEY,'Content-Type':'application/json'},body:JSON.stringify(args),signal:AbortSignal.timeout(20000)});if(!response.ok)throw Error('Notification database request failed: '+response.status);return response.status===204?null:response.json();};
 await rpc('prepare_volunteer_followups');await rpc('prepare_admin_followups');await rpc('prepare_parent_reminders');
 const mails:Mail[]=await rpc('claim_parent_emails');
 await concurrent(mails,async mail=>{
  let ok=false,reason='',messageId:string|null=null;
  try{
   if(!emailAllowed(env,[mail.recipient])) {
    await rpc('record_parent_email_result',{email_id:mail.id,success:false,error_text:'Blocked by environment email policy',message_id:null});
    return;
   }
   if(!await rpc('can_send_parent_email',{email_id:mail.id}))return;
   const context:EmailContext=await rpc('parent_email_context',{email_id:mail.id});
   const body=renderPackEmail(context,env.SUPABASE_URL+'/functions/v1/notification-links');
   // Context generation may take time; recheck opt-out/revocation immediately before sending.
   if(!await rpc('can_send_parent_email',{email_id:mail.id}))return;
   if(!emailAllowed(env,[mail.recipient]))throw Error('Email policy changed');
   const response=await fetch('https://api.brevo.com/v3/smtp/email',{method:'POST',headers:{'api-key':env.BREVO_API_KEY,'User-Agent':'PackPilot/1.0','Content-Type':'application/json'},signal:AbortSignal.timeout(20000),body:JSON.stringify({sender:{email:env.FROM_EMAIL,name:'PackPilot'},to:[{email:mail.recipient}],subject:(env.PACK99_ENVIRONMENT==='staging'?'[STAGING] ':'')+mail.subject,textContent:stagingContent(env,body.text),htmlContent:stagingContent(env,body.html),replyTo:{email:cubmaster,name:'PackPilot Cubmaster'},headers:{idempotencyKey:mail.id}})});
   const result=await response.json().catch(()=>({}));
   ok=response.ok&&typeof result.messageId==='string';messageId=ok?result.messageId:null;
   reason=ok?'':response.ok?'Email provider returned no delivery reference':'Email provider HTTP '+response.status+(typeof result.code==='string'?' ('+result.code.replace(/[^a-zA-Z0-9_-]/g,'').slice(0,60)+')':'');
  }catch{reason='Email delivery connection interrupted';}
  await rpc('record_parent_email_result',{email_id:mail.id,success:ok,error_text:reason,message_id:messageId});
 });
 // Reconcile only our own recorded provider IDs; no unrelated mailbox content is fetched.
 const pending:{id:string;message_id:string}[]=await rpc('parent_email_delivery_pending');
 await concurrent(pending,async mail=>{
  try{
   const params=new URLSearchParams({messageId:mail.message_id,days:'7',limit:'20',sort:'desc'});
   const response=await fetch('https://api.brevo.com/v3/smtp/statistics/events?'+params,{headers:{'api-key':env.BREVO_API_KEY,'User-Agent':'PackPilot/1.0'},signal:AbortSignal.timeout(10000)});
   if(!response.ok)return;
   const result=await response.json();const delivered=result.events?.find((e:{messageId:string;event:string;date:string})=>e.messageId===mail.message_id&&e.event==='delivered');
   if(delivered&&Number.isFinite(Date.parse(delivered.date)))await rpc('record_parent_email_delivery',{email_id:mail.id,message_id:mail.message_id,delivered:new Date(delivered.date).toISOString()});
  }catch{/* A later run retries delivery reconciliation; accepted mail is not resent. */}
 });
 return mails.length;
}
export default{async scheduled(_event:unknown,env:Env,ctx:{waitUntil(p:Promise<unknown>):void}){ctx.waitUntil(dispatch(env));},fetch(){return new Response('PackPilot notification dispatcher');}};
