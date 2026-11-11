import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Window} from 'happy-dom';
import {createAssistantPanel} from '../auth-ui/assistant-ui.ts';
import type {AssistantReply} from '../supabase/functions/_shared/assistant-types.ts';
const id='10000000-0000-4000-8000-000000000001';
const review:AssistantReply={message:'Review these updates.',card:{kind:'review',id,expires_at:'2099-01-01',title:'Bobcat completion',notifications:false,commands:[{action:'record_requirement',scout_id:id,adventure_id:id,scouting_year:'2026-27',requirement_code:'2',status:'completed',occurred_on:'2026-11-01',notify_parents:false}],rows:[{label:'Synthetic Scout',detail:'Bobcat · Requirement 2',before:'Not recorded',after:'Completed',date:'2026-11-01',scout_id:id}]}};
const flush=()=>new Promise(resolve=>setTimeout(resolve,5));

test('replies and errors return keyboard focus to the composer after button and Enter submission',async()=>{
 const win=new Window({url:'https://app.example.test'}),doc=win.document as unknown as Document;
 const pending:{resolve:(reply:AssistantReply)=>void;reject:(error:Error)=>void}[]=[];
 const panel=createAssistantPanel(doc,()=>new Promise<AssistantReply>((resolve,reject)=>pending.push({resolve,reject})),()=>({den:'0-Lions',year:'2026-27',email:'synthetic@example.test'}),()=>{});
 await panel.open();
 const type=(value:string)=>{const text=doc.querySelector<HTMLTextAreaElement>('textarea')!;text.value=value;text.dispatchEvent(new win.Event('input',{bubbles:true}) as unknown as Event);return text;};
 type('How many scouts in my den?');
 const send=doc.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!;send.focus();send.click();
 assert(doc.querySelector<HTMLTextAreaElement>('textarea')!.disabled);
 pending[0].resolve({message:'There are 3 active scouts.'});await flush();
 assert.equal(doc.activeElement,doc.querySelector('textarea'));
 const next=type('Who still needs Bobcat?');next.dispatchEvent(new win.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}) as unknown as Event);
 pending[1].reject(new Error('Temporary connection error'));await flush();
 assert.equal(doc.activeElement,doc.querySelector('textarea'));
 panel.dispose();await win.happyDOM.close();
});

test('a reply arriving after the assistant is closed does not steal focus',async()=>{
 const win=new Window({url:'https://app.example.test'}),doc=win.document as unknown as Document;
 const outside=doc.createElement('button');outside.textContent='Open assistant';doc.body.append(outside);outside.focus();
 let answer!:(reply:AssistantReply)=>void;
 const panel=createAssistantPanel(doc,()=>new Promise<AssistantReply>(resolve=>{answer=resolve;}),()=>({den:'',year:'2026-27',email:'synthetic@example.test'}),()=>{});
 await panel.open();
 const text=doc.querySelector<HTMLTextAreaElement>('textarea')!;text.value='How many scouts?';text.dispatchEvent(new win.Event('input',{bubbles:true}) as unknown as Event);
 (doc.querySelector('[aria-label="Send message"]') as HTMLElement).click();
 (doc.querySelector('[data-assistant-action=close]') as HTMLElement).click();
 answer({message:'There are 3 scouts.'});await flush();
 assert.equal(doc.activeElement,outside);assert(!doc.querySelector('dialog')!.hasAttribute('open'));
 panel.dispose();await win.happyDOM.close();
});

