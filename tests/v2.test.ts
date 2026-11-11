import {takeScenarioNotice} from '../auth-ui/scenario-navigation.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Window,type HTMLButtonElement,type HTMLTextAreaElement} from 'happy-dom';
import {mountPortal, type Entry, type PortalService} from '../auth-ui/portal-ui.ts';
import {mountParents} from '../auth-ui/parents-ui.ts';
import {mountWorkspace} from '../auth-ui/workspace-ui.ts';
import {emptyData,type PortalData} from '../auth-ui/portal-model.ts';
import {safeLeaderReturn} from '../auth-ui/app-shell.ts';
import {safeParentReturn} from '../auth-ui/workspace-model.ts';
import {v2Path} from '../auth-ui/v2-shell.ts';
const badge='b4fe30dd-67b4-5179-9160-f3d703b7bb60';
const fixture=():PortalData=>({...emptyData(),scouts:[{id:'one',scout_name:'Alex',den:'0-Lions',parent_1_phone:'4255552435'},{id:'two',scout_name:'Maya',den:'0-Lions'},{id:'other',scout_name:'Tiger',den:'1-Tigers'},{id:'withdrawn',scout_name:'Former',den:'(withdraw) 0-Lions'}],adventures:[{id:badge,name:'Bobcat',rank:'lion',program_version:'test',readiness_mode:'automatic',source_url:'https://www.scouting.org/',catalog_context:{adventure_type:'Required (Core)'},requirements:[{code:'1',description:'Get to know your den'},{code:'2',description:'Do your best'}]}],advancement:[{scout_id:'one',adventure_id:badge,revision:4,earned_on:'2026-10-20',badge_delivered_on:null,badge_form:null}],progress:[{scout_id:'two',adventure_id:badge,requirement_code:'1',completed_on:'2026-10-21',completion_source:'individual'}]});
const flush=()=>new Promise(r=>setTimeout(r,15));
async function portal(path='/#home',canRecord=true,overrides:Partial<PortalService>={}){const win=new Window({url:'https://example.test'+path});win.document.body.innerHTML='<div id="app"></div>';const root=win.document.getElementById('app')!;const saved:Entry[][]=[];const before=globalThis.FormData;globalThis.FormData=win.FormData as any;const app=mountPortal(root as any,{identity:async()=>({email:'leader@example.test'}),capabilities:async()=>({approved:true,can_record:canRecord,default_den:'0-Lions'}),load:async()=>fixture(),save:async e=>{saved.push(e);},signIn:async()=>{},signOut:async()=>{},...overrides});await app.ready;return{win,root,saved,go(hash:string){win.location.hash=hash;win.dispatchEvent(new win.Event('hashchange'));},click(selector:string){const e=root.querySelector(selector) as any;assert.ok(e,selector);e.click();},close(){app.dispose();globalThis.FormData=before;win.happyDOM.abort();}};}
test('the default design has four destinations and no version switch controls',async()=>{const app=await portal();try{assert.deepEqual([...app.root.querySelectorAll('.v2-bottom a')].map(a=>a.textContent?.replace(/[⌂♙▦•]/g,'').trim()),['Today','Scouts','Events','More']);assert.match(app.root.textContent!,/What would you like to do/);assert.equal(app.root.querySelector('[data-original],[data-new-design]'),null);assert.equal(app.root.querySelector('.sidebar'),null);app.click('[data-action=v2-progress]');assert.ok(app.root.querySelector('#record-progress-steps'));}finally{app.close();}});
test('badge-first progress counts matching active scouts and retains earned badges for browsing',async()=>{const app=await portal('/#badges');try{assert.match(app.root.querySelector('.v2-badge-card')!.textContent!,/1\/2 scouts earned it/);assert.equal(app.root.querySelectorAll('.v2-badge-card').length,1);app.go('badge/'+badge);assert.equal(app.root.querySelectorAll('.v2-badge-scout').length,2);assert.match(app.root.textContent!,/Earned · badge waiting/);assert.match(app.root.textContent!,/In progress · 1\/2 requirements/);assert.match(app.root.textContent!,/Requirement 1 · 2\/2 completed/);assert.equal((app.root.querySelector('[data-action=v2-badge-requirement][data-code="1"]')as any).disabled,true);app.click('[data-action=v2-badge-requirement][data-code="2"]');assert.equal(app.root.querySelector('[name=requirement_code]')?.getAttribute('value'),'2');assert.ok(app.root.querySelector('form[data-form=adventure]'));}finally{app.close();}});
test('v2 reviews changes before creating writes; Back retains the form and confirmation saves only eligible scouts',async()=>{const app=await portal('/#badge/'+badge);try{app.click('[data-action=v2-badge-requirement][data-code="2"]');app.click('[data-action=wizard-all]');app.root.querySelector('form[data-form=adventure]')!.dispatchEvent(new app.win.Event('submit',{bubbles:true,cancelable:true}));assert.equal(app.saved.length,0);assert.ok(app.root.querySelector('.v2-review'));app.click('[data-back-review]');assert.equal(app.root.querySelectorAll('input[name=scout_ids]:checked').length,1);app.root.querySelector('form[data-form=adventure]')!.dispatchEvent(new app.win.Event('submit',{bubbles:true,cancelable:true}));app.click('[data-confirm-review]');await flush();await flush();assert.equal(app.saved.length,1);assert.equal(app.saved[0].length,1);assert.equal(app.saved[0][0].command.scout_id,'two');assert.equal(app.saved[0][0].command.requirement_code,'2');assert.equal(app.win.location.hash,'#home');assert.ok(app.root.querySelector('.v2-actions'));assert.match(app.root.querySelector('[role=status]')!.textContent!,/Recorded for/);}finally{app.close();}});
test('v2 read-only users can inspect badges without recording controls',async()=>{const app=await portal('/#badge/'+badge,false);try{assert.equal(app.root.querySelector('[data-action=v2-badge-record]'),null);assert.equal(app.root.querySelector('[data-action=v2-badge-requirement]'),null);assert.equal(app.root.querySelectorAll('.v2-badge-scout').length,2);}finally{app.close();}});
test('existing interface keeps its navigation and versioned auth returns stay local',async()=>{const app=await portal('/prev/#home');try{assert.equal(app.root.querySelector('.v2-bottom'),null);assert.ok(app.root.querySelector('.app-navigation'));assert.equal(app.root.querySelector('[data-new-design],[data-original]'),null);assert.ok([...app.root.querySelectorAll('.app-navigation a')].every(a=>a.getAttribute('href')?.startsWith('/prev/')));assert.equal(safeLeaderReturn('/v2?den=0-Lions#badges'),'/v2?den=0-Lions#badges');assert.equal(safeLeaderReturn('/v2/admin?tab=access'),'/v2/admin?tab=access');assert.equal(safeLeaderReturn('/v2/evil'),'/');assert.equal(safeParentReturn('/v2/events?event=x'),'/v2/events?event=x&parent=1');assert.equal(v2Path('/events?event=x'),'/events?event=x');assert.equal(v2Path('/v2/events?event=x'),'/events?event=x');}finally{app.close();}});
test('Family Hub keeps its current five-tab navigation and family links',async()=>{const win=new Window({url:'https://example.test/parents'});win.document.body.innerHTML='<div id="app"></div>';const root=win.document.getElementById('app')!;const data=fixture();const app=mountParents(root as any,{identity:async()=>({email:'parent@example.test'}),requestCode:async()=>{},verifyCode:async()=>{},load:async()=>({...data,scouts:data.scouts.slice(0,1)}),signOut:async()=>{}});try{await app.ready;assert.equal(root.querySelectorAll('.app-navigation a').length,5);assert.equal(root.querySelector('.v2-bottom'),null);assert.match(root.textContent!,/FAMILY HUB/);assert.ok([...root.querySelectorAll('.app-navigation a')].every(a=>a.getAttribute('href')?.startsWith('/')&&!a.getAttribute('href')?.startsWith('/prev')));const link=root.querySelector('.app-navigation a[href*="section=progress"]')as any;link.click();assert.ok(root.querySelector('.selected-child-record[open]'));assert.equal(win.location.pathname,'/parents');}finally{app.dispose();win.happyDOM.abort();}});
test('Events defaults to Calendar and retains navigation and management tools',async()=>{const win=new Window({url:'https://example.test/events'});win.document.body.innerHTML='<div id="app"></div>';const root=win.document.getElementById('app')!;const app=mountWorkspace(root as any,{rpc:async<T>()=>({leader:true,can_record:true,is_admin:false,user_id:'leader',scouts:[],events:[],jobs:[],signups:[],bookings:[],volunteers:[],meetings:[],photos:[],adventures:[]} as T)},'events');try{await app.ready;assert.equal(root.querySelector('[data-events-view=calendar]')?.getAttribute('aria-pressed'),'true');assert.equal(root.querySelectorAll('.v2-bottom a').length,4);assert.equal(root.querySelector('.v2-bottom a[aria-current]')?.textContent?.includes('Events'),true);}finally{app.dispose();win.happyDOM.abort();}});


