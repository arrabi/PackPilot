import { test } from "node:test";
import assert from "node:assert/strict";
import { m2Fixture, id } from "./helpers/m2.ts";

test("default den is an optional caller-only preference without new grants", async () => {
  const { db, asUser } = await m2Fixture();
  try {
    const caps = async (actor: number) => (await asUser(actor, () => db.query<{ result: { approved: boolean; can_record: boolean; default_den: string | null } }>("select get_pack_capabilities() result"))).rows[0].result;
    assert.equal((await caps(1)).default_den, null);
    assert.equal((await caps(2)).default_den, null);
    await db.exec("update public.leader_access set default_den='Lion' where email='admin@example.test'; update public.leader_access set default_den=' Tiger ' where email='reader@example.test'");
    assert.deepEqual(await caps(2), { approved: true, can_record: false, default_den: "Tiger" });
    assert.equal((await caps(1)).default_den, "Lion");
    // Default den never scopes the roster or exposes another leader's setting.
    assert.equal((await asUser(2, () => db.query("select * from public.scouts"))).rows.length, 2);
    await assert.rejects(asUser(2, () => db.query("select default_den from public.leader_access")), /permission denied/);
    await assert.rejects(asUser(2, () => db.query("update public.leader_access set default_den='AOL'")), /permission denied/);
    await db.exec(`update auth.users set email='ADMIN@EXAMPLE.TEST' where id='${id("0", 1)}'`);
    assert.equal((await caps(1)).default_den, "Lion");
    await db.exec("update public.leader_access set active=false where email='admin@example.test'");
    assert.deepEqual(await caps(1), { approved: false, can_record: false, default_den: null });
    await db.exec("update public.leader_access set default_den='  ' where email='reader@example.test'");
    assert.equal((await caps(2)).default_den, null);
    assert.deepEqual(await caps(3), { approved: false, can_record: false, default_den: null });
  } finally { await db.close(); }
});
