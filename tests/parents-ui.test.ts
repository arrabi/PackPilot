import {test} from 'node:test';import assert from 'node:assert/strict';import {Window}from'happy-dom';
import {mountParents,type ParentData,type ParentService}from'../auth-ui/parents-ui.ts';import{canonicalParentEmail,parentSessionStorage,parentStorageKey}from'../auth-ui/parents-auth.ts';
const fixture=():ParentData=>({scouts:[{id:'one',scout_name:'First Child',den:'0-Lions',bsa_member_id:'001234567'},{id:'two',scout_name:'Second Child',den:'1-Tigers'}],adventures:[{id:'lion',name:'Lion Discovery',rank:'lion',program_version:'test',source_url:'https://www.scouting.org/test/',readiness_mode:'automatic',requirements:[{code:'1',description:'Try a skill.'}],catalog_context:{adventure_type:'Required (Core)'}},{id:'tiger',name:'Tiger Discovery',rank:'tiger',program_version:'test',source_url:'https://www.scouting.org/test/',readiness_mode:'automatic',requirements:[{code:'1',description:'Explore together.'}],catalog_context:{adventure_type:'Required (Core)'}}],advancement:[{scout_id:'one',adventure_id:'lion',earned_on:'2026-10-14',badge_delivered_on:null,badge_form:null}],progress:[],registrations:[]});
const flush=()=>new Promise<void>(r=>setImmediate(r));
async function setup(overrides:Partial<ParentService>={}){
 const window=new Window({url:'https://pack99.example.invalid/prev/parents/'});window.document.body.innerHTML='<div id="app"></div>';const root=window.document.getElementById('app')!;let onSignOut=()=>{};
 const service:ParentService={identity:async()=>({email:'parent@example.test'}),requestCode:async()=>{},verifyCode:async()=>{},load:async()=>fixture(),signOut:async()=>{onSignOut();},onSignOut:cb=>{onSignOut=cb;return()=>{};},emailReady:true,...overrides};
 const app=mountParents(root as unknown as HTMLElement,service);await app.ready;
 const click=(s:string)=>{const e=root.querySelector(s);assert.ok(e,s);(e as unknown as{click:()=>void}).click();};
 const value=(s:string,v:string)=>{(root.querySelector(s)as unknown as{value:string}).value=v;};
 const submit=async(s:string)=>{root.querySelector(s)!.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await flush();await flush();};
 return{window,root,click,value,submit,signedOut:()=>onSignOut(),close(){app.dispose();window.happyDOM.abort();}};
}
test('parent login requests a code only on explicit submit, remembers choice, and loads family only after verification',async()=>{
 let loggedIn=false,loads=0;const sent:unknown[]=[];
 const app=await setup({identity:async()=>loggedIn?{email:'momname@gmail.com'}:null,requestCode:async(...args)=>{sent.push(args);},verifyCode:async(email,code)=>{assert.equal(email,'momname@gmail.com');assert.equal(code,'12345678');loggedIn=true;},load:async()=>{loads++;return fixture();}});
 try{assert.equal(loads,0);assert.equal(sent.length,0);app.value('[name=email]','Mom.Name+pack@googlemail.com');await app.submit('[data-form=email]');assert.deepEqual(sent,[['momname@gmail.com',true]]);assert.ok(app.root.querySelector('[name=code]'));app.value('[name=code]','12345678');await app.submit('[data-form=code]');assert.equal(loads,1);assert.match(app.root.textContent!,/First Child/);assert.equal(app.root.querySelector('[data-form=email]'),null);}finally{app.close();}
});
test('parents switch between their children and see dates while submitting no leader writes',async()=>{
 const app=await setup();try{assert.equal(app.root.querySelectorAll('[data-child]').length,2);assert.match(app.root.querySelector('.parent-progress')!.textContent!,/Lion Discovery/);assert.ok(!app.root.querySelector('.parent-progress')!.textContent!.includes('Tiger Discovery'));app.click('[data-child="two"]');assert.match(app.root.querySelector('.parent-progress')!.textContent!,/Tiger Discovery/);app.click('[data-child="one"]');assert.match(app.root.textContent!,/Completed with adventure earned/);assert.match(app.root.textContent!,/Oct 14, 2026/);assert.equal(app.root.querySelector('[data-form=email]'),null);app.click('[data-action=logout]');await flush();assert.ok(!app.root.textContent!.includes('First Child'));}finally{app.close();}
});
test('unlinked parents get no roster picker, and invalid codes do not load family records',async()=>{
 const noChildren=await setup({load:async()=>({...fixture(),scouts:[],adventures:[],advancement:[]})});try{assert.match(noChildren.root.textContent!,/No children linked/);assert.equal(noChildren.root.querySelector('[data-child]'),null);}finally{noChildren.close();}
 let loaded=false;const invalid=await setup({identity:async()=>null,verifyCode:async()=>{throw Error('provider details');},load:async()=>{loaded=true;return fixture();}});try{invalid.value('[name=email]','parent@example.test');await invalid.submit('[data-form=email]');invalid.value('[name=code]','00000000');await invalid.submit('[data-form=code]');assert.match(invalid.root.textContent!,/invalid or expired/);assert.equal(loaded,false);assert.ok(!invalid.root.textContent!.includes('provider details'));}finally{invalid.close();}
});
test('sign-out invalidates late family responses and renders untrusted names as text',async()=>{
 const data=fixture();data.scouts[0].scout_name='<img src=x onerror=alert(1)>';const escaped=await setup({load:async()=>data});try{assert.equal(escaped.root.querySelector('img[src=x]'),null);assert.match(escaped.root.textContent!,/<img src=x/);}finally{escaped.close();}
 let resolve!:(v:ParentData)=>void;
 const window=new Window({url:'https://pack99.example.invalid/prev/parents/'});window.document.body.innerHTML='<div id="app"></div>';let out=()=>{};const root=window.document.getElementById('app')!;
 const portal=mountParents(root as unknown as HTMLElement,{identity:async()=>({email:'p@example.test'}),requestCode:async()=>{},verifyCode:async()=>{},load:()=>new Promise(r=>{resolve=r;}),signOut:async()=>{},onSignOut:cb=>{out=cb;return()=>{};}});
 await flush();out();resolve(fixture());await portal.ready;assert.ok(!root.textContent!.includes('First Child'));assert.ok(root.querySelector('[data-form=email]'));portal.dispose();window.happyDOM.abort();
});
test('remembered and session-only parent tokens are isolated from leader storage and canonicalization is Gmail-only',()=>{
 const store=()=>{const m=new Map<string,string>();return{getItem:(k:string)=>m.get(k)||null,setItem:(k:string,v:string)=>{m.set(k,v);},removeItem:(k:string)=>{m.delete(k);}};};
 const local=store(),session=store();local.setItem('leader-token','leader');const a=parentSessionStorage(local,session);a.storage.setItem(parentStorageKey,'parent');assert.equal(parentSessionStorage(local,session).storage.getItem(parentStorageKey),'parent');a.setRemember(false);assert.equal(local.getItem(parentStorageKey),null);assert.equal(session.getItem(parentStorageKey),'parent');assert.equal(parentSessionStorage(local,store()).storage.getItem(parentStorageKey),null);assert.equal(local.getItem('leader-token'),'leader');a.storage.removeItem(parentStorageKey);assert.equal(session.getItem(parentStorageKey),null);
 assert.equal(canonicalParentEmail(' A.H+tag@googlemail.com '),'ah@gmail.com');assert.equal(canonicalParentEmail('A.H+tag@example.com'),'a.h+tag@example.com');assert.equal(canonicalParentEmail('A.H@gmai.com'),'a.h@gmai.com');
});