test('contact phones are readable and tappable in both the default and previous designs',async()=>{
 for(const path of ['/#scout/one','/prev/#scout/one']){
  const app=await portal(path);
  try{
   const phone=app.root.querySelector('.contacts a[href="tel:+14255552435"]');
   assert.equal(phone?.textContent,'(425) 555-2435');
   assert.equal(app.root.querySelector('[data-original],[data-new-design]'),null);
   if(path.startsWith('/prev'))assert.equal(app.root.querySelector('.v2-bottom'),null);
   else assert.equal(app.root.querySelectorAll('.v2-bottom a').length,4);
  }finally{app.close();}
 }
});


test('earning an adventure finishes at Home with the confirmation and a fresh action chooser',async()=>{
 const app=await portal();
 try{
  app.click('[data-action=v2-progress]');app.click('[data-action=wizard-action][data-value=earn_adventure]');app.click(`[data-action=wizard-adventure][data-value="${badge}"]`);app.click('[data-action=wizard-all]');
  app.root.querySelector('form[data-form=adventure]')!.dispatchEvent(new app.win.Event('submit',{bubbles:true,cancelable:true}));app.click('[data-confirm-review]');await flush();await flush();
  assert.equal(app.saved[0][0].command.action,'earn_adventure');assert.equal(app.win.location.hash,'#home');assert.ok(app.root.querySelector('.v2-actions'));assert.equal(app.root.querySelector('form[data-form=adventure]'),null);
  app.click('[data-action=v2-progress]');assert.match(app.root.querySelector('#progress-question')!.textContent!,/What progress/);assert.equal(app.root.querySelectorAll('input[name=scout_ids]:checked').length,0);
 }finally{app.close();}
});