test('New chat cancels an unsaved review, clears the draft and history, and starts with only the new question',async()=>{
 const win=new Window({url:'https://app.example.test'}),doc=win.document as unknown as Document,calls:Record<string,unknown>[]=[];
 let failCancel=true;
 const panel=createAssistantPanel(doc,async input=>{calls.push(input);if(input.action==='cancel'&&failCancel)throw new Error('Could not cancel the review');return input.action==='chat'?review:{message:'Cancelled.'};},()=>({den:'0-Lions',year:'2026-27',email:'synthetic@example.test'}),()=>{});
 await panel.open();
 const type=(value:string)=>{const text=doc.querySelector<HTMLTextAreaElement>('textarea')!;text.value=value;text.dispatchEvent(new win.Event('input',{bubbles:true}) as unknown as Event);};
 type('Record requirement 2');(doc.querySelector('[aria-label="Send message"]') as HTMLElement).click();await flush();
 type('Unsent draft');
 (doc.querySelector('[data-assistant-action=new-chat]') as HTMLElement).click();await flush();
 assert(doc.body.textContent?.includes('Could not cancel the review'));assert(doc.body.textContent?.includes('READY TO REVIEW'));
 assert.equal(win.sessionStorage.getItem('pack99-assistant-pending:synthetic@example.test'),id);
 failCancel=false;(doc.querySelector('[data-assistant-action=new-chat]') as HTMLElement).click();await flush();
 assert(doc.body.textContent?.includes('What can I help with?'));assert(!doc.body.textContent?.includes('Record requirement 2'));
 assert.equal(doc.querySelector<HTMLTextAreaElement>('textarea')!.value,'');assert.equal(doc.activeElement,doc.querySelector('textarea'));
 assert.equal(win.sessionStorage.getItem('pack99-assistant-pending:synthetic@example.test'),null);
 type('How many scouts in my den?');(doc.querySelector('[aria-label="Send message"]') as HTMLElement).click();await flush();
 const last=calls.at(-1)!;assert.equal(last.action,'chat');assert.deepEqual(last.messages,[{role:'user',content:'How many scouts in my den?'}]);
 assert.deepEqual(last.context,{den:'0-Lions',year:'2026-27'});assert(!calls.some(input=>input.action==='confirm'));
 panel.dispose();await win.happyDOM.close();
});

test('a failed question is recorded as failed before the next question is sent',async()=>{
 const win=new Window({url:'https://app.example.test'}),doc=win.document as unknown as Document,calls:Record<string,unknown>[]=[];
 const panel=createAssistantPanel(doc,async input=>{calls.push(input);if(calls.length===1)throw new Error('Lookup failed');return{message:'There are 3 scouts.'};},()=>({den:'',year:'2026-27',email:'synthetic@example.test'}),()=>{});
 await panel.open();
 for(const question of ['Who still needs Bobcat?','how many scouts are there?']){
  const text=doc.querySelector<HTMLTextAreaElement>('textarea')!;text.value=question;text.dispatchEvent(new win.Event('input',{bubbles:true}) as unknown as Event);doc.querySelector('form')!.dispatchEvent(new win.Event('submit',{bubbles:true,cancelable:true}) as unknown as Event);await flush();
 }
 const history=calls[1].messages as {role:string;content:string}[];assert.deepEqual(history.map(m=>m.role),['user','assistant','user']);assert.match(history[1].content,/request failed/);assert.equal(history.at(-1)!.content,'how many scouts are there?');
 panel.dispose();await win.happyDOM.close();
});

test('assistant renders escaped cards, never saves from chat and checks an uncertain save using the same proposal',async()=>{
 const win=new Window({url:'https://app.example.test'}),doc=win.document as unknown as Document,calls:Record<string,unknown>[]=[];
 let saves=0;
 const panel=createAssistantPanel(doc,async input=>{
  calls.push(input);
  if(input.action==='chat')return review;
  if(input.action==='confirm'){if(++saves===1)throw new Error('Connection lost');return{message:'Saved.',card:{kind:'saved',title:'1 update saved',rows:review.card!.kind==='review'?review.card!.rows:[],notificationsQueued:0}};}
  if(input.action==='status')return{message:'Saved.',card:{kind:'saved',title:'1 update saved',rows:[],notificationsQueued:0}};
  return{message:'Cancelled.'};
 },()=>({den:'0-Lions',year:'2026-27',email:'synthetic@example.test'}),()=>{});
 await panel.open();
 const input=doc.querySelector<HTMLTextAreaElement>('textarea')!;input.value='<img src=x onerror=alert(1)> complete requirement';input.dispatchEvent(new win.Event('input',{bubbles:true}) as unknown as Event);
 doc.querySelector('form')!.dispatchEvent(new win.Event('submit',{bubbles:true,cancelable:true}) as unknown as Event);await flush();
 assert.equal(calls.length,1);assert.equal(doc.querySelectorAll('img').length,0);assert(doc.body.textContent?.includes('READY TO REVIEW'));
 (doc.querySelector('[data-assistant-action=save]') as HTMLElement).click();await flush();
 assert.equal(calls[1].action,'confirm');assert.equal(calls[1].proposal_id,id);
 assert(doc.body.textContent?.includes('Check save status'));
 const newChat=doc.querySelector<HTMLButtonElement>('[data-assistant-action=new-chat]')!;assert(newChat.disabled);newChat.click();assert.equal(calls.length,2);
 (doc.querySelector('[data-assistant-action=status]') as HTMLElement).click();await flush();
 assert.equal(calls[2].proposal_id,id);assert.equal(saves,1);assert(doc.body.textContent?.includes('1 update saved'));
 panel.dispose();await win.happyDOM.close();
});

