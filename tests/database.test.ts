import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

test("real PostgreSQL policies enforce Google approval, revocation and read-only access", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth;
      create table auth.users(id uuid primary key, email text, email_confirmed_at timestamptz);
      create table auth.identities(user_id uuid, provider text, identity_data jsonb);
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      grant usage on schema public, auth to authenticated, anon;
      grant execute on function auth.uid() to authenticated;
    `);
    await db.exec(await readFile(new URL("../supabase/migrations/20261023005332_roster_foundations.sql", import.meta.url), "utf8"));
    await db.exec(`
      insert into auth.users values
        ('00000000-0000-0000-0000-000000000001','admin@example.test',now()),
        ('00000000-0000-0000-0000-000000000002','leader@example.test',now()),
        ('00000000-0000-0000-0000-000000000003','stranger@example.test',now()),
        ('00000000-0000-0000-0000-000000000004','fake@example.test',now()),
        ('00000000-0000-0000-0000-000000000005','unverified@example.test',now()),
        ('00000000-0000-0000-0000-000000000006','unconfirmed@example.test',null);
      insert into auth.identities select id,'google',jsonb_build_object('email',email,'email_verified',true) from auth.users where email <> 'fake@example.test';
      update auth.identities set identity_data=jsonb_set(identity_data,'{email_verified}','false') where user_id='00000000-0000-0000-0000-000000000005';
      insert into public.leader_access(email) values ('leader@example.test'),('fake@example.test'),('unverified@example.test'),('unconfirmed@example.test');
      insert into public.roster_snapshots(source_sha256,source_file,source_sheet,snapshot_date,expected_rows)
        values (repeat('a',64),'synthetic.xlsx','Roster 2026-27','2026-10-21',1);
      insert into public.scouts(snapshot_id,snapshot_date,source_row,scout_name,source_values)
        select id,'2026-10-21',2,'Synthetic Scout','{}' from public.roster_snapshots;
    `);
    const asUser = async (suffix: string, sql: string) => {
      await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-${suffix.padStart(12, "0")}', false)`);
      try { return await db.query<Record<string, unknown>>(sql); } finally { await db.exec("reset role"); }
    };
    assert.equal((await asUser("1", "select is_approved_leader() as ok")).rows[0].ok, true);
    assert.equal((await asUser("2", "select jsonb_array_length(read_roster_snapshot()) as n")).rows[0].n, 1);
    assert.equal((await asUser("3", "select * from scouts")).rows.length, 0);
    assert.equal((await asUser("4", "select is_approved_leader() as ok")).rows[0].ok, false);
    assert.equal((await asUser("5", "select is_approved_leader() as ok")).rows[0].ok, false);
    assert.equal((await asUser("6", "select is_approved_leader() as ok")).rows[0].ok, false);
    await assert.rejects(asUser("3", "select read_roster_snapshot()"), /denied/);
    for (const sql of ["update scouts set scout_name='Changed'", "delete from scouts", "insert into leader_access(email) values ('intruder@example.test')", "select * from leader_access"]) {
      await assert.rejects(asUser("1", sql), /permission denied/);
    }
    await db.exec("update leader_access set active=false where email='leader@example.test'");
    assert.equal((await asUser("2", "select * from scouts")).rows.length, 0);
    await assert.rejects(asUser("2", "select read_roster_snapshot()"), /denied/);
    await db.exec("set role anon");
    await assert.rejects(db.query("select * from scouts"), /permission denied/);
    await db.exec("reset role; update roster_snapshots set expected_rows=2");
    await assert.rejects(asUser("1", "select read_roster_snapshot()"), /reconciliation/);
  } finally { await db.close(); }
});
