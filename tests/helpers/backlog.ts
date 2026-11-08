import {readFile}from'node:fs/promises';
import{m2Fixture,id}from'./m2.ts';
export async function backlogFixture(extra:string[]=[]){
 const f=await m2Fixture();
 for(const file of ['20261102080000_family_participation.sql','20261102080100_parent_notifications.sql','20261102190000_remove_health_information.sql','20261102190100_site_policy_acceptance.sql','20261102200000_email_preferences.sql','20261102210000_backlog_foundation.sql',...extra])await f.db.exec(await readFile(new URL('../../supabase/migrations/'+file,import.meta.url),'utf8'));
 await f.db.exec(`insert into auth.users values('${id('0',4)}','mom@example.test',now()),('${id('0',5)}','dad@example.test',now()),('${id('0',6)}','other@example.test',now());insert into public.parent_scout_links(scout_id,parent_email,created_by)values('${id('1',1)}','mom@example.test','${id('0',1)}'),('${id('1',1)}','dad@example.test','${id('0',1)}'),('${id('1',2)}','other@example.test','${id('0',1)}');`);
 for(const actor of [1,2,4,5,6])await f.asUser(actor,async()=>{const r=(await f.db.query<{s:any}>('select public.get_site_policy_status()s')).rows[0].s;await f.db.query('select public.accept_site_policies($1,$2,$3)',[r.version,r.terms_hash,r.privacy_hash]);if(actor>=4)await f.db.query('select public.claim_parent_links()');});
 await f.db.query("select set_config('request.jwt.claim.sub','',false)");
 const asUser=async<T>(actor:number,run:()=>Promise<T>)=>{try{return await f.asUser(actor,run);}finally{await f.db.query("select set_config('request.jwt.claim.sub','',false)");}};
 const command=(n:number,command:Record<string,unknown>,actor=1)=>asUser(actor,()=>f.db.query('select public.record_pack_community($1,$2)',[id('8',n),command]));
 return{...f,asUser,command};
}