test('an interrupted multi-batch scenario stays open until retry confirms every update',async()=>{
 const data=fixture();data.scouts=Array.from({length:26},(_,i)=>({id:'scout-'+i,scout_name:'Scout '+i,den:'0-Lions'}));data.advancement=[];data.progress=[];
 const attempts:Entry[][]=[];
 const app=await portal('/#home',true,{load:async()=>data,save:async entries=>{attempts.push(structuredClone(entries));if(attempts.length===2)throw Error('Network interrupted');}});
 try{
  app.click('[data-action=v2-progress]');app.click('[data-action=wizard-action][data-value=earn_adventure]');app.click(`[data-action=wizard-adventure][data-value="${badge}"]`);app.click('[data-action=wizard-all]');app.root.querySelector('form[data-form=adventure]')!.dispatchEvent(new app.win.Event('submit',{bubbles:true,cancelable:true}));app.click('[data-confirm-review]');await flush();await flush();
  assert.equal(app.win.location.hash,'#adventures');assert.ok(app.root.querySelector('[data-action=retry]'));assert.equal(attempts[0].length,25);assert.equal(attempts[1].length,1);
  app.click('[data-action=retry]');await flush();await flush();assert.equal(app.win.location.hash,'#home');assert.deepEqual(attempts[2],attempts[1]);assert.equal(attempts.length,3);
 }finally{app.close();}
});

test('creating an activity continues into attendance instead of ending the scenario early',async()=>{
 const app=await portal('/#attendance');
 try{
  const form=app.root.querySelector('form[data-form=activity]')!;(form.querySelector('[name=title]')as any).value='Den meeting';form.dispatchEvent(new app.win.Event('submit',{bubbles:true,cancelable:true}));app.click('[data-confirm-review]');await flush();await flush();
  assert.equal(app.saved[0][0].command.action,'create_activity');assert.equal(app.win.location.hash,'#attendance');
 }finally{app.close();}
});

test('submitting parent work returns to the family Home while keeping the review confirmation',async()=>{
 const win=new Window({url:'https://example.test/parents?child=one&section=homework&item=assignment-task'});win.document.body.innerHTML='<div id="app"></div>';const root=win.document.getElementById('app')!,data=fixture(),saved:Entry[][]=[];
 const app=mountParents(root as any,{identity:async()=>({email:'parent@example.test'}),requestCode:async()=>{},verifyCode:async()=>{},load:async()=>({...data,scouts:data.scouts.slice(0,1),assignments:[{id:'task',scout_id:'one',adventure_id:badge,requirement_code:'2',status:'todo',revision:1,assigned_on:'2026-10-20',instructions:'Complete together'}]} as any),saveFamily:async entries=>{saved.push(entries);},signOut:async()=>{}});
 try{
  await app.ready;root.querySelector('form[data-form=parent-assignment]')!.dispatchEvent(new win.Event('submit',{bubbles:true,cancelable:true}));(root.querySelector('[data-confirm-review]')as any).click();await flush();await flush();
  assert.equal(saved[0][0].command.action,'submit_assignment');assert.equal(new URL(win.location.href).searchParams.get('section'),null);assert.equal(new URL(win.location.href).searchParams.get('item'),null);assert.ok(root.querySelector('.family-action-center'));assert.match(root.querySelector('.parent-message')!.textContent!,/Submitted for leader review/);
 }finally{app.dispose();win.happyDOM.abort();}
});


