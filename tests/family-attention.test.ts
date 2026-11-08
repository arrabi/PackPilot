import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Window} from 'happy-dom';
import {familyDeadlineLabel,isNewFamilyItem} from '../auth-ui/family-attention.ts';
import {familyDashboard} from '../auth-ui/family-dashboard.ts';
import {mountParents,type ParentData} from '../auth-ui/parents-ui.ts';
import {mountWorkspace} from '../auth-ui/workspace-ui.ts';
import type {HomeAssignment} from '../auth-ui/family-model.ts';

const now=new Date('2026-11-04T08:00:00Z'); // Midnight in the pack's Pacific timezone.
const base=():ParentData=>({scouts:[{id:'one',scout_name:'Alex',den:'0-Lions'},{id:'two',scout_name:'Maya',den:'0-Lions'}],adventures:[],advancement:[],progress:[],registrations:[]});
const assignment=(id:string,due_on:string|null,created_at:string|null,status='todo'):HomeAssignment=>({id,scout_id:'one',adventure_id:'a',scouting_year:'2026-27',requirement_code:id,instructions:'Try together',assigned_on:'2026-10-01',created_at,due_on,status,completed_on:null,parent_note:'',submitted_at:null,review_note:'',reviewed_at:null,revision:1});
const flush=()=>new Promise(r=>setTimeout(r,20));

test('New uses an exact 48-hour creation window, including offsets and excluding invalid/future/date-only values',()=>{
 assert.equal(isNewFamilyItem('2026-11-02T08:00:00.001Z',now),true);
 assert.equal(isNewFamilyItem('2026-11-02T08:00:00Z',now),false);
 assert.equal(isNewFamilyItem('2026-11-04T00:00:00-08:00',now),true);
 for(const value of [null,undefined,'','2026-11-04','2026-02-30T08:00:00Z','2026-11-04T08:00:00.001Z'])assert.equal(isNewFamilyItem(value,now),false);
});

test('date deadlines use Pacific calendar days; timed cutoffs use the actual instant',()=>{
 assert.equal(familyDeadlineLabel('2026-11-03',now),'Overdue');
 for(const date of ['2026-11-04','2026-11-07'])assert.equal(familyDeadlineLabel(date,now),'Due soon');
 assert.equal(familyDeadlineLabel('2026-11-08',now),null);
 assert.equal(familyDeadlineLabel('2026-11-03',new Date('2026-11-04T07:59:59Z')),'Due soon');
 assert.equal(familyDeadlineLabel('2026-11-07T08:00:00Z',now),'Due soon');
 assert.equal(familyDeadlineLabel('2026-11-07T08:00:00.001Z',now),null);
 assert.equal(familyDeadlineLabel('2026-11-04T07:59:59Z',now),'Overdue');
 for(const value of [null,'','invalid','2026-02-30'])assert.equal(familyDeadlineLabel(value,now),null);
});

test('pending homework can be both New and urgent; completed work and unknown timestamps are not mislabelled',async()=>{
 const data=base();data.assignments=[assignment('new','2026-11-07','2026-11-03T12:00:00Z'),assignment('late','2026-11-03','2026-10-01T12:00:00Z'),assignment('unknown',null,null),assignment('done','2026-11-03','2026-11-03T12:00:00Z','submitted')];
 const win=new Window();win.document.body.innerHTML=familyDashboard(data,'2026-27',false,false,now);
 try{
  const card=(id:string)=>win.document.querySelector(`a[href*="assignment-${id}"]`)!.closest('article')!;
  assert.match(card('new').textContent!,/New/);assert.match(card('new').textContent!,/Due soon/);
  assert.match(card('late').textContent!,/Overdue/);assert.equal(card('late').querySelector('.hub-status-new'),null);
  assert.equal(card('unknown').querySelector('.hub-status-new,.hub-status-due,.hub-status-overdue'),null);
  assert.equal(win.document.querySelector('a[href*="assignment-done"]'),null);
 }finally{await win.happyDOM.close();}
});

