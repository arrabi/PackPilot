import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Window,type HTMLTextAreaElement,type HTMLButtonElement} from 'happy-dom';
import {mountWorkspace,type WorkspaceService} from '../auth-ui/workspace-ui.ts';
import {v2Home} from '../auth-ui/v2-views.ts';
import {emptyData} from '../auth-ui/portal-model.ts';

const flush=()=>new Promise(r=>setTimeout(r,20));
async function notes(overrides:Partial<WorkspaceService>={},initial:any[]=[]) {
 const win=new Window({url:'https://example.test/notes?den=0-Lions&year=2026-27'});
 win.document.body.innerHTML='<div id="app"></div>';
 const root=win.document.getElementById('app')!,commands:any[]=[];
 const app=mountWorkspace(root as any,{async rpc(name,args){if(name==='read_pack_workspace')return {leader:true,can_record:false,is_admin:true,user_id:'me',scouts:[],events:[],jobs:[],bookings:[],volunteers:[],meetings:[],photos:[],adventures:[],notes:structuredClone(initial)} as any;commands.push(args);return null;},...overrides},'notes');
 await app.ready;
 const textarea=()=>root.querySelector<HTMLTextAreaElement>('textarea')!;
 const type=(body:string)=>{textarea().value=body;textarea().dispatchEvent(new win.Event('input',{bubbles:true}));};
 const submit=()=>root.querySelector('form[data-kind=note]')!.dispatchEvent(new win.Event('submit',{bubbles:true,cancelable:true}));
 return {win,root,commands,textarea,type,submit,async close(){app.dispose();await win.happyDOM.close();}};
}

test('Home links to My Notes; empty editor saves once without a review dialog and stays open for further edits',async()=>{
 assert.match(v2Home(emptyData(),[],'0-Lions','2026-27'),/href="\/notes"[^>]*>.*My Notes/);
 const app=await notes();
 try {
  assert.equal(app.root.querySelector('h1')?.textContent,'My Notes');
  assert.match(app.root.querySelector('#notes-privacy')!.textContent!,/Only you can see them/);
  assert.equal(app.root.querySelectorAll('textarea').length,1);
  assert.equal(app.root.querySelector('.workspace-filters'),null);
  assert.equal(app.root.querySelector('.v2-bottom'),null);
  assert.equal(app.root.querySelector<HTMLButtonElement>('[data-note-save]')!.disabled,true);
  app.type('Before the next meeting\nBring extra rope.');
  assert.match(app.root.querySelector('[data-note-state]')!.textContent!,/Unsaved changes/);
  app.submit();await flush();
  assert.equal(app.root.querySelector('.v2-review'),null);
  assert.equal(app.commands.length,1);assert.equal(app.commands[0].command.den,'');
  assert.equal(app.win.location.pathname,'/notes');
  assert.match(app.root.querySelector('.notice')!.textContent!,/Saved just now/);
  assert.equal(app.textarea().value,'Before the next meeting\nBring extra rope.');
  app.type('Second edit');app.submit();await flush();
  assert.equal(app.commands[1].command.id,app.commands[0].command.id);
  assert.equal(app.commands[1].command.revision,1);
  app.type('');app.submit();await flush();assert.equal(app.commands[2].command.body,'');
 } finally {await app.close();}
});

test('Uncertain saves retain the draft and retry the same request; sign-out clears private content',async()=>{
 let attempts:any[]=[],signedOut:(()=>void)|undefined;
 const app=await notes({onSignOut(fn){signedOut=fn;return()=>{};},async rpc(name,args){if(name==='read_pack_workspace')return {leader:true,is_admin:false,user_id:'me',scouts:[],events:[],jobs:[],bookings:[],volunteers:[],meetings:[],photos:[],adventures:[],notes:[]} as any;attempts.push(structuredClone(args));if(attempts.length===1)throw Error('Network interrupted');return null;}});
 try {
  app.type('Keep this draft');app.submit();await flush();
  assert.equal(app.textarea().value,'Keep this draft');
  assert.ok(app.root.querySelector('[data-retry]'));
  app.root.querySelector<HTMLButtonElement>('[data-retry]')!.click();await flush();
  assert.deepEqual(attempts[1],attempts[0]);assert.equal(app.textarea().value,'Keep this draft');
  signedOut!();assert.equal(app.root.querySelector('textarea'),null);assert.ok(!app.root.textContent!.includes('Keep this draft'));
 } finally {await app.close();}
});

test('Conflicts retain edits until explicit reload; cancel confirms dirty changes; prior den notes stay editable and escaped',async()=>{
 const initial=[{id:'old',owner_id:'me',den:'1-Tigers',body:'<script>private</script>',revision:2}, {id:'other',owner_id:'other',den:'',body:'OTHER PERSON SECRET',revision:1}];
 const app=await notes({},initial);
 try {
  assert.ok(!app.root.textContent!.includes('OTHER PERSON SECRET'));
  const previous=app.root.querySelector('.my-notes-previous')!;
  assert.ok(previous);assert.equal(app.root.querySelector('script'),null);
  assert.equal(previous.querySelector('textarea')!.value,'<script>private</script>');
  let confirms=0;(app.win as any).confirm=()=>{confirms++;return false;};
  app.type('Do not lose this');app.root.querySelector<HTMLButtonElement>('[data-notes-cancel]')!.click();
  assert.equal(confirms,1);assert.equal(app.win.location.pathname,'/notes');assert.equal(app.textarea().value,'Do not lose this');
  app.type('');app.root.querySelector<HTMLButtonElement>('[data-notes-cancel]')!.click();assert.equal(confirms,1);assert.equal(app.win.location.pathname,'/');
 } finally {await app.close();}
 const conflict=await notes({async rpc(name){if(name==='read_pack_workspace')return {leader:true,user_id:'me',scouts:[],events:[],jobs:[],bookings:[],volunteers:[],meetings:[],photos:[],adventures:[],notes:[]} as any;throw Object.assign(Error('Note changed; refresh'),{code:'P0001'});}});
 try {
  conflict.type('Keep my work');conflict.submit();await flush();
  assert.equal(conflict.textarea().value,'Keep my work');assert.match(conflict.root.querySelector('[role=alert]')!.textContent!,/Reload/);
  (conflict.win as any).confirm=()=>false;conflict.root.querySelector<HTMLButtonElement>('[data-reload-notes]')!.click();assert.equal(conflict.textarea().value,'Keep my work');
  (conflict.win as any).confirm=()=>true;conflict.root.querySelector<HTMLButtonElement>('[data-reload-notes]')!.click();await flush();assert.equal(conflict.textarea().value,'');
 } finally {await conflict.close();}
});
