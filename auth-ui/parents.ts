import './back-navigation.css';
import './v2.css';
import{readContext}from'./app-shell.ts';
import {safeParentReturn} from './workspace-model.ts';
import './policy.css';
import './app-shell.css';
import './family-hub.css';
import {requirePolicies} from './policy-gate.ts';
import {createClient} from '@supabase/supabase-js';
import {mountParents,type ParentData,type ParentService} from './parents-ui.ts';
import {parentSessionStorage,parentStorageKey} from './parents-auth.ts';
const root=document.getElementById('app')!;
const previewQuery=new URL(location.href).searchParams,previewScope={den:previewQuery.get('den'),child:previewQuery.get('preview_child')||(previewQuery.has('den')?null:previewQuery.get('child'))};
const preview=previewQuery.get('preview')==='1',context=readContext(window,preview?'leader':'parent');
const url=import.meta.env.VITE_SUPABASE_URL,key=import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
if(!url||!key)root.textContent='The pack administrator needs to configure the parent portal.';
else {
 try {
  const sessions=preview?null:parentSessionStorage(localStorage,sessionStorage);
  const client=createClient(url,key,{auth:preview?{flowType:'pkce',detectSessionInUrl:false}:{storage:sessions!.storage,storageKey:parentStorageKey,persistSession:true,autoRefreshToken:true,detectSessionInUrl:false}});
  let visitedAccount="",currentAccount="";
  async function start(){
  const status=preview?null:await client.rpc('get_parent_portal_status').abortSignal(AbortSignal.timeout(8000));
  const service:ParentService={
   preview,emailReady:!preview&&!status?.error&&status?.data?.email_ready===true,remember:sessions?.remember,
   async identity(){const{data,error}=await client.auth.getUser();if(error||!data.user)return null;await requirePolicies(client);currentAccount=data.user.id;return{email:data.user.email||'Your verified account'};},
   async requestCode(email,remember){if(preview)throw Error('Use administrator sign-in');sessions!.setRemember(remember);const{error}=await client.auth.signInWithOtp({email,options:{shouldCreateUser:true}});if(error)throw error;},
   async verifyCode(email,token){if(preview)throw Error('Use administrator sign-in');const{error}=await client.auth.verifyOtp({email,token,type:'email'});if(error)throw error;},
   async load(){
    if(preview){const{data,error}=await client.rpc('read_parent_preview_scope',{scouting_year:context.year,den_filter:previewScope.den,child:previewScope.child}).abortSignal(AbortSignal.timeout(20000));if(error)throw error;return data as ParentData;}
    const claimed=await client.rpc('claim_parent_links').abortSignal(AbortSignal.timeout(15000));if(claimed.error)throw claimed.error;
    const{data,error}=await client.rpc('read_parent_dashboard',{scouting_year:context.year}).abortSignal(AbortSignal.timeout(20000));if(error)throw error;
    const family=data as ParentData;
    const attribution=await Promise.all(family.scouts.map(async s=>{const r=await client.rpc('read_pack_attribution',{child:s.id});return r.error?[]:r.data||[];}));
    family.attribution=attribution.flat();
    if(currentAccount&&visitedAccount!==currentAccount){const visit=await client.rpc('record_parent_portal_visit');if(!visit.error)visitedAccount=currentAccount;}
    const destination=safeParentReturn(new URL(location.href).searchParams.get('returnTo'),location.origin);
    if(destination)location.replace(destination);
    return family;
   },
   async reportRegistration(request_id,command){if(preview)throw Error('Read-only preview');const{error}=await client.rpc('record_pack_community',{request_id,command});if(error)throw Object.assign(Error(error.message),{code:error.code});},
   async saveFamily(entries){if(preview)throw Object.assign(new Error('Read-only preview'),{code:'42501'});const{error}=await client.rpc('record_family_batch',{entries}).abortSignal(AbortSignal.timeout(20000));if(error)throw Object.assign(new Error('Family update failed'),{code:error.code});},
   async signOut(){if(preview)return;const{error}=await client.auth.signOut({scope:'local'});if(error)throw error;},
   onSignOut(callback){const{data}=client.auth.onAuthStateChange(event=>{if(event==='SIGNED_OUT'){currentAccount='';visitedAccount='';callback();}});return()=>data.subscription.unsubscribe();}
  };
  mountParents(root,service);
  }
  void start().catch(()=>{root.textContent="The parent portal could not connect. Please reload and try again.";});
 }catch{root.textContent='This browser could not open secure sign-in storage. Please allow site storage and reload, or try another browser.';}
}
