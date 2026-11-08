import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { recordOperationSchema } from "../supabase/functions/_shared/operations.ts";

const scout = "10000000-0000-4000-8000-000000000001";
const activity = "20000000-0000-4000-8000-000000000001";
const user = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const request = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

test("M2 database enforces capability, independent registrations, dates, correction history and retry safety", async () => {
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
    for (const file of ["20261023005332_roster_foundations.sql", "20261024000100_m2_attendance_registration.sql"]) {
      await db.exec(await readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), "utf8"));
    }
    await db.exec(`
      insert into auth.users values ('${user(1)}','admin@example.test',now()),('${user(2)}','reader@example.test',now()),('${user(3)}','stranger@example.test',now());
      insert into auth.identities select id,'google',jsonb_build_object('email',email,'email_verified',true) from auth.users;
      insert into public.leader_access(email) values('reader@example.test');
      insert into public.roster_snapshots(source_sha256,source_file,source_sheet,snapshot_date,expected_rows)
        values(repeat('a',64),'synthetic.xlsx','Roster 2026-27','2026-10-21',1);
      insert into public.scouts(id,snapshot_id,snapshot_date,source_row,scout_name,source_values)
        select '${scout}',id,'2026-10-21',2,'Synthetic Scout','{}' from public.roster_snapshots;
    `);
    async function asUser<T>(n: number, run: () => Promise<T>) {
      await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${user(n)}',false)`);
      try { return await run(); } finally { await db.exec("reset role"); }
    }
    const write = (n: number, id: number, command: object) => asUser(n, () => db.query<{ result: Record<string, unknown> }>("select public.record_pack_operation($1::uuid,$2::jsonb) as result", [request(id), JSON.stringify(command)]));
    const read = (n: number, entity: string, offset = 0, limit = 50) => asUser(n, () => db.query<{ result: { total: number; rows: Record<string, unknown>[]; next_offset: number | null } }>("select public.read_pack_operations($1,null,null,null,$2,$3) as result", [entity, offset, limit]));
    const create = { action: "create_activity", activity_id: activity, title: "Synthetic hike", kind: "hike", scouting_year: "2026-27", occurred_on: "2026-10-10" };
    await assert.rejects(write(2, 1, create), /Recording access denied/);
    await assert.rejects(write(3, 1, create), /Recording access denied/);
    await assert.rejects(read(3, "activities"), /Access denied/);
    const created = await write(1, 1, create);
    assert.equal(created.rows[0].result.occurred_on, "2026-10-10");
    assert.deepEqual((await write(1, 1, create)).rows, created.rows);
    await assert.rejects(write(1, 1, { ...create, title: "Changed" }), /Request ID conflict/);
    assert.equal((await read(2, "activities")).rows[0].result.total, 1);
    assert.equal((await read(2, "attendance")).rows[0].result.total, 0);
    const attendance = { action: "record_attendance", activity_id: activity, scout_id: scout, status: "present", expected_revision: 0 };
    const marked = await write(1, 2, attendance);
    assert.equal(marked.rows[0].result.occurred_on, "2026-10-10");
    assert.equal(marked.rows[0].result.revision, 1);
    await assert.rejects(write(1, 3, { ...attendance, status: "absent" }), /Revision conflict/);
    await assert.rejects(write(1, 3, { ...attendance, expected_revision: 1, occurred_on: "2026-10-11" }), /Attendance date/);
    await write(1, 3, { ...attendance, status: "excused", expected_revision: 1 });
    const current = (await read(2, "attendance")).rows[0].result.rows[0];
    assert.equal(current.status, "excused");
    assert.equal(current.revision, 2);
    assert.equal(current.recorded_by, user(1));
    const registration = { action: "record_registration", scout_id: scout, scouting_year: "2026-27", platform: "active.com", status: "confirmed", occurred_on: "2026-09-01", expected_revision: 0 };
    await write(1, 4, registration);
    assert.equal((await read(2, "registrations")).rows[0].result.total, 1);
    await write(1, 5, { ...registration, platform: "scouting.org", status: "unknown", occurred_on: "2026-10-01" });
    const first = (await read(2, "registrations", 0, 1)).rows[0].result;
    assert.equal(first.total, 2); assert.equal(first.rows.length, 1); assert.equal(first.next_offset, 1);
    assert.equal(first.rows[0].status, "confirmed");
    assert.equal(first.rows[0].occurred_on, "2026-09-01");
    assert.equal((await read(2, "registrations", 1, 1)).rows[0].result.rows[0].status, "unknown");
    await assert.rejects(write(1, 6, { ...registration, scouting_year: "2026-28" }), /Invalid scouting year/);
    await assert.rejects(write(1, 6, { ...registration, injected: true }), /Invalid command fields/);
    await assert.rejects(asUser(1, () => db.exec("delete from public.pack_attendance")), /permission denied/);
    await assert.rejects(asUser(1, () => db.exec("select * from public.pack_commands")), /permission denied/);
    const audit = await db.query<{ n: number; actors: number }>("select count(*)::int n,count(distinct recorded_by)::int actors from pack_commands");
    assert.equal(audit.rows[0].n, 5); assert.equal(audit.rows[0].actors, 1);
    await db.exec("update public.leader_access set can_record=false where email='admin@example.test'");
    await assert.rejects(write(1, 1, create), /Recording access denied/);
    assert.equal((await read(1, "activities")).rows[0].result.total, 1);
    await db.exec("update public.leader_access set active=false where email='admin@example.test'");
    await assert.rejects(read(1, "attendance"), /Access denied/);
    await db.exec("set role anon");
    await assert.rejects(db.exec("select public.read_pack_operations('activities')"), /permission denied/);
    await db.exec("reset role");
  } finally { await db.close(); }
});

test("M2 input validation rejects impossible dates, identity injection and malformed years", () => {
  const command = { action: "record_registration", scout_id: scout, scouting_year: "2026-27", platform: "scouting.org", status: "confirmed", expected_revision: 0, occurred_on: "2026-02-28" };
  assert.equal(recordOperationSchema.safeParse({ request_id: request(1), command }).success, true);
  for (const patch of [{ occurred_on: "2026-02-30" }, { scouting_year: "2026-28" }, { recorded_by: user(2) }, { expected_revision: -1 }, { platform: "other" }]) {
    assert.equal(recordOperationSchema.safeParse({ request_id: request(1), command: { ...command, ...patch } }).success, false);
  }
});