test('volunteer reminders and pending RSVP cutoffs show urgency without flagging answered or cancelled events',async()=>{
 const data=base();data.participation={leader:false,can_record:false,is_admin:false,user_id:'p',scouts:[],events:[{id:'rsvp',title:'RSVP soon',event_date:'2026-11-10',den:null,details:'',rsvp_mode:'unlimited',capacity:null,used:0,cancelled:false,revision:1,rsvp_deadline:'2026-11-05T08:00:00Z',created_at:'2026-11-03T20:00:00Z'},{id:'missed',title:'Missed RSVP',event_date:'2026-11-11',den:null,details:'',rsvp_mode:'unlimited',capacity:null,used:0,cancelled:false,revision:1,rsvp_deadline:'2026-11-03T08:00:00Z'},{id:'answered',title:'Already answered',event_date:'2026-11-12',den:null,details:'',rsvp_mode:'unlimited',capacity:null,used:0,cancelled:false,revision:1,rsvp_deadline:'2026-11-03T08:00:00Z'}],responses:[{event_id:'answered',scout_id:'one',response:'not_going'}],bookings:[],jobs:[{id:'role',title:'Bring snacks',details:'Fruit please',event_id:null,capacity:3,used:0,mine:false,closed:false,signup_date:'2026-11-07',created_at:'2026-11-03T20:00:00Z'},{id:'closed',title:'Closed role',details:'',event_id:null,capacity:3,used:0,mine:false,closed:true,signup_date:'2026-11-07'}],signups:[],volunteers:[],meetings:[],photos:[],adventures:[]};
 const win=new Window();win.document.body.innerHTML=familyDashboard(data,'2026-27',false,false,now);
 try{
  const center=win.document.querySelector('.family-action-center')!;
  const role=center.querySelector('a[href*="job=role"]')!.closest('article')!;
  assert.match(role.textContent!,/New/);assert.match(role.textContent!,/Due soon/);
  assert.match(center.querySelector('a[href*="event=missed"]')!.closest('article')!.textContent!,/Overdue/);
  assert.equal(center.querySelector('a[href*="event=answered"],a[href*="job=closed"]'),null);
 }finally{await win.happyDOM.close();}
});

test('urgent RSVP reminders include events beyond the four-event preview',async()=>{
 const data=base();data.participation={leader:false,can_record:false,is_admin:false,user_id:'p',scouts:[],events:Array.from({length:5},(_,i)=>({id:'event-'+i,title:'Event '+i,event_date:'2026-11-'+(10+i),den:null,details:'',rsvp_mode:'unlimited',capacity:null,used:0,cancelled:false,revision:1,rsvp_deadline:i===4?'2026-11-05T08:00:00Z':null})),bookings:[],jobs:[],signups:[],volunteers:[],meetings:[],photos:[],adventures:[]};
 const win=new Window();win.document.body.innerHTML=familyDashboard(data,'2026-27',false,false,now);
 try{assert.equal(win.document.querySelectorAll('.hub-events .hub-event').length,4);assert.match(win.document.querySelector('.family-action-center a[href*="event=event-4"]')!.closest('article')!.textContent!,/Due soon/);}finally{await win.happyDOM.close();}
});

test('the menu aggregates authorized unread messages, opens the right child and clears only after a confirmed read',async()=>{
 const data=base();data.familyMessages=[{id:'m',scout_id:'two',scouting_year:'2026-27',body:'New note for Maya',sender_role:'leader',sender_name:'Leader',recorded_at:now.toISOString(),is_mine:false,unread:true},{id:'outside',scout_id:'outside',scouting_year:'2026-27',body:'Not this family',sender_role:'leader',sender_name:'Leader',recorded_at:now.toISOString(),is_mine:false,unread:true}];
 const win=new Window({url:'https://example.test/parents'});win.document.body.innerHTML='<div id="app"></div>';const root=win.document.getElementById('app')!;let release!:()=>void;
 const app=mountParents(root as any,{identity:async()=>({email:'parent@example.test'}),requestCode:async()=>{},verifyCode:async()=>{},load:async()=>structuredClone(data),saveFamily:async()=>{await new Promise<void>(r=>release=r);data.familyMessages![0].unread=false;},signOut:async()=>{}});
 try{
  await app.ready;const link=root.querySelector('.family-bottom a[aria-label]') as any;
  assert.equal(link.getAttribute('aria-label'),'Messages, 1 unread message');assert.ok(link.querySelector('.family-nav-dot'));link.click();
  assert.equal(new URL(win.location.href).searchParams.get('child'),'two');assert.match(root.querySelector('#parent-family-messages')!.textContent!,/New note for Maya/);
  (root.querySelector('[data-action=family-read]') as any).click();await flush();assert.ok(root.querySelector('.family-nav-dot'));release();await flush();await flush();assert.equal(root.querySelector('.family-nav-dot'),null);
 }finally{app.dispose();await win.happyDOM.close();}
});

test('parent Events keeps the same unread dot and child destination',async()=>{
 const win=new Window({url:'https://example.test/events?parent=1'});win.document.body.innerHTML='<div id="app"></div>';const root=win.document.getElementById('app')!;
 const app=mountWorkspace(root as any,{rpc:async()=>({leader:false,can_record:false,is_admin:false,user_id:'p',scouts:[],events:[],jobs:[],bookings:[],volunteers:[],meetings:[],photos:[],adventures:[],unread_family_messages:2,unread_family_message_child:'two'})as any},'events',true);
 try{await app.ready;const link=root.querySelector('.family-bottom a[aria-label]') as any;assert.equal(link.getAttribute('aria-label'),'Messages, 2 unread messages');assert.ok(link.querySelector('.family-nav-dot'));assert.equal(new URL(link.href).searchParams.get('child'),'two');}finally{app.dispose();await win.happyDOM.close();}
});
