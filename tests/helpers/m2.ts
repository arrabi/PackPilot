import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
export const id = (prefix: string, n: number) => `${prefix}0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export async function m2Fixture() {
 const db = new PGlite();
 await db.exec(`
 create role anon; create role authenticated; create role service_role bypassrls;
 create schema auth;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
 create table auth.identities(user_id uuid,provider text,identity_data jsonb);
 create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
 grant usage on schema public,auth to authenticated,anon;
 grant execute on function auth.uid() to authenticated;`);
 for(const file of ["20261023005332_roster_foundations.sql","20261024000100_m2_attendance_registration.sql","20261024000200_m2_advancement.sql","20261024000300_m2_equipment.sql","20261024000400_m2_reports.sql","20261024000500_m3_portal_capabilities.sql","20261031000100_gmail_leader_aliases.sql","20261031000200_leader_default_den.sql","20261101000100_pack_inventory.sql","20261101000200_den_planning.sql","20261101000300_shirt_import_history.sql","20261101000400_scout_bsa_member_id.sql","20261101000500_parent_portal.sql","20261101000600_parent_admin_preview.sql","20261101000700_family_assignments_messages.sql"])
  await db.exec(await readFile(new URL(`../../supabase/migrations/${file}`,import.meta.url),"utf8"));
 await db.exec(`
 insert into auth.users values('${id("0",1)}','admin@example.test',now()),('${id("0",2)}','reader@example.test',now()),('${id("0",3)}','stranger@example.test',now());
 insert into auth.identities select id,'google',jsonb_build_object('email',email,'email_verified',true) from auth.users;
 insert into public.leader_access(email) values('reader@example.test');
 insert into public.roster_snapshots(source_sha256,source_file,source_sheet,snapshot_date,expected_rows) values(repeat('a',64),'synthetic.xlsx','Roster 2026-27','2026-10-21',2);
 insert into public.scouts(id,snapshot_id,snapshot_date,source_row,scout_name,den,source_values) select '${id("1",1)}',id,'2026-10-21',2,'First Synthetic','1-Tigers','{}' from public.roster_snapshots;
 insert into public.scouts(id,snapshot_id,snapshot_date,source_row,scout_name,den,source_values) select '${id("1",2)}',id,'2026-10-21',3,'Second Synthetic','0-Lions','{}' from public.roster_snapshots;`);
 async function asUser<T>(actor:number,run:()=>Promise<T>) {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${id("0",actor)}',false)`);
  try{return await run();}finally{await db.exec("reset role");}
 }
 async function write(n:number,command:object,actor=1) {
  const r=await asUser(actor,()=>db.query<{result:Record<string,unknown>}>("select public.record_pack_operation($1::uuid,$2::jsonb) result",[id("3",n),JSON.stringify(command)]));return r.rows[0].result;
 }
 async function read(entity:string,scout:string|null=null,year:string|null=null,actor=2) {
  const r=await asUser(actor,()=>db.query<{result:{total:number;rows:Record<string,unknown>[];next_offset:number|null}}>("select public.read_pack_equipment($1,$2::uuid,$3) result",[entity,scout,year]));return r.rows[0].result;
 }
 return {db,asUser,write,read};
}
