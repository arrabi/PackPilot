import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { m2Fixture, id } from './helpers/m2.ts';
import { regularMeetings, remaining } from '../auth-ui/community-model.ts';
async function fixture() { const f = await m2Fixture(); for (const file of ['20261102080000_family_participation.sql', '20261102080100_parent_notifications.sql', '20261102200000_email_preferences.sql'])
    await f.db.exec(await readFile(new URL('../supabase/migrations/' + file, import.meta.url), 'utf8')); await f.db.exec(`insert into auth.users values('${id('0', 4)}','mom@example.test',now()),('${id('0', 5)}','dad@example.test',now()),('${id('0', 6)}','other@example.test',now());insert into public.parent_scout_links(scout_id,parent_email,created_by)values('${id('1', 1)}','mom@example.test','${id('0', 1)}'),('${id('1', 1)}','dad@example.test','${id('0', 1)}'),('${id('1', 2)}','other@example.test','${id('0', 1)}');`); for (const n of [4, 5, 6])
    await f.asUser(n, () => f.db.query('select public.claim_parent_links()')); const cmd = async (n: number, c: object, actor = 1) => f.asUser(actor, () => f.db.query('select public.record_pack_community($1::uuid,$2::jsonb)', [id('8', n), JSON.stringify(c)])); const read = async (actor = 4) => (await f.asUser(actor, () => f.db.query<{
    r: any;
}>('select public.read_pack_community()r'))).rows[0].r; return { ...f, cmd, read }; }
const event = { action: 'event', id: id('7', 1), title: 'Test event', date: '2027-05-12', den: '', details: '', mode: 'attendees', capacity: 3, revision: 0 };
test('RSVP limits are transactional; parents share child reservations and cannot reserve another child', async () => { const f = await fixture(); try {
    await f.cmd(1, event);
    await f.cmd(2, { action: 'rsvp', id: event.id, scouts: [id('1', 1)], others: 2 }, 4);
    assert.equal((await f.read()).events[0].used, 3);
    await assert.rejects(f.cmd(3, { action: 'rsvp', id: event.id, scouts: [id('1', 2)], others: 0 }, 6), /places/);
    assert.equal((await f.read(6)).bookings.length, 0);
    await assert.rejects(f.cmd(4, { action: 'rsvp', id: event.id, scouts: [id('1', 2)], others: 0 }, 4), /denied/);
    await f.cmd(5, { action: 'rsvp', id: event.id, scouts: [id('1', 1)], others: 1 }, 5);
    assert.equal((await f.read()).events[0].used, 2);
    await f.cmd(6, { action: 'rsvp', id: event.id, scouts: [], others: 0 }, 4);
    assert.equal((await f.read()).events[0].used, 0);
    await assert.rejects(f.cmd(7, { ...event, id: id('7', 2) }, 4), /denied/);
    await f.db.exec('set role anon');
    await assert.rejects(f.db.query('select public.read_pack_community()'), /permission denied/);
    await f.db.exec('reset role');
}
finally {
    await f.db.close();
} });
test('Volunteer limits, retry audit, private photos and revocation', async () => { const f = await fixture(); try {
    const job = { action: 'job', id: id('7', 3), title: 'Salads', capacity: 1 };
    await f.cmd(10, job);
    await f.cmd(11, { action: 'volunteer', id: job.id, join: true, scout_id: id('1', 1) }, 4);
    await assert.rejects(f.cmd(12, { action: 'volunteer', id: job.id, join: true, scout_id: id('1', 2) }, 6), /full/);
    await f.cmd(13, { action: 'volunteer', id: job.id, join: false }, 4);
    await f.cmd(12, { action: 'volunteer', id: job.id, join: true, scout_id: id('1', 2) }, 6);
    const photo = { action: 'photo', id: id('1', 1), kind: 'scout', image: 'data:image/jpeg;base64,/9j/2Q==' };
    await f.cmd(14, photo, 4);
    await f.cmd(14, photo, 4);
    assert.equal((await f.read(6)).photos.length, 0);
    assert.equal((await f.read()).photos.length, 1);
    await assert.rejects(f.cmd(15, { ...photo, id: id('1', 2) }, 4), /denied/);
    await f.cmd(16, { ...photo, image: '' }, 4);
    assert.equal((await f.read()).photos.length, 0);
    await f.db.exec(`update public.parent_scout_links set active=false where parent_email='mom@example.test'`);
    await assert.rejects(f.read(), /denied/);
}
finally {
    await f.db.close();
} });
test('Notification trigger dedupes both parents; reminders omit completed homework and respect Pacific Saturday', async () => { const f = await fixture(); try {
    await f.db.exec(`insert into public.pack_family_messages values('${id('9', 1)}','${id('1', 1)}','2026-27','Hello','leader','Leader','${id('0', 1)}',now());`);
    assert.equal((await f.db.query('select * from private.pack_email_outbox')).rows.length, 2);
    await f.db.query("select public.prepare_parent_reminders('2026-11-07T15:59:00Z')");
    assert.equal((await f.db.query('select * from private.pack_email_outbox')).rows.length, 2);
    await f.db.query("select public.prepare_parent_reminders('2026-11-07T16:00:00Z')");
    await f.db.query("select public.prepare_parent_reminders('2026-11-07T16:05:00Z')");
    assert.equal((await f.db.query("select * from private.pack_email_outbox where dedupe_key like 'weekly:%'")).rows.length, 3);
    await assert.rejects(f.asUser(4, () => f.db.query('select public.claim_parent_emails()')), /permission denied/);
}
finally {
    await f.db.close();
} });
test('Regular meeting dates and unlimited capacity labels', () => { assert.equal(regularMeetings.length, 16); assert.equal(remaining({ capacity: null, used: 50 }), 'Unlimited places'); });
test('Meeting plans validate rank, preserve pack activities and record only present scouts through advancement', async () => { const f = await fixture(); try {
    await f.db.exec(`insert into public.pack_adventures(id,name,rank,program_version,source_url,source_verified_on,requirements,completion_groups,recorded_by)values('${id('4', 1)}','Tiger test','tiger','test','https://www.scouting.org/test/','2026-10-01','[{"code":"1","description":"Test task"}]','[]','${id('0', 1)}');`);
    const meeting = { action: 'meeting', id: id('7', 5), date: '2026-10-28', den: '1-Tigers', pack_activity: 'Pack game', agenda: 'Den activity', supplies: 'Paper', requirements: [{ adventure_id: id('4', 1), code: '1' }], revision: 0 };
    await f.cmd(30, meeting);
    await assert.rejects(f.cmd(31, meeting), /changed/);
    await assert.rejects(f.cmd(32, { ...meeting, id: id('7', 6), den: '0-Lions' }), /requirement/);
    await f.write(30, { action: 'create_activity', activity_id: id('6', 1), title: 'Meeting', kind: 'session', occurred_on: '2026-10-28', scouting_year: '2026-27' });
    await f.write(31, { action: 'record_attendance', activity_id: id('6', 1), scout_id: id('1', 1), status: 'present', expected_revision: 0, occurred_on: '2026-10-28' });
    const finish = { action: 'finish_meeting', id: meeting.id, activity_id: id('6', 1), year: '2026-27',revision:1 };
    await f.cmd(33, finish);
    await f.cmd(33, finish);
    assert.equal((await f.db.query('select * from public.pack_requirement_progress')).rows.length, 1);
    assert.equal((await f.db.query<{
        earned_on: string | null;
    }>('select earned_on from public.pack_advancement')).rows[0].earned_on, null);
}
finally {
    await f.db.close();
} });
test('Empty weekly follow-ups do not queue mail; unread state is individual to each parent', async () => { const f = await fixture(); try {
    await f.db.exec(`insert into public.pack_registrations(scout_id,scouting_year,platform,status,occurred_on,revision,recorded_by)select id,'2026-27',p,'confirmed','2026-11-01',1,'${id('0', 1)}'from public.scouts cross join unnest(array['active.com','scouting.org'])p;`);
    await f.db.query("select public.prepare_parent_reminders('2026-11-07T16:00:00Z')");
    assert.equal((await f.db.query('select * from private.pack_email_outbox')).rows.length, 0);
    await f.db.exec(`insert into public.pack_family_messages values('${id('9', 2)}','${id('1', 1)}','2026-27','Hello','leader','Leader','${id('0', 1)}',now());insert into public.pack_family_message_reads(user_id,message_id)values('${id('0', 4)}','${id('9', 2)}');`);
    await f.db.query("select public.prepare_parent_reminders('2026-11-14T16:00:00Z')");
    const rows = (await f.db.query<{
        recipient: string;
    }>("select recipient from private.pack_email_outbox where dedupe_key like 'weekly:%'")).rows;
    assert.deepEqual(rows.map(r => r.recipient), ['dad@example.test']);
}
finally {
    await f.db.close();
} });
test('Adventure earning and badge handout enqueue separate congratulations for both parents', async () => { const f = await fixture(); try {
    await f.db.exec(`insert into public.pack_adventures(id,name,rank,program_version,source_url,source_verified_on,requirements,completion_groups,recorded_by)values('${id('4', 1)}','Test','tiger','test','https://www.scouting.org/test/','2026-10-01','[{"code":"1","description":"Test task"}]','[]','${id('0', 1)}');insert into public.pack_advancement(scout_id,adventure_id,scouting_year,revision,earned_on,recorded_by)values('${id('1', 1)}','${id('4', 1)}','2026-27',1,'2026-11-01','${id('0', 1)}');update public.pack_advancement set revision=2,badge_delivered_on='2026-11-01',badge_form='belt_loop';`);
    assert.equal((await f.db.query('select * from private.pack_email_outbox')).rows.length, 4);
}
finally {
    await f.db.close();
} });
test('Admin address opt-out covers pending, claimed, new and weekly messages; retries are audited and parents/readers cannot change it', async () => {
 const f=await fixture();
 const pref=(n:number,email:string,suppressed:boolean,actor=1)=>f.asUser(actor,()=>f.db.query('select public.set_pack_email_preference($1,$2,$3)',[id('6',n),email,suppressed]));
 try {
  await assert.rejects(pref(1,'mom@example.test',true,4),/administrator/);
  await assert.rejects(pref(1,'mom@example.test',true,2),/administrator/);
  await f.db.exec(`insert into public.pack_family_messages values('${id('9',80)}','${id('1',1)}','2026-27','Hello','leader','Leader','${id('0',1)}',now())`);
  const claimed=(await f.db.query<{r:any[]}>('select public.claim_parent_emails()r')).rows[0].r;
  assert.equal(claimed.length,2);
  await pref(1,' MOM@EXAMPLE.TEST ',true);
  await pref(1,'mom@example.test',true);
  assert.equal((await f.db.query('select * from private.pack_email_preference_changes')).rows.length,1);
  await assert.rejects(pref(1,'dad@example.test',true),/already used/);
  const mom=claimed.find(m=>m.recipient==='mom@example.test');
  assert.equal((await f.db.query<{r:boolean}>('select public.can_send_parent_email($1)r',[mom.id])).rows[0].r,false);
  const dad=claimed.find(m=>m.recipient==='dad@example.test');
  assert.equal((await f.db.query<{r:boolean}>('select public.can_send_parent_email($1)r',[dad.id])).rows[0].r,true);
  await f.db.exec(`insert into public.pack_family_messages values('${id('9',81)}','${id('1',1)}','2026-27','Second','leader','Leader','${id('0',1)}',now())`);
  await f.db.query("select public.prepare_parent_reminders('2026-11-07T16:00:00Z')");
  assert.equal((await f.db.query("select * from private.pack_email_outbox where recipient='mom@example.test'and status<>'cancelled'")).rows.length,0);
  assert.ok((await f.db.query("select * from private.pack_email_outbox where recipient='dad@example.test'and status<>'cancelled'")).rows.length>0);
  const visible=(await f.asUser(4,()=>f.db.query<{r:any}>('select public.read_pack_email_preferences()r'))).rows[0].r;
  assert.deepEqual(visible,{is_admin:false,addresses:[]});
  await pref(2,'mom@example.test',false);
  await f.db.exec(`insert into public.pack_family_messages values('${id('9',82)}','${id('1',1)}','2026-27','Third','leader','Leader','${id('0',1)}',now())`);
  assert.equal((await f.db.query("select * from private.pack_email_outbox where recipient='mom@example.test'and status='pending'")).rows.length,1);
  assert.equal((await f.db.query('select * from private.pack_email_preference_changes')).rows.length,2);
  await assert.rejects(f.asUser(4,()=>f.db.query('select public.can_send_parent_email($1)',[dad.id])),/permission denied/);
 }finally{await f.db.close();}
});
test('Participation and email admin controls respect the live policy acceptance gate and health removal', async()=>{
 const f=await fixture();
 try{
  for(const file of ['20261102190000_remove_health_information.sql','20261102190100_site_policy_acceptance.sql'])await f.db.exec(await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
  await assert.rejects(f.read(1),/denied/);
  await assert.rejects(f.read(4),/denied/);
  await assert.rejects(f.asUser(1,()=>f.db.query('select public.set_pack_email_preference($1,$2,true)',[id('6',90),'mom@example.test'])),/administrator/);
  for(const actor of [1,4])await f.asUser(actor,async()=>{
   const status=(await f.db.query<{r:any}>('select public.get_site_policy_status()r')).rows[0].r;
   await f.db.query('select public.accept_site_policies($1,$2,$3)',[status.version,status.terms_hash,status.privacy_hash]);
  });
  assert.equal((await f.read(1)).scouts.length,2);
  assert.equal((await f.read(4)).scouts.length,1);
  await assert.rejects(f.read(5),/denied/);
  await f.cmd(90,event);
  await f.cmd(91,{action:'rsvp',id:event.id,scouts:[id('1',1)],others:1},4);
  const fields=(await f.db.query<{r:any}>('select to_jsonb(s)r from public.scouts s')).rows;
  assert.ok(fields.every(s=>!('allergy'in s.r)&&!('medication'in s.r)));
 }finally{await f.db.close();}
});
