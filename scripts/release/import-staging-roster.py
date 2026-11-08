"""Initial staging roster/catalog import. Keeps existing staging login and data.

Only empty roster_snapshots/scouts/pack_adventures tables are accepted. Production
is read-only. No Auth records, family access, progress, jobs or queues are copied.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import subprocess

from access import PRODUCTION_PROJECT
from platform_api import private_json, query, supabase
from staging_refresh_api import ident, literal

ROOT = Path(__file__).resolve().parents[2]
STAGING = 'bbbbbbbbbbbbbbbbbbbb'
TABLES = ('roster_snapshots', 'scouts', 'pack_adventures')


def import_sql(tables, columns, owner):
    if set(tables) != set(TABLES) or set(columns) != set(TABLES):
        raise RuntimeError('Only the reviewed roster/catalog tables are supported')
    parts = ["begin;select pg_advisory_xact_lock(990050900);set local session_replication_role='replica';",
        "do $$begin if exists(select 1 from public.scouts)or exists(select 1 from public.pack_adventures)"
        "or exists(select 1 from public.roster_snapshots)then raise exception 'Initial staging import requires empty tables';end if;end$$;"]
    for table in TABLES:
        records = [dict(row) for row in tables[table]]
        if any(set(row) != set(columns[table]) for row in records):
            raise RuntimeError('Source/destination columns differ')
        if table == 'pack_adventures':
            for record in records:
                record['recorded_by'] = owner
        names = ','.join(ident(name) for name in columns[table])
        relation = 'public.' + ident(table)
        parts.append('insert into ' + relation + '(' + names + ') overriding system value select ' + names
            + ' from jsonb_populate_recordset(null::' + relation + ',' + literal(json.dumps(records)) + '::jsonb);')
        parts.append('do $$begin if(select count(*)from ' + relation + ')<>' + str(len(records))
            + " then raise exception 'Staging import count mismatch';end if;end$$;")
    parts.append("do $$begin if(select expected_rows from public.roster_snapshots)<>(select count(*)from public.scouts)"
        "or exists(select 1 from public.scouts s where not exists(select 1 from public.roster_snapshots r where r.id=s.snapshot_id))"
        "then raise exception 'Roster reconciliation failed';end if;"
        "if exists(select 1 from private.pack_email_outbox)or exists(select 1 from cron.job)then "
        "raise exception 'Staging delivery must remain closed';end if;end$$;commit;")
    statement = '\n'.join(parts)
    if len(statement.encode()) > 12 * 1024 * 1024:
        raise RuntimeError('Staging import exceeds the reviewed size bound')
    return statement


def main():
    config = json.loads((ROOT / 'config/release-system.json').read_text())
    if config['staging_project'] != STAGING or STAGING == PRODUCTION_PROJECT:
        raise RuntimeError('Unexpected staging destination')
    values = {x['name']:x['value'] for x in supabase('/v1/projects/' + STAGING + '/secrets')}
    for name,value in {'PACK99_ENVIRONMENT':'staging','PACK99_DELIVERY_PAUSED':'true','PACK99_EMAIL_ALLOWLIST':'staging@example.test'}.items():
        if values.get(name) != hashlib.sha256(value.encode()).hexdigest():
            raise RuntimeError('Staging mail isolation must remain in place')
    owner = query(STAGING,"select u.id from auth.users u join auth.identities i on i.user_id=u.id "
        "where u.email='admin@example.test' and i.provider='google' and i.identity_data->>'email_verified'='true'")
    if len(owner) != 1:
        raise RuntimeError('A verified staging owner Google login is required')
    pairs = []
    for table in TABLES:
        projection = "to_jsonb(t)-array(select column_name::text from information_schema.columns where table_schema='public'and table_name=" + literal(table) + "and is_generated<>'NEVER')"
        pairs.extend([literal(table),'(select coalesce(jsonb_agg(' + projection + "),'[]'::jsonb)from public." + ident(table) + ' t)'])
    tables = query(PRODUCTION_PROJECT,'begin transaction isolation level repeatable read read only;select jsonb_build_object('
        + ','.join(pairs) + ')as tables;rollback;')[0]['tables']
    if not tables['scouts'] or not tables['pack_adventures'] or len(tables['roster_snapshots']) != 1:
        raise RuntimeError('A reconciled source roster and catalog are required')
    rows = query(STAGING,"select table_name,column_name from information_schema.columns where table_schema='public'and table_name in('roster_snapshots','scouts','pack_adventures')and is_generated='NEVER'order by table_name,ordinal_position")
    columns = {table:[row['column_name'] for row in rows if row['table_name']==table]for table in TABLES}
    query(STAGING,import_sql(tables,columns,owner[0]['id']))
    receipt = {'project':STAGING,'source':PRODUCTION_PROJECT,'scope':list(TABLES),
        'imported_at':datetime.now(timezone.utc).isoformat(),
        'source_commit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),
        'counts':{table:len(records)for table,records in tables.items()},
        'authentication_preserved':True,'production_auth_copied':False,'delivery_paused':True}
    private_json(ROOT / '.local/release/roster-import-result.json',receipt)
    print(json.dumps(receipt))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--import-roster-and-adventures',action='store_true',required=True)
    parser.parse_args()
    try:
        main()
    except Exception:
        raise SystemExit('Staging roster/catalog import incomplete; production unchanged; private error details withheld')
