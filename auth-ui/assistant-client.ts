import type {SupabaseClient} from '@supabase/supabase-js';
import type {AssistantTransport} from '../supabase/functions/_shared/assistant-types.ts';

export function assistantTransport(client:SupabaseClient,url:string,key:string):AssistantTransport{
 return async input=>{
  const {data:{session}}=await client.auth.getSession();
  if(!session)throw new Error('Your session expired. Sign in again.');
  const response=await fetch(`${url}/functions/v1/fieldbook-assistant`,{method:'POST',headers:{Authorization:`Bearer ${session.access_token}`,apikey:key,'Content-Type':'application/json'},body:JSON.stringify(input),signal:AbortSignal.timeout(120000)});
  let data;try{data=await response.json();}catch{throw new Error('The assistant response was not confirmed. Check the save status before retrying.');}
  if(!response.ok)throw Object.assign(new Error(data.error||'The assistant is unavailable.'),{code:data.code});
  return data;
 };
}
