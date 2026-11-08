import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { recordOperationSchema } from "../supabase/functions/_shared/operations.ts";

const scout = "10000000-0000-4000-8000-000000000001";
const adventure = "40000000-0000-4000-8000-000000000001";
const uuid = (prefix: string, n: number) => `${prefix}0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const definition = {
  action: "define_adventure", adventure_id: adventure, name: "Synthetic Adventure", rank: "tiger", program_version: "synthetic-2026",
  source_url: "https://www.scouting.org/synthetic-test-only/", source_verified_on: "2026-10-20",
  requirements: [{ code: "1", description: "Synthetic required task" }, { code: "2a", description: "Synthetic option A" }, { code: "2b", description: "Synthetic option B" }],
  completion_groups: [{ minimum: 1, codes: ["1"] }, { minimum: 1, codes: ["2a", "2b"] }],
};

test("advancement preserves requirement dates, completes all on award, separates delivery and audits corrections", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth;
      create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
      create table auth.identities(user_id uuid,provider text,identity_data jsonb);
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      grant usage on schema public,auth to authenticated,anon;
      grant execute on function auth.uid() to authenticated;
    `);
    for (const file of ["20261023005332_roster_foundations.sql", "20261024000100_m2_attendance_registration.sql", "20261024000200_m2_advancement.sql"]) {
      await db.exec(await readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), "utf8"));
    }
    await db.exec(`
      insert into auth.users values('${uuid("0", 1)}','admin@example.test',now()),('${uuid("0", 2)}','reader@example.test',now()),('${uuid("0", 3)}','stranger@example.test',now());
      insert into auth.identities select id,'google',jsonb_build_object('email',email,'email_verified',true) from auth.users;
      insert into public.leader_access(email) values('reader@example.test');
      insert into public.roster_snapshots(source_sha256,source_file,source_sheet,snapshot_date,expected_rows)
        values(repeat('a',64),'synthetic.xlsx','Roster 2026-27','2026-10-21',1);
      insert into public.scouts(id,snapshot_id,snapshot_date,source_row,scout_name,source_values)
        select '${scout}',id,'2026-10-21',2,'Synthetic Scout','{}' from public.roster_snapshots;
    `);
    async function asUser<T>(n: number, run: () => Promise<T>) {
      await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${uuid("0", n)}',false)`);
      try { return await run(); } finally { await db.exec("reset role"); }
    }
    const write = async (id: number, command: object, actor = 1) => {
      const r = await asUser(actor, () => db.query<{ result: Record<string, unknown> }>("select public.record_pack_operation($1::uuid,$2::jsonb) result", [uuid("3", id), JSON.stringify(command)]));
      return r.rows[0].result;
    };
    const read = async (entity: string, actor = 2, year: string | null = null, limit = 50, offset = 0) => {
      const r = await asUser(actor, () => db.query<{ result: { total: number; rows: Record<string, unknown>[]; next_offset: number | null } }>("select public.read_pack_advancement($1,null,$2::uuid,$3,$4,$5) result", [entity, adventure, year, offset, limit]));
      return r.rows[0].result;
    };
    await assert.rejects(write(1, definition, 2), /Recording access denied/);
    await assert.rejects(write(1, definition, 3), /Recording access denied/);
    await assert.rejects(read("adventures", 3), /Access denied/);
    await assert.rejects(write(1, { ...definition, completion_groups: [{ minimum: 2, codes: ["1"] }] }), /Invalid completion minimum/);
    await assert.rejects(write(1, { ...definition, requirements: [...definition.requirements, definition.requirements[0]] }), /Duplicate requirement/);
    await assert.rejects(write(1, { ...definition, completion_groups: [{ minimum: 1, codes: ["missing"] }] }), /Unknown completion requirement/);
    const created = await write(1, definition);
    assert.deepEqual(await write(1, definition), created);
    await assert.rejects(write(1, { ...definition, name: "Changed" }), /Request ID conflict/);
    const catalog = await read("adventures");
    assert.equal(catalog.total, 1);
    assert.equal(catalog.rows[0].program_version, "synthetic-2026");
    await assert.rejects(write(2, { ...definition, adventure_id: uuid("4", 2) }), /unique constraint/);
    const key = { scout_id: scout, adventure_id: adventure, scouting_year: "2026-27" };
    const requirement = { action: "record_requirement", ...key, requirement_code: "1", status: "completed", occurred_on: "2026-10-01", expected_revision: 0 };
    await assert.rejects(write(2, { ...requirement, requirement_code: "missing" }), /Unknown requirement/);
    assert.equal((await read("advancement")).total, 0); // Failed command rolls back aggregate creation.
    assert.equal((await write(2, requirement)).revision, 1);
    await assert.rejects(write(3, { ...requirement, requirement_code: "2a" }), /Revision conflict/);
    await write(3, { ...requirement, requirement_code: "2a", occurred_on: "2026-10-03", expected_revision: 1 });
    const ready = (await read("advancement")).rows[0];
    assert.equal(ready.completion_ready, true); // One optional choice suffices.
    assert.equal(ready.earned_on, null); // Readiness never earns automatically.
    await assert.rejects(write(4, { action: "deliver_badge", ...key, expected_revision: 2, badge_form: "belt_loop", occurred_on: "2026-10-04" }), /must be earned/);
    await assert.rejects(write(4, { action: "earn_adventure", ...key, expected_revision: 2, occurred_on: "2026-10-02" }), /precedes recorded completion/);
    const earn = { action: "earn_adventure", ...key, expected_revision: 2, occurred_on: "2026-10-10" };
    assert.equal((await write(4, earn)).earned_on, "2026-10-10");
    assert.equal((await write(4, earn)).revision, 3);
    const completed = await read("requirements", 2, "2026-27", 2);
    assert.equal(completed.total, 3); assert.equal(completed.next_offset, 2);
    assert.equal(completed.rows[0].completed_on, "2026-10-01");
    assert.equal(completed.rows[0].completion_source, "individual");
    assert.equal(completed.rows[1].completed_on, "2026-10-03");
    const last = (await read("requirements", 2, "2026-27", 2, 2)).rows[0];
    assert.equal(last.requirement_code, "2b"); assert.equal(last.completed_on, "2026-10-10"); assert.equal(last.completion_source, "award");
    assert.equal((await read("advancement")).rows[0].badge_delivered_on, null);
    await assert.rejects(write(5, { ...requirement, expected_revision: 3 }), /Revoke the earned adventure/);
    await assert.rejects(write(5, { action: "deliver_badge", ...key, expected_revision: 3, badge_form: "belt_loop", occurred_on: "2026-10-09" }), /precedes earned date/);
    await write(5, { action: "deliver_badge", ...key, expected_revision: 3, badge_form: "belt_loop", occurred_on: "2026-10-12" });
    const delivered = (await read("advancement")).rows[0];
    assert.equal(delivered.earned_on, "2026-10-10"); assert.equal(delivered.badge_delivered_on, "2026-10-12"); assert.equal(delivered.badge_form, "belt_loop");
    await assert.rejects(write(6, { action: "revoke_adventure", ...key, expected_revision: 4, occurred_on: "2026-10-13", reason: "Wrong award" }), /Retract badge delivery/);
    await write(6, { action: "retract_badge_delivery", ...key, expected_revision: 4, occurred_on: "2026-10-13", reason: "Incorrect delivery record" });
    await write(7, { action: "revoke_adventure", ...key, expected_revision: 5, occurred_on: "2026-10-13", reason: "Incorrect earned record" });
    const retained = await read("requirements");
    assert.equal(retained.total, 2);
    assert.ok(retained.rows.every(r => r.completion_source === "individual"));
    assert.equal((await read("advancement")).rows[0].earned_on, null);
    await write(8, { ...requirement, status: "not_completed", expected_revision: 6, occurred_on: "2026-10-14" });
    assert.equal((await read("advancement")).rows[0].completion_ready, false);
    assert.equal((await read("requirements", 2, "2027-28")).total, 0);
    await assert.rejects(asUser(1, () => db.exec("update public.pack_adventures set name='Changed'")), /permission denied/);
    await assert.rejects(asUser(1, () => db.query("select private.record_advancement_operation($1::uuid,$2::jsonb)", [uuid("3", 99), JSON.stringify(earn)])), /permission denied/);
    const audit = await db.query<{ n: number }>("select count(*)::int n from public.pack_commands");
    assert.equal(audit.rows[0].n, 8);
    // The dispatch wrapper preserves first-slice functionality.
    await write(9, { action: "create_activity", activity_id: uuid("2", 1), title: "Synthetic meeting", kind: "session", scouting_year: "2026-27", occurred_on: "2026-10-15" });
    const defaultDate = await db.query<{ today: string }>("select to_char(now() at time zone 'America/Los_Angeles','YYYY-MM-DD') today");
    const defaultEarned = await write(10, { action: "earn_adventure", ...key, expected_revision: 7 });
    assert.equal(defaultEarned.earned_on, defaultDate.rows[0].today);
    assert.equal((await read("requirements")).total, 3);
    assert.equal((await read("requirements")).rows.find(r => r.requirement_code === "2a")?.completed_on, "2026-10-03");
    const importedCatalog = JSON.parse(await readFile(new URL("../catalog/adventures.json", import.meta.url), "utf8")) as { entries: { request_id: string; command: Record<string, unknown> }[] };
    for (const entry of importedCatalog.entries) {
      assert.equal(recordOperationSchema.safeParse(entry).success, true);
      await asUser(1, () => db.query("select public.record_pack_operation($1::uuid,$2::jsonb)", [entry.request_id, JSON.stringify(entry.command)]));
    }
    const full = await asUser(2, () => db.query<{ result: { total: number; rows: Record<string, unknown>[]; next_offset: number } }>("select public.read_pack_advancement('adventures',null,null,null,0,100) result"));
    assert.equal(full.rows[0].result.total, 149);
    assert.equal(full.rows[0].result.rows.length, 100);
    assert.equal(full.rows[0].result.next_offset, 100);
    const alternative = importedCatalog.entries.find(e => e.command.rank === "lion" && e.command.name === "Sample Alternative")!;
    const event = importedCatalog.entries.find(e => e.command.rank === "wolf" && e.command.name === "Sample Instructor Activity")!;
    for (const [index, entry] of [alternative, event].entries()) {
      await write(20 + index, { action: "record_requirement", ...key, adventure_id: entry.command.adventure_id, requirement_code: "1", status: "completed", occurred_on: "2026-10-20", expected_revision: 0 });
      const manual = await asUser(2, () => db.query<{ result: { rows: Record<string, unknown>[] } }>("select public.read_pack_advancement('advancement',null,$1::uuid) result", [entry.command.adventure_id]));
      assert.equal(manual.rows[0].result.rows[0].completion_ready, null);
    }
    const invalidAutomatic = { ...alternative.command, adventure_id: uuid("4", 99), readiness_mode: "automatic" };
    await assert.rejects(write(25, invalidAutomatic), /Catalog conditions require leader review/);
    const saved = await db.query<{ context: Record<string, unknown>; requirements: Record<string, unknown>[] }>("select catalog_context context,requirements from public.pack_adventures where id=$1::uuid", [event.command.adventure_id]);
    assert.match(String(saved.rows[0].context.notes), /inconsistency/);
    assert.equal(saved.rows[0].context.verification_basis, "user_supplied_csv");
    assert.equal(saved.rows[0].requirements[0].source_url, event.command.source_url);
    await db.exec("update public.leader_access set can_record=false where email='admin@example.test'");
    await assert.rejects(write(4, earn), /Recording access denied/);
    await db.exec("update public.leader_access set active=false where email='reader@example.test'");
    await assert.rejects(read("requirements"), /Access denied/);
    await db.exec("set role anon");
    await assert.rejects(db.exec("select public.read_pack_advancement('adventures')"), /permission denied/);
    await db.exec("reset role");
  } finally { await db.close(); }
});

test("advancement schemas require version/source, dates, revisions and correction reasons", () => {
  const request_id = uuid("3", 1);
  assert.equal(recordOperationSchema.safeParse({ request_id, command: definition }).success, true);
  for (const patch of [{ source_url: "http://example.test/" }, { source_verified_on: "2026-02-30" }, { rank: "unknown" }, { recorded_by: uuid("0", 1) }]) {
    assert.equal(recordOperationSchema.safeParse({ request_id, command: { ...definition, ...patch } }).success, false);
  }
  assert.equal(recordOperationSchema.safeParse({ request_id, command: { action: "revoke_adventure", scout_id: scout, adventure_id: adventure, scouting_year: "2026-27", expected_revision: 1, reason: "" } }).success, false);
});
