"""HTTPS transport for the reviewed staging refresh policy.

Source data comes from one read-only PostgreSQL snapshot. Destination replacement
and integrity checks share one transaction; no private rows or SQL enter logs.
This bounded transport is for small datasets and rejects large payloads before
replacement. It does not export credentials, sessions, identities or delivery state.
"""
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import uuid

from access import PRODUCTION_PROJECT
from platform_api import private_json, project_ref, query, supabase

ROOT = Path(__file__).resolve().parents[2]
MAX_BYTES = 12 * 1024 * 1024


def ident(value):
    return '"' + value.replace('"', '""') + '"'


def literal(value):
    # E literals explicitly escape both backslashes and quotes, regardless of
    # the API connection's standard_conforming_strings setting.
    return "E'" + value.replace('\\', '\\\\').replace("'", "''") + "'"


def source_sql(public, private):
    pairs = []
    for schema, names in [('public', public - {'leader_access'}), ('private', private)]:
        for name in sorted(names):
            relation = ident(schema) + '.' + ident(name)
            projection = ('to_jsonb(t) - array(select column_name::text from information_schema.columns '
                'where table_schema=' + literal(schema) + ' and table_name=' + literal(name) + " and is_generated<>'NEVER')")
            pairs.extend([literal(schema + '.' + name),
                '(select coalesce(jsonb_agg(' + projection + '),\'[]\'::jsonb) from ' + relation + ' t)'])
    return ("begin transaction isolation level repeatable read read only;select jsonb_build_object("
        "'project'," + literal(PRODUCTION_PROJECT) + ","
        "'postgres_major',current_setting('server_version_num')::int/10000,"
        "'storage_objects',(select count(*) from storage.objects),"
        "'public_tables',(select jsonb_agg(tablename order by tablename) from pg_tables where schemaname='public'),"
        "'actors',(select coalesce(jsonb_agg(id),'[]'::jsonb) from auth.users),"
        "'tables',jsonb_build_object(" + ','.join(pairs) + ")) as snapshot;rollback;")


def checked_snapshot(snapshot, public, private, ref, remap):
    expected = {'public.' + name for name in public - {'leader_access'}} | {'private.' + name for name in private}
    if (snapshot.get('project') != PRODUCTION_PROJECT or snapshot.get('postgres_major') != 17 or snapshot.get('storage_objects') != 0
            or set(snapshot.get('public_tables', [])) != public or set(snapshot.get('tables', {})) != expected):
        raise RuntimeError('Source schema/Storage changed; review the refresh policy')
    if len(json.dumps(snapshot).encode()) > MAX_BYTES:
        raise RuntimeError('HTTPS refresh snapshot exceeds its reviewed size bound')
    mapping = {str(uuid.UUID(actor)): str(uuid.uuid5(uuid.NAMESPACE_URL, 'packpilot-staging:' + ref + ':' + actor))
               for actor in snapshot['actors']}
    tables = remap(snapshot['tables'], mapping)
    for row in tables['public.parent_scout_links']:
        row.update(active=False, claimed_user_id=None, claimed_at=None)
    return tables, mapping