test('edited date and notification choice create a fresh review before any save',async()=>{
 const win=new Window({url:'https://app.example.test'}),doc=win.document as unknown as Document,calls:Record<string,unknown>[]=[];
 const panel=createAssistantPanel(doc,async input=>{calls.push(input);return review;},()=>({den:'',year:'2026-27',email:'synthetic@example.test'}),()=>{});
 await panel.open();
 const text=doc.querySelector<HTMLTextAreaElement>('textarea')!;text.value='complete requirement';text.dispatchEvent(new win.Event('input',{bubbles:true}) as unknown as Event);doc.querySelector('form')!.dispatchEvent(new win.Event('submit',{bubbles:true,cancelable:true}) as unknown as Event);await flush();
 doc.querySelector<HTMLInputElement>('[data-edit-date]')!.value='2026-10-31';
 doc.querySelector<HTMLInputElement>('[data-notify]')!.checked=true;
 (doc.querySelector('[data-assistant-action=save]') as HTMLElement).click();await flush();
 assert.equal(calls[1].action,'prepare');
 const commands=calls[1].commands as Record<string,unknown>[];assert.equal(commands[0].occurred_on,'2026-10-31');assert.equal(commands[0].notify_parents,true);
 assert(!calls.some(c=>c.action==='confirm'));
 panel.dispose();await win.happyDOM.close();
});

test('scout results and disambiguation use authorized portraits with initials for missing photos',async()=>{
 const win=new Window({url:'https://app.example.test/events?den=0-Lions'}),doc=win.document as unknown as Document,calls:Record<string,unknown>[]=[];
 const portrait='data:image/png;base64,c3ludGhldGlj';
 const items=[{label:'Maya Test',detail:'Lions, Bobcat not earned',scout_id:id},{label:'Sam Test',detail:'Lions, Bobcat not earned',scout_id:'missing'},{label:'Pack total',detail:'2 scouts'}];
 let choices=false;
 const panel=createAssistantPanel(doc,async input=>{calls.push(input);return{message:'Here are the scouts.',card:{kind:choices?'choices':'results',title:'Scouts needing Bobcat',items}};},()=>({den:'0-Lions',year:'2026-27',email:'synthetic@example.test'}),()=>{},scoutId=>scoutId===id?portrait:undefined);
 await panel.open();
 const ask=async()=>{const text=doc.querySelector<HTMLTextAreaElement>('textarea')!;text.value='Who needs Bobcat?';text.dispatchEvent(new win.Event('input',{bubbles:true}) as unknown as Event);doc.querySelector('form')!.dispatchEvent(new win.Event('submit',{bubbles:true,cancelable:true}) as unknown as Event);await flush();};
 await ask();
 assert.equal(doc.querySelector('.assistant-result img')?.getAttribute('src'),portrait);
 assert.equal(doc.querySelector('.assistant-result img')?.getAttribute('alt'),'');
 assert.equal(doc.querySelectorAll('.assistant-result')[1].querySelector('.assistant-avatar')?.textContent,'ST');
 assert.equal(doc.querySelectorAll('.assistant-result')[2].querySelector('.assistant-avatar'),null);
 const link=doc.querySelector('.assistant-result')!.getAttribute('href')!;
 assert.equal(new URL(link,win.location.href).pathname,'/');assert.equal(new URL(link,win.location.href).searchParams.get('den'),'0-Lions');assert.equal(new URL(link,win.location.href).hash,'#scout/'+id);
 choices=true;await ask();
 assert.equal(doc.querySelector('.assistant-choice img')?.getAttribute('src'),portrait);
 assert.equal(doc.querySelectorAll('.assistant-choice')[1].querySelector('.assistant-avatar')?.textContent,'ST');
 assert(!JSON.stringify(calls).includes(portrait),'portrait bytes must never enter LLM history');
 panel.dispose();await win.happyDOM.close();
});

