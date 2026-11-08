import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepareV2Routes,v2Pages} from '../scripts/prepare-v2-routes.ts';
import {safeLeaderReturn} from '../auth-ui/app-shell.ts';
import {safeParentReturn,workspaceViewFromPath} from '../auth-ui/workspace-model.ts';

test('previous design entries are real directory indexes, with their original page entry scripts',()=>{
 const directory=mkdtempSync(join(tmpdir(),'pack99-v2-routes-'));
 try{
  for(const page of v2Pages)writeFileSync(join(directory,page+'.html'),`<html><script src="/assets/${page}-built.js"></script></html>`);
  prepareV2Routes(directory);
  for(const page of v2Pages)assert.equal(readFileSync(join(directory,'prev',page==='index'?'':page,'index.html'),'utf8'),readFileSync(join(directory,page+'.html'),'utf8'));
 }finally{rmSync(directory,{recursive:true,force:true});}
});

test('previous design routes stay under prev and old v2 URLs redirect to the default app',()=>{
 const rules=readFileSync(new URL('../auth-ui/public/_redirects',import.meta.url),'utf8').trim().split('\n');
 const previous=rules.filter(line=>line.startsWith('/prev'));
 assert.equal(previous.length,v2Pages.length);
 for(const line of previous){const[source,target,status]=line.split(/\s+/);assert.equal(target,source+'/');assert.equal(status,'302');}
 const aliases=rules.filter(line=>line.startsWith('/v2'));
 assert.equal(aliases.length,v2Pages.length*2);
 for(const line of aliases){const[source,target,status]=line.split(/\s+/);assert.equal(target,source.replace(/^\/v2/,'').replace(/\/$/,'')||'/');assert.equal(status,'302');}
 assert.ok(!rules.some(line=>line==='/* /index.html 200'));
});

test('directory URLs retain the selected workspace page and remain valid authentication returns',()=>{
 for(const page of v2Pages.filter(p=>p!=='index'&&p!=='parents')){
  assert.equal(workspaceViewFromPath('/prev/'+page+'/'),page);
  assert.equal(safeLeaderReturn('/prev/'+page+'/?year=2026-27'),'/prev/'+page+'/?year=2026-27');
  assert.equal(workspaceViewFromPath('/v2/'+page+'/'),page);
  assert.equal(workspaceViewFromPath('/v2/'+page),page);
  assert.equal(workspaceViewFromPath('/'+page),page);
  assert.equal(safeLeaderReturn('/v2/'+page+'/?year=2026-27'),'/v2/'+page+'/?year=2026-27');
 }
 assert.equal(safeLeaderReturn('/v2/'),'/v2/');
 assert.equal(safeLeaderReturn('/v2/parents/?preview=1'),'/v2/parents/?preview=1');
 assert.equal(safeParentReturn('/v2/events/?event=meeting'),'/v2/events/?event=meeting&parent=1');
 assert.equal(safeParentReturn('/v2/planner/'),null);
 assert.equal(safeLeaderReturn('/v2/unknown/'),'/');
 assert.equal(workspaceViewFromPath('/community','#meetings'),'planner');
});