test('email setup gate prevents requesting codes before the sender is ready',async()=>{
 let requests=0;const app=await setup({identity:async()=>null,emailReady:false,requestCode:async()=>{requests++;}});
 try{assert.equal((app.root.querySelector('[data-form=email] button')as unknown as{disabled:boolean}).disabled,true);app.value('[name=email]','parent@example.test');await app.submit('[data-form=email]');assert.equal(requests,0);assert.match(app.root.textContent!,/Email sign-in is being set up/);}finally{app.close();}
});

test('administrator preview uses the same family screens with a clear banner and no email login controls',async()=>{
 let codes=0;const app=await setup({preview:true,emailReady:false,requestCode:async()=>{codes++;}});
 try{assert.match(app.root.querySelector('.parent-preview-banner')!.textContent!,/Admin preview/);assert.match(app.root.textContent!,/Family links unchanged/);assert.equal(app.root.querySelector('[data-action=logout]'),null);assert.ok(app.root.querySelector('a[href="/prev/admin/?tab=access"]'));app.click('[data-child="two"]');assert.match(app.root.querySelector('#child-title')!.textContent!,/Second Child/);assert.equal(codes,0);}finally{app.close();}
 const login=await setup({preview:true,identity:async()=>null,emailReady:false});try{assert.equal(login.root.querySelector('[name=email]'),null);assert.ok(login.root.querySelector('a[href^="/oauth/consent?portal=1&parent_preview=1"]'));}finally{login.close();}
});