test('phone dialogs follow the visual viewport through keyboard resize and pan, and restore desktop sizing',async()=>{
 const win=new Window({url:'https://app.example.test'}),doc=win.document as unknown as Document;
 win.happyDOM.setWindowSize({width:393,height:852});
 const viewport=Object.assign(new win.EventTarget(),{width:344,height:600,offsetLeft:12,offsetTop:24});
 Object.defineProperty(win,'visualViewport',{value:viewport,configurable:true});
 const panel=createAssistantPanel(doc,async()=>({message:'Test reply'}),()=>({den:'0-Lions',year:'2026-27',email:'synthetic@example.test'}),()=>{});
 await panel.open();
 const dialog=doc.querySelector('dialog')!;
 assert.equal(dialog.style.getPropertyValue('--assistant-viewport-width'),'344px');
 assert.equal(dialog.style.getPropertyValue('--assistant-viewport-left'),'12px');
 viewport.width=320;viewport.height=310;viewport.offsetTop=180;viewport.dispatchEvent(new win.Event('resize'));
 assert.equal(dialog.style.getPropertyValue('--assistant-viewport-width'),'320px');
 assert.equal(dialog.style.getPropertyValue('--assistant-viewport-height'),'310px');
 assert.equal(dialog.style.getPropertyValue('--assistant-viewport-top'),'180px');
 viewport.offsetLeft=40;viewport.dispatchEvent(new win.Event('scroll'));
 assert.equal(dialog.style.getPropertyValue('--assistant-viewport-left'),'40px');
 win.happyDOM.setWindowSize({width:1280,height:900});win.dispatchEvent(new win.Event('resize'));
 assert.equal(dialog.style.getPropertyValue('--assistant-viewport-width'),'');
 panel.dispose();viewport.width=200;viewport.dispatchEvent(new win.Event('resize'));
 assert.equal(dialog.style.getPropertyValue('--assistant-viewport-width'),'');assert.equal(doc.querySelector('dialog'),null);
 await win.happyDOM.close();
});

test('assistant labels and notification copy reflect the actual deployment',async()=>{
 const original=Object.getOwnPropertyDescriptor(globalThis,'__APP_BUILD__');
 try{
  for(const environment of ['staging','production']){
   Object.defineProperty(globalThis,'__APP_BUILD__',{value:{environment},configurable:true});
   const win=new Window({url:'https://app.example.test'}),doc=win.document as unknown as Document;
   const panel=createAssistantPanel(doc,async()=>review,()=>({den:'0-Lions',year:'2026-27',email:'synthetic@example.test'}),()=>{});
   await panel.open();
   assert.equal(doc.querySelector('.assistant-eyebrow')?.textContent,environment==='staging'?'PACKPILOT · STAGING':'PACKPILOT');
   const text=doc.querySelector<HTMLTextAreaElement>('textarea')!;text.value='Prepare a progress update';text.dispatchEvent(new win.Event('input',{bubbles:true}) as unknown as Event);
   doc.querySelector('form')!.dispatchEvent(new win.Event('submit',{bubbles:true,cancelable:true}) as unknown as Event);await flush();
   assert.equal(doc.querySelector('.assistant-notify')!.textContent!.includes('Staging delivery stays paused'),environment==='staging');
   panel.dispose();await win.happyDOM.close();
  }
 }finally{if(original)Object.defineProperty(globalThis,'__APP_BUILD__',original);else Reflect.deleteProperty(globalThis,'__APP_BUILD__');}
});
