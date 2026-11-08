import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Window} from 'happy-dom';
import {familyWorkOverview} from '../auth-ui/family-work-overview.ts';
import {mountPortal,type Entry} from '../auth-ui/portal-ui.ts';
import {emptyData,type PortalData} from '../auth-ui/portal-model.ts';
import type {HomeAssignment,FamilyMessage} from '../auth-ui/family-model.ts';

const adventure='b4fe30dd-67b4-5179-9160-f3d703b7bb60';
const assignment=(scout_id:string,status:string,due_on:string|null=null):HomeAssignment=>({id:'task-'+scout_id,scout_id,adventure_id:adventure,scouting_year:'2026-27',requirement_code:'1',instructions:'Practice together',assigned_on:'2026-10-01',due_on,status,completed_on:status==='submitted'?'2026-10-20':null,parent_note:status==='submitted'?'We finished at home':'',submitted_at:status==='submitted'?'2026-10-21T12:00:00Z':null,review_note:'',reviewed_at:null,revision:2});
const message=(scout_id:string,sender_role:'parent'|'leader'='parent',unread=true):FamilyMessage=>({id:'msg-'+scout_id,scout_id,scouting_year:'2026-27',body:'A question about homework',sender_role,sender_name:'Family',recorded_at:'2026-10-22T12:00:00Z',is_mine:false,unread});
const fixture=():PortalData=>({...emptyData(),scouts:[{id:'none',scout_name:'Cam',den:'0-Lions'},{id:'assigned',scout_name:'Bella',den:'0-Lions'},{id:'submitted',scout_name:'Zoey',den:'0-Lions'},{id:'message',scout_name:'Aaron',den:'0-Lions'},{id:'overdue',scout_name:'Eli',den:'0-Lions'},{id:'completed',scout_name:'Drew',den:'0-Lions'},{id:'returned',scout_name:'Faye',den:'0-Lions'},{id:'leader',scout_name:'Gus',den:'0-Lions'},{id:'withdrawn',scout_name:'Former',den:'(withdraw) 0-Lions'},{id:'other',scout_name:'Tiger',den:'1-Tigers'}],adventures:[{id:adventure,name:'Bobcat',rank:'lion',program_version:'test',readiness_mode:'automatic',source_url:'https://www.scouting.org/',requirements:[{code:'1',description:'Get to know your den'}]}],assignments:[assignment('assigned','todo','2099-12-31'),assignment('submitted','submitted'),assignment('overdue','todo','2026-10-10'),assignment('completed','approved'),assignment('returned','returned','2099-12-31'),assignment('withdrawn','submitted'),assignment('other','submitted')],familyMessages:[message('message'),message('leader','leader')],photos:[{scout_id:'message',image:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jPYoAAAAASUVORK5CYII='}]});
const flush=()=>new Promise(r=>setTimeout(r,20));
async function setup(canRecord=true){const data=fixture(),win=new Window({url:'https://example.test/'});win.document.body.innerHTML='<div id="app"></div>';const root=win.document.getElementById('app')!,writes:Entry[][]=[];const original=globalThis.FormData;globalThis.FormData=win.FormData as any;const app=mountPortal(root as any,{identity:async()=>({email:'leader@example.test'}),capabilities:async()=>({approved:true,can_record:canRecord,default_den:'0-Lions'}),load:async()=>structuredClone(data),save:async entries=>{writes.push(entries);},saveFamily:async entries=>{writes.push(entries);for(const e of entries)if(e.command.action==='review_assignment')data.assignments.find(a=>a.id===e.command.assignment_id)!.status='approved';},signIn:async()=>{},signOut:async()=>{}});await app.ready;return{win,root,data,writes,click(selector:string){const el=root.querySelector(selector)as any;assert.ok(el,'Missing '+selector);el.click();},close(){app.dispose();globalThis.FormData=original;win.happyDOM.abort();}};}

test('family work priority uses actual submissions, unread parent messages and overdue active tasks',()=>{
 const data=fixture(),rows=familyWorkOverview(data,data.scouts,'2026-11-03');
 assert.equal(rows.some(r=>r.scout.id==='withdrawn'),false);
 assert.equal(rows.find(r=>r.scout.id==='submitted')?.readyToReview,1);
 assert.equal(rows.find(r=>r.scout.id==='message')?.unreadMessages,1);
 assert.equal(rows.find(r=>r.scout.id==='leader')?.needsAttention,false);
 assert.equal(rows.find(r=>r.scout.id==='overdue')?.overdue,1);
 assert.equal(rows.find(r=>r.scout.id==='returned')?.group,'assigned');
 assert.equal(rows.find(r=>r.scout.id==='completed')?.group,'assigned');
 const groups=rows.map(r=>r.group);assert.deepEqual(groups,[...groups].sort((a,b)=>['attention','assigned','none'].indexOf(a)-['attention','assigned','none'].indexOf(b)));
});

test('Review family work opens a portrait grid with attention first, assigned homework next, and unassigned scouts last',async()=>{
 const app=await setup();
 try{
  assert.match(app.root.querySelector('[data-action=v2-families]')!.textContent!,/3 scouts need attention/);app.click('[data-action=v2-families]');
  assert.equal(app.root.querySelector('.family-layout'),null);assert.equal(app.root.querySelector('.family-scout-picker'),null);
  assert.deepEqual([...app.root.querySelectorAll('[data-action=family-open]')].map(e=>e.getAttribute('data-scout')),['message','overdue','submitted','assigned','returned','completed','none','leader']);
  assert.equal(app.root.querySelectorAll('.family-work-card>.family-attention-dot').length,3);
  assert.ok(app.root.querySelector('[data-scout=message] .v2-avatar img'));
  assert.equal(app.root.querySelector('[data-scout=none] .v2-avatar')?.textContent,'C');
  assert.match(app.root.querySelector('[data-scout=none]')!.textContent!,/No homework assigned/);
  assert.match(app.root.querySelector('[data-scout=completed]')!.textContent!,/1 past assignment/);
  assert.equal(app.root.querySelector('[data-scout=other]'),null);assert.equal(app.root.querySelector('[data-scout=withdrawn]'),null);assert.equal(app.writes.length,0);
 }finally{app.close();}
});

test('selecting a scout opens only that family, and a successful review clears its attention indicator',async()=>{
 const app=await setup();
 try{
  app.click('[data-action=v2-families]');app.click('[data-action=family-open][data-scout=submitted]');
  assert.equal(app.win.location.hash,'#families/submitted');assert.match(app.root.textContent!,/We finished at home/);assert.equal(app.root.querySelector('form[data-form=family-review]')?.getAttribute('data-scout'),'submitted');assert.equal(app.writes.length,0);
  app.root.querySelector('form[data-form=family-review]')!.dispatchEvent(new app.win.Event('submit',{bubbles:true,cancelable:true}));app.click('[data-confirm-review]');await flush();await flush();
  assert.equal(app.writes[0][0].command.action,'review_assignment');assert.equal(app.writes[0][0].command.assignment_id,'task-submitted');assert.equal(app.writes[0][0].command.expected_revision,2);assert.equal(app.win.location.hash,'#home');
  app.click('[data-action=v2-families]');assert.equal(app.root.querySelector('[data-scout=submitted]>.family-attention-dot'),null);assert.equal(app.root.querySelector('[data-scout=submitted]')?.closest('[data-family-group]')?.getAttribute('data-family-group'),'assigned');
 }finally{app.close();}
});

test('a family with no homework can start a scout-scoped assignment without changing records',async()=>{
 const app=await setup();
 try{
  app.click('[data-action=v2-families]');app.click('[data-action=family-open][data-scout=none]');app.click('[data-action=v2-scout-homework]');
  assert.match(app.root.querySelector('#progress-question')!.textContent!,/Which adventure/);app.click('[data-action=wizard-adventure]');app.click('[data-action=wizard-requirement][data-value="1"]');
  assert.equal(app.root.querySelector('[name=adventure_action]')?.getAttribute('value'),'assign_requirement');assert.deepEqual([...app.root.querySelectorAll('input[name=scout_ids]')].map(e=>e.getAttribute('value')),['none']);assert.equal(app.writes.length,0);
 }finally{app.close();}
});

test('read-only leaders can browse family statuses and search without recording access',async()=>{
 const app=await setup(false);
 try{
  app.click('[data-action=v2-families]');const search=app.root.querySelector('#family-work-search')as any;search.value='Zoey';search.dispatchEvent(new app.win.Event('input',{bubbles:true}));assert.equal(app.root.querySelectorAll('[data-action=family-open]').length,1);app.click('[data-action=family-open]');
  assert.equal((app.root.querySelector('form[data-form=family-review] fieldset')as any).disabled,true);assert.equal((app.root.querySelector('[data-action=v2-scout-homework]')as any).disabled,true);assert.equal(app.writes.length,0);
 }finally{app.close();}
});
