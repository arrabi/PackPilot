import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';

// Run the Python transport's SQL against a real PostgreSQL engine, including
// escaped input, trigger suppression, actor remapping and failed-import rollback.
function python(action:string,input:unknown={}):Promise<any> {
 const code=`import sys,json,importlib.util\nsys.path.insert(0,'scripts/release')\nimport staging_refresh_api as a\nspec=importlib.util.spec_from_file_location('refresh','scripts/release/refresh-staging.py')\nr=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)\nx=json.load(sys.stdin)\n`;
 return new Promise((resolve,reject)=>{
  const child=spawn('python',['-c',code+action]);let output='',errors='';
  child.stdout.setEncoding('utf8').on('data',chunk=>output+=chunk);
  child.stderr.setEncoding('utf8').on('data',chunk=>errors+=chunk);
  child.on('error',reject);child.on('close',status=>{
   if(status!==0){reject(Error('Python SQL builder failed: '+errors));return;}
   try{resolve(JSON.parse(output));}catch(error){reject(error);}
  });child.stdin.end(JSON.stringify(input));
 });
}

test('HTTPS staging refresh remaps actors, isolates family access, clears Auth and rolls back invalid relationships',async()=>{
 const db=new PGlite({extensions:{pgcrypto}});
 try {
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
   create schema auth;create schema storage;create table storage.objects(id uuid);
   create schema net;create schema extensions;create schema cron;create table cron.job(jobid bigint);
   create table net.http_request_queue(id bigint);create table net._http_response(id bigint);
   create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,instance_id uuid,role text,aud text,
     banned_until timestamptz,raw_app_meta_data jsonb,raw_user_meta_data jsonb,created_at timestamptz,updated_at timestamptz);
   create table auth.identities(user_id uuid references auth.users(id),provider text,identity_data jsonb);
   create table auth.sessions(user_id uuid references auth.users(id));
   create table auth.refresh_tokens(user_id uuid references auth.users(id));
   create function auth.uid()returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
   grant usage on schema public,auth to anon,authenticated,service_role;grant execute on function auth.uid()to authenticated;`);
  for(const name of (await readdir('supabase/migrations')).filter(n=>n.endsWith('.sql')).sort()){
   const sql=(await readFile('supabase/migrations/'+name,'utf8'))
     .replace('create extension if not exists pg_cron with schema pg_catalog;','')
     .replace('create extension if not exists pg_net with schema extensions;','');
   await db.exec(sql);
  }
  const actor='10000000-0000-4000-8000-000000000001',scout='20000000-0000-4000-8000-000000000001',adventure='30000000-0000-4000-8000-000000000001';
  await db.query(`insert into auth.users(id,email,email_confirmed_at)values($1,'owner@example.test',now());`,[actor]);
  await db.query(`insert into auth.identities values($1,'google','{"email_verified":true}');`,[actor]);
  await db.exec(`insert into public.roster_snapshots(source_sha256,source_file,source_sheet,snapshot_date,expected_rows)
    values(repeat('a',64),'synthetic','Roster 2026-27',current_date,1);`);
  const text="Synthetic 'quoted' \\ text $$; select 'literal'";
  await db.query(`insert into public.scouts(id,snapshot_id,snapshot_date,source_row,scout_name,den,source_values)
    select $1,id,current_date,2,$2,'1-Tigers','{}'from public.roster_snapshots`,[scout,text]);
  await db.query(`insert into public.pack_adventures(id,name,rank,program_version,source_url,source_verified_on,requirements,completion_groups,recorded_by)
    values($1,$2,'tiger','synthetic','https://example.test/',current_date,'[]','[]',$3)`,[adventure,text,actor]);
  await db.query(`insert into public.parent_scout_links(scout_id,parent_email,created_by)values($1,'parent@example.test',$2)`,[scout,actor]);
  const source=await python('print(json.dumps(a.source_sql(r.PUBLIC,r.PRIVATE)))');
  const results=await db.exec(source);
  const snapshot=results.flatMap(r=>r.rows as any[]).find(r=>r.snapshot)?.snapshot;
  assert.ok(snapshot);
  const catalog=(await db.query(`select table_schema,table_name,column_name from information_schema.columns c
    where table_schema in('public','private')and table_name<>'pack_release_maintenance'and is_generated='NEVER'
    and exists(select 1 from pg_tables t where t.schemaname=c.table_schema and t.tablename=c.table_name)
    order by table_schema,table_name,ordinal_position`)).rows as any[];
  const columns:Record<string,string[]>={};for(const row of catalog)(columns[row.table_schema+'.'+row.table_name]??=[]).push(row.column_name);
  const defaults:Record<string,unknown[]>={};
  for(const name of ['parent_portal_settings','pack_notification_settings'])defaults[name]=(await db.query(`select to_jsonb(t)record from private.${name} t`)).rows.map((r:any)=>r.record);
  const seedInput={tables:Object.fromEntries(['roster_snapshots','scouts','pack_adventures'].map(name=>[name,snapshot.tables['public.'+name]])),
    columns:Object.fromEntries(['roster_snapshots','scouts','pack_adventures'].map(name=>[name,columns['public.'+name]])),owner:actor};
  seedInput.tables.pack_adventures[0].recorded_by='90000000-0000-4000-8000-000000000099';
  const seedCode=`s=importlib.util.spec_from_file_location('seed','scripts/release/import-staging-roster.py')\nm=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nprint(json.dumps(m.import_sql(x['tables'],x['columns'],x['owner'])))`;
  const seedSql=await python(seedCode,seedInput);
  await assert.rejects(db.exec(seedSql),/requires empty tables/);await db.exec('rollback');
  await db.exec('truncate public.roster_snapshots,public.pack_adventures cascade');
  await db.exec(seedSql);
  assert.equal((await db.query<{n:number}>('select count(*)::int n from auth.identities')).rows[0].n,1);
  assert.equal((await db.query<{recorded_by:string}>('select recorded_by from public.pack_adventures')).rows[0].recorded_by,actor);
  // Restore the untouched source fixture for the independent full-refresh check.
  snapshot.tables['public.pack_adventures'][0].recorded_by=actor;
  const action=`tables,mapping=a.checked_snapshot(x['snapshot'],r.PUBLIC,r.PRIVATE,'bbbbbbbbbbbbbbbbbbbb',r.remap)\nprint(json.dumps(a.replacement_sql(tables,mapping,x['defaults'],x['columns'],'bbbbbbbbbbbbbbbbbbbb')))`;
  const input={snapshot,columns,defaults};
  await db.exec('select private.set_release_maintenance(true)');
  await db.exec(await python(action,input));
  assert.equal((await db.query<{scout_name:string}>('select scout_name from public.scouts')).rows[0].scout_name,text);
  assert.equal((await db.query<{name:string}>('select name from public.pack_adventures')).rows[0].name,text);
  assert.equal((await db.query<{n:number}>('select count(*)::int n from auth.identities')).rows[0].n,0);
  assert.equal((await db.query<{n:number}>("select count(*)::int n from auth.users where banned_until='infinity'")).rows[0].n,1);
  assert.equal((await db.query<{n:number}>("select count(*)::int n from public.parent_scout_links where active and parent_email<>'staging@example.test'")).rows[0].n,0);
  assert.equal((await db.query<{n:number}>("select count(*)::int n from public.parent_scout_links where active and parent_email='staging@example.test'")).rows[0].n,1);
  const remapped=(await db.query<{recorded_by:string}>('select recorded_by from public.pack_adventures')).rows[0].recorded_by;
  assert.notEqual(remapped,actor);
  const bad=structuredClone(input);bad.snapshot.tables['public.scouts'][0].snapshot_id='90000000-0000-4000-8000-000000000099';
  await assert.rejects(db.exec(await python(action,bad)),/relationship integrity/);
  await db.exec('rollback');
  assert.equal((await db.query<{recorded_by:string}>('select recorded_by from public.pack_adventures')).rows[0].recorded_by,remapped);
  assert.equal((await db.query<{enabled:boolean}>('select enabled from private.pack_release_maintenance')).rows[0].enabled,true);
 }finally{await db.close();}
});
