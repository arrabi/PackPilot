import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Window} from 'happy-dom';
import {returnHomeAfterScenario,takeScenarioNotice} from '../auth-ui/scenario-navigation.ts';

test('standalone scenarios return to the appropriate Home and carry a one-time confirmation',async()=>{
 for(const role of ['leader','parent'] as const){
  const win=new Window({url:'https://example.test/events?event=old&view=list'});
  try{
   returnHomeAfterScenario(win as any,role,{year:'2026-27',den:'0-Lions',child:'one'},'Saved successfully.');
   assert.equal(win.location.pathname,role==='leader'?'/':'/parents');assert.equal(win.location.search.includes('event='),false);assert.equal(win.location.search.includes('view='),false);assert.equal(win.location.hash,role==='leader'?'#home':'');
   assert.equal(takeScenarioNotice(win as any,role),'Saved successfully.');assert.equal(takeScenarioNotice(win as any,role),'');
  }finally{await win.happyDOM.close();}
 }
});

test('expired completion notices are discarded',async()=>{
 const win=new Window({url:'https://example.test/'});
 try{win.sessionStorage.setItem('pack99-scenario-complete-leader',JSON.stringify({message:'Old success',created:Date.now()-600000}));assert.equal(takeScenarioNotice(win as any,'leader'),'');}finally{await win.happyDOM.close();}
});
