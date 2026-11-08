import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyData, type Adventure } from '../auth-ui/portal-model.ts';
import { homeProgress, renderHome } from '../auth-ui/portal-home.ts';

test('home counts rank-specific scout-adventures and separates earned from partial progress', () => {
 const data=emptyData();
 data.scouts=[{id:'l1',scout_name:'Lion One',den:'0-Lions'},{id:'l2',scout_name:'Lion Two',den:'0-Lions'},{id:'t1',scout_name:'Tiger One',den:'1-Tigers'},{id:'w',scout_name:'Withdrawn',den:'(withdraw) 0-Lions'},{id:'u',scout_name:'Unknown',den:null}];
 const adventure=(id:string,rank:string,type='Required (Core)'):Adventure=>({id,name:id,rank,program_version:'test',source_url:'',readiness_mode:'automatic',catalog_context:{adventure_type:type},requirements:[{code:'1',description:'One'},{code:'2',description:'Two'}]});
 data.adventures=[adventure('lion','lion'),adventure('tiger','tiger'),adventure('elective','lion','Elective')];
 data.advancement=[{scout_id:'l1',adventure_id:'lion',earned_on:'2026-10-01',badge_delivered_on:null,badge_form:null,revision:1},{scout_id:'w',adventure_id:'lion',earned_on:'2026-10-01',badge_delivered_on:null,badge_form:null,revision:1}];
 data.progress=[{scout_id:'l2',adventure_id:'lion',requirement_code:'1',completed_on:'2026-10-01',completion_source:'leader'},{scout_id:'l2',adventure_id:'lion',requirement_code:'1',completed_on:'2026-10-01',completion_source:'leader'},{scout_id:'l2',adventure_id:'lion',requirement_code:'obsolete',completed_on:'2026-10-01',completion_source:'leader'}];
 const p=homeProgress(data,data.scouts);
 assert.equal(p.core,3);assert.equal(p.coreEarned,1);assert.equal(p.rows.length,4);assert.equal(p.started,1);assert.equal(p.requirements,3);assert.equal(p.waiting,1);
 assert.equal(p.adventures[0].adventure.id,'lion');assert.equal(p.adventures.at(-1)?.adventure.id,'elective');
 const tiger=homeProgress(data,data.scouts.filter(s=>s.den==='1-Tigers'));
 assert.equal(tiger.core,1);assert.equal(tiger.coreEarned,0);assert.equal(tiger.started,0);
 const empty=renderHome(emptyData(),[],'','2026-27');
 assert.match(empty,/No scouts match this view/);assert.doesNotMatch(empty,/NaN|Infinity/);
 data.scouts[0].scout_name='<img src=x onerror=alert(1)>';
 assert.match(renderHome(data,data.scouts,'','2026-27'),/&lt;img/);
});

test('Needs attention respects the supplied scout scope and links to review work', async()=>{
 const {needsAttention}=await import('../auth-ui/attention.ts');const data=emptyData();data.scouts=[{id:'one',scout_name:'One',den:'0-Lions'},{id:'two',scout_name:'Private other den',den:'1-Tigers'}];
 const html=needsAttention(data,[data.scouts[0]]);assert.match(html,/One: active.com registration needs follow-up/);assert.doesNotMatch(html,/Private other den/);assert.match(html,/#scout\/one/);
});
