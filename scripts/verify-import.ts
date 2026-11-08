import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";

// Private in-memory PostgreSQL verification: no remote connection, no record output.
const db = new PGlite();
try {
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth;
    create table auth.users(id uuid primary key, email text, email_confirmed_at timestamptz);
    create table auth.identities(user_id uuid, provider text, identity_data jsonb);
    create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;`);
  await db.exec(await readFile("supabase/migrations/20261023005332_roster_foundations.sql", "utf8"));
  const sql = await readFile(".local/import-roster.sql", "utf8");
  const report = JSON.parse(await readFile(".local/import-report.json", "utf8"));
  await db.exec(sql);
  await db.exec(sql);
  const count = await db.query<{ n: number }>("select count(*)::int as n from scouts");
  assert.equal(count.rows[0].n, report.records);
  for (const [field, expected] of Object.entries(report.missing_by_field)) {
    // Identifiers come only from the script's fixed reviewed column mapping.
    assert.match(field, /^[a-z_0-9]+$/);
    const result = await db.query<{ n: number }>(`select count(*)::int as n from scouts where ${field} is null`);
    assert.equal(result.rows[0].n, expected, `Missing-value reconciliation: ${field}`);
  }
  assert.equal((await db.query<{ n: number }>("select count(*)::int as n from roster_snapshots")).rows[0].n, 1);
  console.log(`Local PostgreSQL import verified: ${report.records} records, all field null counts reconciled, repeat import created no duplicates. No upload performed.`);
} catch {
  // PGlite exceptions can include the full SQL payload; never print them.
  console.error("Private import verification failed. Review mappings locally; record data has been withheld.");
  process.exitCode = 1;
} finally { await db.close(); }
