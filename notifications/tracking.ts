import {stagingContent, stagingOrigin, type EmailPolicy} from './email-policy.ts';
interface Env extends EmailPolicy{SUPABASE_URL:string;SUPABASE_SECRET_KEY:string;}
const pixel=Uint8Array.from([71,73,70,56,57,97,1,0,1,0,128,0,0,0,0,0,255,255,255,33,249,4,1,0,0,0,0,44,0,0,0,0,1,0,1,0,0,2,2,68,1,0,59]);
export async function handleNotificationLink(request:Request,env:Env):Promise<Response>{
 if(env.PACK99_ENVIRONMENT && env.PACK99_ENVIRONMENT!=='production') {
  try { if(env.PACK99_ENVIRONMENT!=='staging')throw Error();stagingOrigin(env); }
  catch { return new Response('Environment configuration unavailable',{status:503}); }
 }
 const headers={'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'};
 if(request.method!=='GET')return new Response('Method not allowed',{status:405,headers});
 const mediaUrl=new URL(request.url);
 if(mediaUrl.searchParams.get('media')==='portrait'){
  const token=mediaUrl.searchParams.get('t')||'',index=mediaUrl.searchParams.get('index')||'0';
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)||!/^([0-9]|[12][0-9]|30)$/.test(index))return new Response('Image unavailable',{status:404,headers});
  try{
   const response=await fetch(env.SUPABASE_URL+'/rest/v1/rpc/read_parent_email_portrait',{method:'POST',headers:{apikey:env.SUPABASE_SECRET_KEY,'Content-Type':'application/json'},body:JSON.stringify({token,portrait_index:Number(index)}),signal:AbortSignal.timeout(5000)});
   const image=response.ok?await response.json():null;
   if(typeof image==='string'&&image.length<=180000&&/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(image)){
    const decoded=atob(image.split(',')[1]),bytes=Uint8Array.from(decoded,c=>c.charCodeAt(0));
    if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return new Response(bytes,{headers:{...headers,'Content-Type':'image/jpeg','Content-Security-Policy':"default-src 'none'"}});
   }
  }catch{/* Removed, expired and revoked portraits all have the same response. */}
  return new Response('Image unavailable',{status:404,headers});
 }
 const url=new URL(request.url),token=url.searchParams.get('t')||'',kind=url.searchParams.get('kind')||'',target=url.searchParams.get('target')||'portal';
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)||!['clicked','opened'].includes(kind)||target.length>40)return new Response('Invalid link',{status:400,headers});
 let destination='https://packpilot.example/parents';
 try{
  const response=await fetch(env.SUPABASE_URL+'/rest/v1/rpc/track_parent_email',{method:'POST',headers:{apikey:env.SUPABASE_SECRET_KEY,'Content-Type':'application/json'},body:JSON.stringify({token,engagement_kind:kind,target_key:target,automated:/bot|scanner|crawl|preview|GoogleImageProxy|Microsoft Office/i.test(request.headers.get('user-agent')||'')}),signal:AbortSignal.timeout(5000)});
  if(response.ok){const data=await response.json();const next=new URL(data.url);if(next.protocol==='https:')destination=next.href;}
 }catch{/* Follow the private portal link even if the signal could not be recorded. */}
 if(env.PACK99_ENVIRONMENT==='staging'){
  destination=stagingContent(env,destination);
  if(new URL(destination).origin!==stagingOrigin(env))destination=stagingOrigin(env)+'/parents';
 }
 return kind==='opened'?new Response(pixel,{headers:{...headers,'Content-Type':'image/gif'}}):new Response(null,{status:302,headers:{...headers,Location:destination}});
}