test('an event response waits for confirmation before returning to the parent Home',async()=>{
 const win=new Window({url:'https://example.test/events?parent=1&event=meeting'});win.document.body.innerHTML='<div id="app"></div>';const root=win.document.getElementById('app')!;let release!:(value:any)=>void,writeStarted=false;
 const app=mountWorkspace(root as any,{async rpc<T>(name:string){if(name==='read_pack_workspace')return{leader:false,can_record:false,is_admin:false,user_id:'parent',scouts:[{id:'one',name:'Alex',den:'0-Lions'}],events:[{id:'meeting',title:'Den meeting',event_date:'2027-05-12',den:'0-Lions',details:'',rsvp_mode:'unlimited',capacity:null,used:0,cancelled:false,revision:1}],jobs:[],signups:[],bookings:[],volunteers:[],meetings:[],photos:[],adventures:[]}as T;writeStarted=true;return await new Promise(r=>release=r)as T;}},'events',true);
 try{
  await app.ready;const form=root.querySelector('form[data-kind=rsvp]')!;(form.querySelector('[name=scouts]')as any).checked=true;form.dispatchEvent(new win.Event('submit',{bubbles:true,cancelable:true}));(root.querySelector('[data-confirm-review]')as any).click();await flush();
  assert.equal(writeStarted,true);assert.equal(win.location.pathname,'/events');release(null);await flush();await flush();assert.equal(win.location.pathname,'/parents');assert.equal(takeScenarioNotice(win as any,'parent'),'Your family response was saved.');
 }finally{app.dispose();win.happyDOM.abort();}
});

test('progress notification choice defaults on, applies to the whole save, and resets for a new scenario',async()=>{
 const app=await portal('/#badge/'+badge);try{
  app.click('[data-action=v2-badge-requirement][data-code="2"]');app.click('[data-action=wizard-all]');
  const submit=()=>app.root.querySelector('form[data-form=adventure]')!.dispatchEvent(new app.win.Event('submit',{bubbles:true,cancelable:true}));
  submit();const checkbox=app.root.querySelector('[data-notify-parents]')as any;assert.equal(checkbox.checked,true);checkbox.checked=false;
  app.click('[data-back-review]');submit();assert.equal((app.root.querySelector('[data-notify-parents]')as any).checked,false);
  app.click('[data-confirm-review]');await flush();await flush();
  assert.equal(app.saved[0][0].command.notify_parents,false);assert.match(app.root.querySelector('[role=status]')!.textContent!,/without sending parent notifications/);
  app.go('badge/'+badge);app.click('[data-action=v2-badge-requirement][data-code="2"]');app.click('[data-action=wizard-all]');submit();
  assert.equal((app.root.querySelector('[data-notify-parents]')as any).checked,true);
 }finally{app.close();}
});
test('interrupted silent progress retries the same request and reports the acknowledged email receipt',async()=>{
 let fail=true;const calls:Entry[][]=[];
 const app=await portal('/#badge/'+badge,true,{save:async entries=>{calls.push(entries);if(fail){fail=false;throw Error('connection');}return{notificationsQueued:0};}});try{
  app.click('[data-action=v2-badge-requirement][data-code="2"]');app.click('[data-action=wizard-all]');app.root.querySelector('form[data-form=adventure]')!.dispatchEvent(new app.win.Event('submit',{bubbles:true,cancelable:true}));
  (app.root.querySelector('[data-notify-parents]')as any).checked=false;app.click('[data-confirm-review]');await flush();
  app.click('[data-action=retry]');await flush();await flush();assert.equal(calls.length,2);assert.deepEqual(calls[0],calls[1]);assert.equal(calls[1][0].command.notify_parents,false);assert.equal(app.win.location.hash,'#home');
 }finally{app.close();}
});
test('progress confirmation reports queued emails without claiming delivery',async()=>{
 const app=await portal('/#badge/'+badge,true,{save:async()=>({notificationsQueued:2})});try{
  app.click('[data-action=v2-badge-handout]');app.click('[data-action=wizard-all]');app.root.querySelector('form[data-form=adventure]')!.dispatchEvent(new app.win.Event('submit',{bubbles:true,cancelable:true}));app.click('[data-confirm-review]');await flush();await flush();
  assert.match(app.root.querySelector('[role=status]')!.textContent!,/2 parent notifications queued/);
 }finally{app.close();}
});
test('silent bulk homework applies one choice to every selected scout and requirement',async()=>{
 const data=fixture();data.advancement=[];data.progress=[];
 const calls:Entry[][]=[];const app=await portal('/#home',true,{load:async()=>data,saveFamily:async e=>{calls.push(e);return{notificationsQueued:0};}});try{
  app.click('[data-action=v2-progress]');app.click('[data-action=wizard-action][data-value=assign_requirement]');app.click('[data-action=wizard-adventure]');app.click('[data-action=wizard-requirement][data-value="*"]');app.click('[data-action=wizard-all]');
  app.root.querySelector('form[data-form=adventure]')!.dispatchEvent(new app.win.Event('submit',{bubbles:true,cancelable:true}));(app.root.querySelector('[data-notify-parents]')as any).checked=false;app.click('[data-confirm-review]');await flush();await flush();
  assert.equal(calls.length,1);assert.equal(calls[0].length,4);assert.ok(calls[0].every(e=>e.command.notify_parents===false));assert.equal(app.win.location.hash,'#home');
 }finally{app.close();}
});

