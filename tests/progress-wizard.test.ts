import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Window} from 'happy-dom';
import {progressWizard, type ProgressWizardState} from '../auth-ui/progress-wizard.ts';
import {emptyData, type Adventure} from '../auth-ui/portal-model.ts';

const adventure:Adventure={id:'test',name:'Test badge',rank:'lion',program_version:'test',source_url:'https://www.scouting.org/',requirements:[{code:'1',description:'Already done'},{code:'2',description:'Still needed'}],readiness_mode:'automatic'};
const state:ProgressWizardState={step:1,action:'record_requirement',adventure:'test',requirement:'',selected:new Set(),date:'2026-11-03',badge:'belt_loop',instructions:'',due:'',reason:''};
test('completion choices include earned badges as disabled and count earned scouts toward requirement totals',async()=>{
 const win=new Window();const data=emptyData();data.adventures=[adventure,{...adventure,id:'all',name:'Everyone earned this'}];
 data.scouts=[1,2,3,4].map(n=>({id:String(n),scout_name:'Scout '+n,den:'0-Lions'}));data.scouts.push({id:'other',scout_name:'Other rank',den:'1-Tigers'});
 data.advancement=[{scout_id:'1',adventure_id:'test',revision:1,earned_on:'2026-10-01',badge_delivered_on:null,badge_form:null},...data.scouts.slice(0,4).map(s=>({scout_id:s.id,adventure_id:'all',revision:1,earned_on:'2026-10-01',badge_delivered_on:null,badge_form:null}))];
 data.progress=data.scouts.slice(1,4).map(s=>({scout_id:s.id,adventure_id:'test',requirement_code:'1',completed_on:'2026-10-01',completion_source:'individual'}));
 try{
  for(const action of ['record_requirement','earn_adventure']){
   win.document.body.innerHTML=progressWizard(data,data.scouts,{...state,action},false);
   assert.match(win.document.querySelector('[data-value=test]')!.textContent!,/1\/4 scouts got it/);
   const all=win.document.querySelector('[data-value=all]') as any;assert.equal(all.disabled,true);assert.match(all.textContent,/4\/4 scouts got it/);
  }
  win.document.body.innerHTML=progressWizard(data,data.scouts,{...state,step:2},false);
  const done=win.document.querySelector('[data-action=wizard-requirement][data-value="1"]') as any;
  assert.equal(done.disabled,true);assert.match(done.textContent,/4\/4 scouts got it/);
  const remaining=win.document.querySelector('[data-action=wizard-requirement][data-value="2"]') as any;
  assert.equal(remaining.disabled,false);assert.match(remaining.textContent,/1\/4 scouts got it/);
 }finally{await win.happyDOM.close();}
});