def replacement_sql(tables, mapping, defaults, columns, ref):
    """Build one rollback-safe destination transaction; identifiers are catalog-derived."""
    relation = lambda name: '.'.join(ident(part) for part in name.split('.'))
    statements = ["begin;select pg_advisory_xact_lock(990050900);set local session_replication_role='replica';",
        "do $$begin if current_setting('server_version_num')::int/10000<>17 or "
        "not(select enabled from private.pack_release_maintenance where singleton) then "
        "raise exception 'Closed PostgreSQL 17 staging required';end if;end$$;",
        'truncate ' + ','.join(relation(name) for name in sorted(columns)) + ' restart identity cascade;',
        'truncate auth.users cascade;']
    actors = [{'id': value, 'instance_id': '00000000-0000-0000-0000-000000000000',
        'email': 'actor-' + uuid.UUID(value).hex + '@staging.invalid', 'role': 'authenticated',
        'aud': 'authenticated', 'banned_until': 'infinity', 'raw_app_meta_data': {}, 'raw_user_meta_data': {}}
        for value in mapping.values()]
    if actors:
        statements.append('insert into auth.users(id,instance_id,email,role,aud,banned_until,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) '
            'select id,instance_id,email,role,aud,banned_until,raw_app_meta_data,raw_user_meta_data,now(),now() '
            'from jsonb_populate_recordset(null::auth.users,' + literal(json.dumps(actors)) + '::jsonb);')
    for name, records in sorted(tables.items()):
        if name not in columns:
            raise RuntimeError('Destination schema does not match the reviewed refresh policy')
        names = columns[name]
        if any(set(row) != set(names) for row in records):
            raise RuntimeError('Source/destination columns differ; review schema compatibility')
        if records:
            selected = ','.join(ident(n) for n in names)
            statements.append('insert into ' + relation(name) + '(' + selected + ') overriding system value select ' + selected
                + ' from jsonb_populate_recordset(null::' + relation(name) + ',' + literal(json.dumps(records)) + '::jsonb);')
    statements.append("insert into public.leader_access(email,role,active,can_record) values('admin@example.test','admin',true,true);")
    for name, records in defaults.items():
        name = 'private.' + name
        for row in records:
            if name == 'private.pack_notification_settings':
                row['endpoint'] = 'https://' + ref + '.supabase.co/functions/v1/parent-notifications'
        if records:
            statements.append('insert into ' + relation(name) + ' select * from jsonb_populate_recordset(null::'
                + relation(name) + ',' + literal(json.dumps(records)) + '::jsonb);')
    statements.append("""insert into public.parent_scout_links(scout_id,parent_email,created_by,source_context)
      select s.id,'staging@example.test',u.id,'{"staging_test":true}'::jsonb
      from(select id from public.scouts order by id limit 1)s
      cross join(select id from auth.users order by id limit 1)u
      on conflict(scout_id,email_canonical)do update set active=true,claimed_user_id=null,claimed_at=null;
      do $$declare k record;bad boolean;seq text;mx bigint;begin
        for k in select n.nspname,c.relname,n2.nspname other_schema,c2.relname other_table,
          (select string_agg(format('a.%I is not null',a.attname),' and ' order by x.ord)
           from unnest(f.conkey)with ordinality x(attnum,ord)join pg_attribute a on a.attrelid=c.oid and a.attnum=x.attnum) nonnull,
          (select string_agg(format('a.%I=b.%I',a.attname,b.attname),' and ' order by x.ord)
           from unnest(f.conkey,f.confkey)with ordinality x(leftkey,rightkey,ord)
           join pg_attribute a on a.attrelid=c.oid and a.attnum=x.leftkey
           join pg_attribute b on b.attrelid=c2.oid and b.attnum=x.rightkey) matching
          from pg_constraint f join pg_class c on c.oid=f.conrelid join pg_namespace n on n.oid=c.relnamespace
          join pg_class c2 on c2.oid=f.confrelid join pg_namespace n2 on n2.oid=c2.relnamespace
          where f.contype='f' and n.nspname in('public','private') loop
            execute format('select exists(select 1 from %I.%I a where %s and not exists(select 1 from %I.%I b where %s))',
              k.nspname,k.relname,k.nonnull,k.other_schema,k.other_table,k.matching) into bad;
            if bad then raise exception 'Refresh relationship integrity failed';end if;
        end loop;
        if exists(select 1 from auth.identities)or exists(select 1 from auth.sessions)
          or exists(select 1 from auth.refresh_tokens)or exists(select 1 from private.pack_email_outbox)
          or exists(select 1 from cron.job)
          or exists(select 1 from auth.users where banned_until is distinct from 'infinity'::timestamptz)
          or exists(select 1 from public.parent_scout_links where active and parent_email<>'staging@example.test') then
          raise exception 'Refresh copied forbidden authentication/delivery state';end if;
        for k in select table_schema,table_name,column_name from information_schema.columns
          where table_schema in('public','private')loop
          seq:=pg_get_serial_sequence(format('%I.%I',k.table_schema,k.table_name),k.column_name);
          if seq is not null then
            execute format('select max(%I) from %I.%I',k.column_name,k.table_schema,k.table_name)into mx;
            perform setval(seq::regclass,coalesce(mx,1),mx is not null);
          end if;
        end loop;
      end$$;""")
    for name, records in sorted(tables.items()):
        # One additional allowlisted parent link may have been added.
        comparison = 'not between ' + str(len(records)) + ' and ' + str(len(records) + 1) if name == 'public.parent_scout_links' else '<>' + str(len(records))
        statements.append('do $$begin if(select count(*)from ' + relation(name) + ')' + comparison
            + " then raise exception 'Refresh row count mismatch';end if;end$$;")
    statements.append('commit;')
    sql = '\n'.join(statements)
    if len(sql.encode()) > MAX_BYTES:
        raise RuntimeError('HTTPS refresh transaction exceeds its reviewed size bound')
    return sql