test('staging assistant opens from the raised center nav and Home CTA, retaining the current conversation',async()=>{
 const app=await portal('/#home',true,{assistant:async()=>({message:'There are 2 scouts.'})});
 try{
  const nav=app.root.querySelector('.v2-bottom')!;
  assert.deepEqual([...nav.children].map(e=>e.textContent?.replace(/[⌂♙▦•✦]/g,'').trim()),['Today','Scouts','Ask AI','Events','More']);
  assert.equal(app.root.querySelector('.assistant-launch strong')?.textContent,'Ask AI');
  app.click('.v2-ai-action');await flush();
  assert(app.win.document.querySelector('dialog[open]'));
  const text=app.win.document.querySelector('textarea')!;text.value='How many scouts?';text.dispatchEvent(new app.win.Event('input',{bubbles:true}));app.win.document.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.click();await flush();
  app.win.document.querySelector<HTMLButtonElement>('[data-assistant-action=close]')!.click();
  app.click('.assistant-launch');await flush();
  assert.match(app.win.document.querySelector('.assistant-transcript')!.textContent!,/There are 2 scouts/);
  app.win.document.querySelector<HTMLButtonElement>('[data-assistant-action=close]')!.click();app.go('scouts');
  assert(app.root.querySelector('.v2-ai-action'));assert.equal(app.root.querySelector('.assistant-launch'),null);
 }finally{app.close();}
});

test('Events AI navigation loads authorized scout portraits, preserves context and disposes on sign-out',async()=>{
 const win=new Window({url:'https://example.test/events?den=0-Lions&year=2026-27'});win.document.body.innerHTML='<div id="app"></div>';const root=win.document.getElementById('app')!;
 const calls:Record<string,unknown>[]=[];let signOut!:()=>void;
 const portrait='data:image/png;base64,c3ludGhldGlj';
 const app=mountWorkspace(root as any,{assistantEmail:'synthetic@example.test',assistant:async input=>{calls.push(input);return{message:'One scout needs Bobcat.',card:{kind:'results',title:'Scouts needing Bobcat',items:[{label:'Maya Test',detail:'Lions',scout_id:'one'}]}};},rpc:async<T>(name:string)=>(name==='read_scout_photos'?[{scout_id:'one',image:portrait}]:{leader:true,can_record:true,is_admin:false,user_id:'leader',scouts:[],events:[],jobs:[],signups:[],bookings:[],volunteers:[],meetings:[],photos:[{scout_id:'one',kind:'family',image:'family-photo-must-not-be-used'}],adventures:[]}) as T,onSignOut(fn){signOut=fn;return()=>{};}},'events');
 try{
  await app.ready;root.querySelector<HTMLButtonElement>('.v2-ai-action')!.click();await flush();
  const text=win.document.querySelector<HTMLTextAreaElement>('dialog textarea')!;text.value='Who needs Bobcat?';text.dispatchEvent(new win.Event('input',{bubbles:true}));win.document.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.click();await flush();
  assert.deepEqual(calls[0].context,{den:'0-Lions',year:'2026-27'});
  assert.equal(win.document.querySelector('.assistant-result img')?.getAttribute('src'),portrait);
  assert(!win.document.querySelector('dialog')!.innerHTML.includes('family-photo-must-not-be-used'));
  signOut();assert.equal(win.document.querySelector('dialog'),null);
 }finally{app.dispose();win.happyDOM.abort();}
});