test('parents see clear home tasks, submit dates for review and send private family replies',async()=>{
 const data=fixture();data.adventures[1].requirements[0].source_url='https://www.scouting.org/test/requirement-1/';data.assignments=[{id:'a',scout_id:'two',adventure_id:'tiger',scouting_year:'2026-27',requirement_code:'1',instructions:'Explore together',assigned_on:'2026-10-01',due_on:'2026-11-14',status:'todo',completed_on:null,parent_note:'',submitted_at:null,review_note:'',reviewed_at:null,revision:1}];data.familyMessages=[{id:'m',scout_id:'two',scouting_year:'2026-27',body:'Please practice at home',sender_role:'leader',sender_name:'Leader',recorded_at:'2026-10-15T12:00:00Z',is_mine:false,unread:true}];
 const writes:{request_id:string;command:Record<string,unknown>}[][]=[];
 const app=await setup({load:async()=>structuredClone(data),saveFamily:async entries=>{writes.push(structuredClone(entries));if(entries[0].command.action==='submit_assignment')data.assignments![0].status='submitted';}});
 try{
  app.click('[data-child=two]');assert.match(app.root.textContent!,/To do at home/);assert.equal(app.root.querySelector('.family-activity-link')?.getAttribute('href'),'https://www.scouting.org/test/requirement-1/');assert.equal(app.root.querySelector('.family-activity-link')?.getAttribute('target'),'_blank');assert.match(app.root.textContent!,/Explore together/);assert.match(app.root.textContent!,/Please practice at home/);
  app.value('[name=completed_on]','2026-10-14');app.value('[name=parent_note]','Completed together');await app.submit('[data-form=parent-assignment]');assert.equal(writes[0][0].command.action,'submit_assignment');assert.equal(writes[0][0].command.completed_on,'2026-10-14');assert.match(app.root.textContent!,/Done — awaiting leader review/);
  app.value('[data-form=parent-message] [name=body]','Thank you');await app.submit('[data-form=parent-message]');assert.equal(writes[1][0].command.as_role,'parent');assert.equal(writes[1][0].command.scout_id,'two');
 }finally{app.close();}
});
test('a parent retries an uncertain message with the same request ID and preview cannot write',async()=>{
 const calls:{request_id:string;command:Record<string,unknown>}[][]=[];let fail=true;const app=await setup({saveFamily:async entries=>{calls.push(structuredClone(entries));if(fail)throw Error('network');}});
 try{app.value('[data-form=parent-message] [name=body]','Hello');await app.submit('[data-form=parent-message]');assert.ok(app.root.querySelector('[data-action=family-retry]'));fail=false;app.click('[data-action=family-retry]');await flush();await flush();assert.deepEqual(calls[0],calls[1]);}finally{app.close();}
 let wrote=false;const preview=await setup({preview:true,saveFamily:async()=>{wrote=true;}});try{preview.value('[data-form=parent-message] [name=body]','Not sent');await preview.submit('[data-form=parent-message]');assert.equal(wrote,false);}finally{preview.close();}
});

test('parents see official remote artwork and accessible earned adventure labels',async()=>{
 const data=fixture(),real='11111111-2222-4333-8444-555555555555';data.adventures[0].id=real;data.adventures[0].name='Bobcat';data.adventures[0].rank='lion';data.advancement[0].adventure_id=real;
 const app=await setup({load:async()=>data});
 try{
  const summary=app.root.querySelector('.parent-adventure summary')!;
  assert.match(summary.querySelector('img')?.getAttribute('src') || '',/^https:\/\/www\.scouting\.org\/wp-content\/uploads\//);
  assert.ok(summary.textContent!.includes(data.adventures[0].name));
  assert.match(summary.textContent!,/Earned/);
 }finally{app.close();}
});
