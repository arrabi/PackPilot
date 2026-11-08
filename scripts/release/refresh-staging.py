"""On-request replacement of staging application data; never copies production Auth.

Requires a recent real isolation receipt for unchanged deployed functions/secrets.
No jobs or outbound delivery are enabled by this command. Failure leaves the
staging write barrier closed. Production is accessed read-only.
"""
import argparse
from datetime import datetime, timezone, timedelta
import json
import os
from pathlib import Path
import uuid
from access import PRODUCTION_PROJECT
from platform_api import supabase, project_ref, private_json
from retention import parse_time

PUBLIC = set('leader_access roster_snapshots scouts pack_activities pack_advancement pack_adventures pack_attendance pack_commands pack_community_commands pack_den_plans pack_equipment_events pack_equipment_state pack_event_bookings pack_event_responses pack_events pack_family_commands pack_family_message_reads pack_family_messages pack_family_photos pack_home_assignments pack_inventory_events pack_inventory_items pack_leader_notes pack_meeting_plans pack_registration_reports pack_registrations pack_requirement_progress pack_shirt_import_history pack_volunteer_jobs pack_volunteer_signups pack_volunteer_waitlist pack_volunteers parent_scout_links'.split())
PRIVATE = {'pack_change_log', 'pack_retention', 'pack_scoutbook_mappings', 'pack_scoutbook_names', 'pack_year_ends', 'site_policy_versions'}
PRESERVE = {'parent_portal_settings', 'pack_notification_settings'}


def remap(value, mapping):
    if isinstance(value, uuid.UUID):
        return mapping.get(str(value), value)
    if isinstance(value, str):
        return str(mapping.get(value, value))
    if isinstance(value, list):
        return [remap(x, mapping) for x in value]
    if isinstance(value, dict):
        return {key: remap(item, mapping) for key, item in value.items()}
    return value


def receipt_valid(receipt, ref, functions, secrets):
    age = datetime.now(timezone.utc) - parse_time(receipt['verified_at'])
    return (receipt.get('project') == ref and timedelta(0) <= age <= timedelta(hours=24)
        and receipt.get('checks') == {'auth_allowed': True, 'auth_blocked': True,
            'notification_allowed': True, 'notification_blocked': True, 'retry_blocked': True}
        and receipt.get('functions') == functions and receipt.get('secrets') == secrets)