def refresh(public, private, preserve, remap, receipt_valid):
    config = json.loads((ROOT / 'config/release-system.json').read_text())
    ref = project_ref(config['staging_project'], staging=True)
    if ref != 'bbbbbbbbbbbbbbbbbbbb':
        raise RuntimeError('Unexpected HTTPS staging refresh destination')
    base = '/v1/projects/' + ref
    receipt = json.loads(Path(os.environ['STAGING_ISOLATION_RECEIPT']).read_text())
    functions = sorted([{'slug':f['slug'],'version':f['version']}for f in supabase(base+'/functions')],key=lambda f:f['slug'])
    secrets = sorted([{'name':f['name'],'digest':f['value']}for f in supabase(base+'/secrets')],key=lambda f:f['name'])
    if not receipt_valid(receipt,ref,functions,secrets):
        raise RuntimeError('Fresh isolation receipt required for the current staging deployment')
    import hashlib
    digests={s['name']:s['digest']for s in secrets}
    for name,value in {'PACK99_DELIVERY_PAUSED':'true','PACK99_ENVIRONMENT':'staging','PACK99_EMAIL_ALLOWLIST':'staging@example.test'}.items():
        if digests.get(name)!=hashlib.sha256(value.encode()).hexdigest():
            raise RuntimeError('Staging delivery/recipient gates must remain closed')
    # Close before reading data. Only the staging project is ever a write target.
    supabase(base+'/config/auth',method='PATCH',data={'disable_signup':True,'external_email_enabled':False,'external_google_enabled':False})
    query(ref,'select private.set_release_maintenance(true)')
    query(ref,'select cron.unschedule(jobid)from cron.job')
    snapshot=query(PRODUCTION_PROJECT,source_sql(public,private))[0]['snapshot']
    tables,mapping=checked_snapshot(snapshot,public,private,ref,remap)
    defaults={name:query(ref,'select to_jsonb(t)as record from private.'+ident(name)+' t')for name in preserve}
    defaults={name:[r['record']for r in rows]for name,rows in defaults.items()}
    catalog=query(ref,"select table_schema,table_name,column_name from information_schema.columns c where table_schema in('public','private')and table_name<>'pack_release_maintenance'and is_generated='NEVER'and exists(select 1 from pg_tables t where t.schemaname=c.table_schema and t.tablename=c.table_name)order by table_schema,table_name,ordinal_position")
    columns={}
    for row in catalog:
        columns.setdefault(row['table_schema']+'.'+row['table_name'],[]).append(row['column_name'])
    query(ref,replacement_sql(tables,mapping,defaults,columns,ref))
    evidence={'project':ref,'source':PRODUCTION_PROJECT,'transport':'management-api','refreshed_at':datetime.now(timezone.utc).isoformat(),
        'source_commit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),
        'table_counts':{name:len(rows)for name,rows in tables.items()},'authentication':'disabled remapped actors; no source credentials/identities/sessions',
        'jobs_enabled':False,'maintenance':True,'delivery_paused':True}
    private_json(ROOT/'.local/release/refresh-result.json',evidence)
    print('Staging refresh transaction and relationships verified; Auth/delivery/maintenance remain closed')
