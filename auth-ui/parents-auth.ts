export function canonicalParentEmail(address:string):string {
 const email=address.trim().toLowerCase();
 if(/^[a-z0-9]+(\.[a-z0-9]+)*(\+[^@\s]+)?@(gmail|googlemail)\.com$/.test(email))return email.split('@')[0].split('+')[0].replaceAll('.','')+'@gmail.com';
 return email;
}
export const parentStorageKey='pack99-parent-auth';
const preferenceKey='pack99-parent-remember';
export interface BrowserStore {getItem(key:string):string|null;setItem(key:string,value:string):void;removeItem(key:string):void;}
/** Separate from the leader session. Unchecking Remember removes durable tokens. */
export function parentSessionStorage(local:BrowserStore,session:BrowserStore) {
 let remember=local.getItem(preferenceKey)!=='false';
 const target=()=>remember?local:session;
 return {
  get remember(){return remember;},
  setRemember(value:boolean){
   if(value===remember)return;
   const token=target().getItem(parentStorageKey);
   local.removeItem(parentStorageKey);session.removeItem(parentStorageKey);
   remember=value;local.setItem(preferenceKey,String(value));
   if(token)target().setItem(parentStorageKey,token);
  },
  storage:{getItem:(key:string)=>target().getItem(key),setItem:(key:string,value:string)=>{target().setItem(key,value);(remember?session:local).removeItem(key);},removeItem:(key:string)=>{local.removeItem(key);session.removeItem(key);}}
 };
}
