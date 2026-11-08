import { test } from "node:test";
import assert from "node:assert/strict";
import { m2Fixture, id } from "./helpers/m2.ts";

test("Gmail normalization follows personal-domain rules without guessing other domains", async () => {
  const { db } = await m2Fixture();
  try {
    for (const address of ["fixtureleader@gmail.com", "fixture.leader@gmail.com", " F.Ixture.Leader+extra@GMAIL.COM ", "fixture.leader+extra@googlemail.com"])
      assert.equal((await db.query<{ email: string }>("select private.canonical_leader_email($1) email", [address])).rows[0].email, "fixtureleader@gmail.com");
    for (const address of ["fixture.leader@gmai.com", "fixture.leader+extra@packpilot.example", "fixture.leader+extra@outlook.com", "fixture.leader@gmail.com.evil.test", "fixture.leader@sub.gmail.com", "fixture.leader+extra@@gmail.com", "fixture..leader@gmail.com", ".fixtureleader@gmail.com"])
      assert.equal((await db.query<{ email: string }>("select private.canonical_leader_email($1) email", [address])).rows[0].email, address);
    assert.equal((await db.query<{ email: null }>("select private.canonical_leader_email(null) email")).rows[0].email, null);
  } finally { await db.close(); }
});

test("aliases retain verified Google identity, approval, recording and revocation gates", async () => {
  const { db, asUser, write } = await m2Fixture();
  try {
    // The administrator may approve an alias; Google may return the base address.
    await db.exec(`
      insert into public.leader_access(email,can_record) values ('synthetic.leader+pack@googlemail.com',false);
      insert into auth.users values ('${id("0", 4)}','syntheticleader@gmail.com',now());
      insert into auth.identities values ('${id("0", 4)}','google','{"email":"synthetic.leader+google@gmail.com","email_verified":true}');
    `);
    const capabilities = async () => (await asUser(4, () => db.query<{ result: { approved: boolean; can_record: boolean } }>("select get_pack_capabilities() result"))).rows[0].result;
    const command = { action: "create_activity", activity_id: id("2", 99), title: "Synthetic alias check", kind: "session", occurred_on: "2026-10-01", scouting_year: "2026-27" };
    assert.deepEqual(await capabilities(), { approved: true, can_record: false, default_den: null });
    assert.equal((await asUser(4, () => db.query("select * from public.scouts"))).rows.length, 2);
    await assert.rejects(write(99, command, 4), /Recording access denied/);
    await db.exec("update public.leader_access set can_record=true where email='synthetic.leader+pack@googlemail.com'");
    assert.deepEqual(await capabilities(), { approved: true, can_record: true, default_den: null });
    await write(99, command, 4);

    for (const update of [
      `update auth.identities set identity_data='{"email":"other@gmail.com","email_verified":true}' where user_id='${id("0", 4)}'`,
      `update auth.identities set identity_data='{"email":"syntheticleader@gmail.com","email_verified":false}' where user_id='${id("0", 4)}'`,
      `update auth.identities set provider='email',identity_data='{"email":"syntheticleader@gmail.com","email_verified":true}' where user_id='${id("0", 4)}'`,
    ]) {
      await db.exec(update);
      assert.deepEqual(await capabilities(), { approved: false, can_record: false, default_den: null });
      await assert.rejects(asUser(4, () => db.query("select read_roster_snapshot()")), /denied/);
    }
    await db.exec(`update auth.identities set provider='google' where user_id='${id("0", 4)}'; update auth.users set email_confirmed_at=null where id='${id("0", 4)}'`);
    assert.deepEqual(await capabilities(), { approved: false, can_record: false, default_den: null });
    await db.exec(`update auth.users set email_confirmed_at=now(),email='synthetic.leader@gmai.com' where id='${id("0", 4)}'`);
    assert.deepEqual(await capabilities(), { approved: false, can_record: false, default_den: null });
    await db.exec(`update auth.users set email='syntheticleader@gmail.com' where id='${id("0", 4)}'; update public.leader_access set active=false where email='synthetic.leader+pack@googlemail.com'`);
    assert.deepEqual(await capabilities(), { approved: false, can_record: false, default_den: null });
    await assert.rejects(write(100, command, 4), /Recording access denied/);
  } finally { await db.close(); }
});

test("one Gmail mailbox cannot accumulate conflicting approval or recording rows", async () => {
  const { db } = await m2Fixture();
  try {
    await db.exec("insert into public.leader_access(email) values ('synthetic.leader@gmail.com')");
    for (const address of ["syntheticleader@gmail.com", "synthetic.leader+extra@gmail.com", "syntheticleader@googlemail.com"])
      await assert.rejects(db.query("insert into public.leader_access(email,can_record) values ($1,true)", [address]), /unique constraint/);
    await db.exec("update public.leader_access set active=false where email='synthetic.leader@gmail.com'");
    await assert.rejects(db.query("insert into public.leader_access(email) values ('syntheticleader+new@gmail.com')"), /unique constraint/);
    await db.exec("insert into public.leader_access(email) values ('synthetic.leader@packpilot.example'),('syntheticleader@packpilot.example'),('synthetic.leader+extra@packpilot.example')");
  } finally { await db.close(); }
});
