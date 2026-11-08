import {backLabel} from './back-navigation.ts';
import './back-navigation.css';
import {isV2,prevPath} from './v2-shell.ts';
import './v2.css';
import{createClient}from'@supabase/supabase-js';
import{requirePolicies}from'./policy-gate.ts';
import{parentSessionStorage,parentStorageKey}from'./parents-auth.ts';
import{safeParentReturn,workspaceViewFromPath}from'./workspace-model.ts';
import{mountWorkspace}from'./workspace-ui.ts';
import'./portal.css';import'./policy.css';import'./workspace.css';
import './app-shell.css';
import './family-hub.css';
const root=document.getElementById('app')!,url=new URL(location.href),parent=url.searchParams.get('parent')==='1';
const view=workspaceViewFromPath(url.pathname,url.hash);
if(parent&&['planner','notes','history','admin'].includes(view)){root.textContent='This page is available through the adult leader portal.';}
else{
 const sessions=parent?parentSessionStorage(localStorage,sessionStorage):null;
 const client=createClient(import.meta.env.VITE_SUPABASE_URL,import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,{auth:parent?{storage:sessions!.storage,storageKey:parentStorageKey,persistSession:true,autoRefreshToken:true,detectSessionInUrl:false}:{flowType:'pkce',detectSessionInUrl:false}});
 void(async()=>{
  const{data,error}=await client.auth.getUser();if(error||!data.user){if(parent){const destination=safeParentReturn(url.pathname+url.search+url.hash,location.origin)||'/events?parent=1';location.replace((isV2(window)?'/parents':'/prev/parents/')+'?returnTo='+encodeURIComponent(destination));return;}root.innerHTML='<main class="workspace-main"><h1>Open your leader portal first</h1><p>Sign in to access PackPilot events and leader tools.</p><a href="'+(isV2(window)?'/':'/prev/')+'?return_to='+encodeURIComponent(url.pathname+url.search+url.hash)+'">Leader sign-in</a></main>';return;}
  await requirePolicies(client);
  if(parent){const{error}=await client.rpc('claim_parent_links');if(error)throw Error('Family access is not available.');await client.rpc('record_parent_portal_visit');}
  const app=mountWorkspace(root,{async rpc<T>(name:string,args={}){const{data,error}=await client.rpc(name,args).abortSignal(AbortSignal.timeout(30000));if(error)throw Object.assign(new Error(error.message),{code:error.code});return data as T;},async signOut(){const{error}=await client.auth.signOut({scope:"local"});if(error)throw error;location.replace(isV2(window)?(parent?"/parents":"/"):prevPath(parent?"/parents":"/"));},onSignOut(fn){const{data}=client.auth.onAuthStateChange(event=>{if(event==='SIGNED_OUT')fn();});return()=>data.subscription.unsubscribe();}},view,parent);
  await app.ready;
 })().catch(()=>{root.innerHTML='<main class="workspace-main"><h1>Could not open the workspace</h1><p>Please return to your portal to sign in and try again.</p><a class="back-button" href="'+(isV2(window)?(parent?'/parents':'/'):prevPath(parent?'/parents':'/'))+'">'+backLabel("Return to your portal")+'</a></main>';});
}
