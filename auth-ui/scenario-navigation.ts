import {appLink,type AppContext,type AppRole} from './app-shell.ts';

const noticeKey=(role:AppRole)=>'pack99-scenario-complete-'+role;
/** Local flows keep their mounted service; standalone pages carry a short-lived confirmation home. */
export function returnHomeAfterScenario(win:Window,role:AppRole,context:Partial<AppContext>,message:string,local=false):void {
 const destination=appLink(role==='leader'?'/#home':'/parents',role,context);
 if(local){win.history.replaceState(null,'',destination);return;}
 try{win.sessionStorage.setItem(noticeKey(role),JSON.stringify({message,created:Date.now()}));}catch{}
 win.location.assign(destination);
}
export function takeScenarioNotice(win:Window,role:AppRole):string {
 try{
  const raw=win.sessionStorage.getItem(noticeKey(role));win.sessionStorage.removeItem(noticeKey(role));
  if(!raw)return'';
  const value=JSON.parse(raw);
  return typeof value.message==='string'&&typeof value.created==='number'&&Date.now()-value.created>=0&&Date.now()-value.created<300000?value.message.slice(0,2000):'';
 }catch{return'';}
}