def refresh():
    import psycopg
    from psycopg import sql
    from psycopg.types.json import Jsonb
    from maintenance import connection_target
    config = json.loads((Path(__file__).resolve().parents[2] / 'config/release-system.json').read_text())
    ref = project_ref(config['staging_project'], staging=True)
    receipt_path = Path(os.environ['STAGING_ISOLATION_RECEIPT'])
    receipt = json.loads(receipt_path.read_text())
    base = '/v1/projects/' + ref
    functions = sorted([{'slug': f['slug'], 'version': f['version']} for f in supabase(base + '/functions')], key=lambda f: f['slug'])
    secrets = sorted([{'name': f['name'], 'digest': f['value']} for f in supabase(base + '/secrets')], key=lambda f: f['name'])
    if not receipt_valid(receipt, ref, functions, secrets):
        raise RuntimeError('Fresh real staging email-isolation receipt required for current functions and secrets')
    source_target = connection_target(os.environ['PRODUCTION_DATABASE_URL'], PRODUCTION_PROJECT)
    dest_target = connection_target(os.environ['STAGING_DATABASE_URL'], ref)
    # Close Auth during destructive refresh. Do not reopen implicitly afterward.
    supabase(base + '/config/auth', method='PATCH', data={'disable_signup': True, 'external_email_enabled': False})
    with psycopg.connect(**dest_target) as dest:
        dest.execute('select private.set_release_maintenance(true)')
        dest.commit()
        if dest.execute("select to_regclass('cron.job')").fetchone()[0]:
            for (job,) in dest.execute('select jobid from cron.job').fetchall():
                dest.execute('select cron.unschedule(%s)', (job,))
        dest.commit()
        with psycopg.connect(**source_target) as source:
            source.execute('begin isolation level repeatable read read only')
            if source.execute('select count(*) from storage.objects').fetchone()[0]:
                raise RuntimeError('This refresh requires reviewed uploaded-file remapping before copying nonempty Storage')
            # Schema evolution must be reviewed for data-copy treatment explicitly.
            source_tables = source.execute("select tablename from pg_tables where schemaname='public'").fetchall()
            if {t[0] for t in source_tables} != PUBLIC:
                raise RuntimeError('Public schema changed; review refresh table policy first')
            actors = [str(row[0]) for row in source.execute('select id from auth.users')]
            mapping = {actor: uuid.uuid5(uuid.NAMESPACE_URL, 'packpilot-staging:' + ref + ':' + actor) for actor in actors}
            # Never copy credentials, identities, providers, sessions or OAuth clients.
            source_data = {}
            for schema, names in [('public', PUBLIC - {'leader_access'}), ('private', PRIVATE)]:
                for table in sorted(names):
                    cursor = source.execute(sql.SQL('select * from {}.{}').format(sql.Identifier(schema), sql.Identifier(table)))
                    columns = [c.name for c in cursor.description]
                    source_data[(schema, table)] = [dict(zip(columns, row)) for row in cursor.fetchall()]
            source.rollback()
        stage_defaults = {table: dest.execute(sql.SQL('select to_jsonb(t) from private.{} t').format(sql.Identifier(table))).fetchall() for table in PRESERVE}
        dest.commit()
        # One atomic replacement. Trigger bypass is restricted to the direct admin
        # transaction; foreign keys are explicitly checked before committing.
        dest.execute("set local session_replication_role='replica'")
        stage_tables = dest.execute("select schemaname,tablename from pg_tables where schemaname in ('public','private') and tablename<>'pack_release_maintenance'").fetchall()
        dest.execute(sql.SQL('truncate {} restart identity cascade').format(sql.SQL(',').join(sql.SQL('{}.{}').format(sql.Identifier(s), sql.Identifier(t)) for s, t in stage_tables)))
        # Wipe staging's own Auth state. These are local staging edits being replaced.
        dest.execute('truncate auth.users cascade')
        for actor in mapping.values():
            dest.execute("insert into auth.users(id,instance_id,email,role,aud,banned_until,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) values(%s,'00000000-0000-0000-0000-000000000000',%s,'authenticated','authenticated','infinity','{}','{}',now(),now())", (actor, 'actor-' + actor.hex + '@staging.invalid'))
        counts = {}
        for (schema, table), records in source_data.items():
            columns = dest.execute("select column_name,data_type from information_schema.columns where table_schema=%s and table_name=%s and is_generated='NEVER' order by ordinal_position", (schema, table)).fetchall()
            names = [c[0] for c in columns]
            insert = sql.SQL('insert into {}.{} ({}) overriding system value values ({})').format(sql.Identifier(schema), sql.Identifier(table), sql.SQL(',').join(map(sql.Identifier, names)), sql.SQL(',').join(sql.Placeholder() for _ in names))
            for record in records:
                record = remap(record, mapping)
                if table == 'parent_scout_links':
                    record.update(active=False, claimed_user_id=None, claimed_at=None)
                values = [Jsonb(record[name]) if dtype in ('json', 'jsonb') else record[name] for name, dtype in columns]
                dest.execute(insert, values)
            counts[schema + '.' + table] = len(records)
        dest.execute("insert into public.leader_access(email,role,active) values('admin@example.test','admin',true)")
        for table, records in stage_defaults.items():
            for (record,) in records:
                if table == 'pack_notification_settings':
                    record['endpoint'] = 'https://' + ref + '.supabase.co/functions/v1/parent-notifications'
                dest.execute(sql.SQL('insert into private.{} select * from jsonb_populate_record(null::private.{},%s)').format(sql.Identifier(table), sql.Identifier(table)), (Jsonb(record),))
        # Keep real parent addresses intact and inactive. Add one separate test link.
        scout = dest.execute('select id from public.scouts order by id limit 1').fetchone()
        actor = next(iter(mapping.values()), None)
        if scout and actor:
            dest.execute("insert into public.parent_scout_links(scout_id,parent_email,created_by,source_context) values(%s,'staging@example.test',%s,'{\"staging_test\":true}') on conflict(scout_id,email_canonical)do update set active=true,claimed_user_id=null,claimed_at=null", (scout[0], actor))
        # Validate every FK after the trigger-suppressed import, including actor mappings.
        constraints = dest.execute("""select n.nspname,c.relname,n2.nspname,c2.relname,
          array(select attname from pg_attribute where attrelid=c.oid and attnum=any(k.conkey) order by array_position(k.conkey,attnum)),
          array(select attname from pg_attribute where attrelid=c2.oid and attnum=any(k.confkey) order by array_position(k.confkey,attnum))
          from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace
          join pg_class c2 on c2.oid=k.confrelid join pg_namespace n2 on n2.oid=c2.relnamespace
          where k.contype='f' and n.nspname in ('public','private')""").fetchall()
        for schema, table, other_schema, other_table, left, right in constraints:
            nonnull = sql.SQL(' and ').join(sql.SQL('a.{} is not null').format(sql.Identifier(c)) for c in left)
            match = sql.SQL(' and ').join(sql.SQL('a.{}=b.{}').format(sql.Identifier(a), sql.Identifier(b)) for a, b in zip(left, right))
            invalid = dest.execute(sql.SQL('select exists(select 1 from {}.{} a where {} and not exists(select 1 from {}.{} b where {}))').format(sql.Identifier(schema), sql.Identifier(table), nonnull, sql.Identifier(other_schema), sql.Identifier(other_table), match)).fetchone()[0]
            if invalid:
                raise RuntimeError('Refresh actor/relationship integrity failed')
        if dest.execute("select count(*) from auth.identities").fetchone()[0] or dest.execute('select count(*) from auth.sessions').fetchone()[0] or dest.execute('select count(*) from private.pack_email_outbox').fetchone()[0]:
            raise RuntimeError('Refresh copied forbidden authentication or delivery state')
        if dest.execute("select count(*) from public.parent_scout_links where active and parent_email<>'staging@example.test'").fetchone()[0]:
            raise RuntimeError('Unexpected active staging parent access')
        # Reset identity sequences after explicit-key imports.
        for schema, table in stage_tables:
            for column, sequence in dest.execute("select column_name,pg_get_serial_sequence(format('%I.%I',table_schema,table_name),column_name) from information_schema.columns where table_schema=%s and table_name=%s", (schema, table)).fetchall():
                if sequence:
                    maximum = dest.execute(sql.SQL('select max({}) from {}.{}').format(sql.Identifier(column), sql.Identifier(schema), sql.Identifier(table))).fetchone()[0]
                    dest.execute('select setval(%s,%s,%s)', (sequence, maximum or 1, maximum is not None))
        dest.commit()
    evidence = {'project': ref, 'refreshed_at': datetime.now(timezone.utc).isoformat(), 'table_counts': counts,
                'authentication': 'disabled synthetic actors; no credentials or sessions', 'jobs_enabled': False, 'maintenance': True}
    private_json(Path('.local/release/refresh-result.json'), evidence)
    print('Staging data replaced and verified; maintenance/Auth/jobs remain closed pending post-refresh checks')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--replace-staging-data', action='store_true', required=True)
    parser.add_argument('--management-api', action='store_true', help='Use guarded HTTPS transactions when database TCP is unavailable')
    args = parser.parse_args()
    try:
        if args.management_api:
            from staging_refresh_api import refresh as api_refresh
            api_refresh(PUBLIC, PRIVATE, PRESERVE, remap, receipt_valid)
        else:
            refresh()
    except Exception:
        raise SystemExit('Staging refresh incomplete; keep staging closed; production was read-only')
