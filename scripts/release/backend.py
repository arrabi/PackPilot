"""Migration-history verification and Edge deployment shared by release workflows.

Production calls belong only in the approved integrated controller. This module
never invokes the notification dispatcher with a valid delivery credential.
"""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile
import uuid
from platform_api import query, supabase, project_ref

SLUGS = ('scouts-mcp', 'parent-notifications', 'notification-links')


def literal(value):
    return "'" + value.replace("'", "''") + "'"


def sql_digest(value):
    import sqlparse
    from sqlparse import tokens as T
    # Preserve literals, identifiers and function bodies byte-for-byte. Only
    # comments and whitespace between SQL tokens are irrelevant to this check.
    tokens = [token.value for statement in sqlparse.parse(value) for token in statement.flatten()
              if not token.is_whitespace and token.ttype not in T.Comment and token.value != ';']
    return hashlib.sha256(json.dumps(tokens, separators=(',', ':')).encode()).hexdigest()


def source_migrations(root):
    result = {}
    for path in sorted((Path(root) / 'supabase/migrations').glob('*.sql')):
        version, name = path.stem.split('_', 1)
        if not re.fullmatch(r'\d{14}', version) or version in result:
            raise RuntimeError('Invalid or duplicate migration version')
        result[version] = {'name': name, 'body': path.read_text(), 'sha256': sql_digest(path.read_text())}
    return result


def history(project):
    if not query(project, "select to_regclass('supabase_migrations.schema_migrations') as present")[0]['present']:
        return []
    return query(project, 'select version,name,statements from supabase_migrations.schema_migrations order by version')


def schema_digest(project):
    # Migration history alone cannot detect a manual change to a table, policy,
    # trigger or RPC. Hash catalog definitions without recording private rows.
    rows = query(project, """select kind,name,definition from (
      select 'column'::text kind,format('%I.%I.%I',n.nspname,c.relname,a.attname) name,
        jsonb_build_array(format_type(a.atttypid,a.atttypmod),a.attnotnull,a.attidentity,a.attgenerated,
          pg_get_expr(d.adbin,d.adrelid),c.relrowsecurity,c.relforcerowsecurity)::text definition
      from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace
      left join pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum
      where n.nspname in ('public','private') and c.relkind in ('r','p','v','m') and a.attnum>0 and not a.attisdropped
      union all select 'constraint',format('%I.%I.%I',n.nspname,c.relname,k.conname),pg_get_constraintdef(k.oid)
      from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace
      where n.nspname in ('public','private')
      union all select 'function',format('%I.%I(%s)',n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)),pg_get_functiondef(p.oid)
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private') and p.prokind in ('f','p')
      union all select 'trigger',format('%I.%I.%I',n.nspname,c.relname,t.tgname),pg_get_triggerdef(t.oid)
      from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
      where n.nspname in ('public','private') and not t.tgisinternal
      union all select 'policy',format('%I.%I.%I',schemaname,tablename,policyname),
        jsonb_build_array(permissive,roles,cmd,qual,with_check)::text from pg_policies where schemaname in ('public','private')
    ) definitions order by kind,name""")
    return hashlib.sha256(json.dumps(rows, sort_keys=True).encode()).hexdigest()


def plan(project, root, *, rollback=False):
    source = source_migrations(root)
    applied = history(project)
    seen = set()
    rows = []
    for item in applied:
        version = item['version']
        seen.add(version)
        statements = item.get('statements') or []
        if not statements:
            raise RuntimeError('Applied migration lacks recorded SQL: ' + version)
        actual = sql_digest('\n'.join(statements))
        if version not in source:
            if not rollback:
                raise RuntimeError('Database migration absent from candidate: ' + version)
        elif actual != source[version]['sha256']:
            raise RuntimeError('Applied migration differs from immutable source: ' + version)
        rows.append({'version': version, 'sha256': actual})
    missing = [version for version in source if version not in seen]
    if rollback and missing:
        raise RuntimeError('Rollback cannot introduce migrations')
    if missing and seen and min(missing) < max(seen):
        raise RuntimeError('Out-of-order migration requires an explicit recovery plan')
    expected = rows + [{'version': version, 'sha256': source[version]['sha256']} for version in missing]
    digest = hashlib.sha256(json.dumps(expected, sort_keys=True).encode()).hexdigest()
    return {'pending': missing, 'migration_digest': digest, 'migrations': expected}


def migrate(project, root):
    project_ref(project)
    result = plan(project, root)
    if not history(project):
        query(project, 'create schema if not exists supabase_migrations;create table if not exists supabase_migrations.schema_migrations(version text primary key,statements text[],name text);')
    source = source_migrations(root)
    for version in result['pending']:
        item = source[version]
        # Each migration plus its history record commits atomically. A failed
        # migration stays absent and never silently advances the history.
        query(project, "begin;set local lock_timeout='60s';set local session_replication_role='replica';\n" + item['body'] +
            '\ninsert into supabase_migrations.schema_migrations(version,name,statements) values (' +
            ','.join((literal(version), literal(item['name']), 'array[' + literal(item['body']) + ']')) + ');commit;')
        print('Applied migration ' + version)
    # New tables must also participate in maintenance after every migration.
    if query(project, "select to_regprocedure('private.guard_release_write()') as present")[0]['present']:
        query(project, """do $$declare r record;begin
          for r in select n.nspname,c.relname,c.oid from pg_class c join pg_namespace n on n.oid=c.relnamespace
          where n.nspname in ('public','private') and c.relkind in ('r','p')
          and c.oid<>'private.pack_release_maintenance'::regclass loop
            if not exists(select 1 from pg_trigger where tgrelid=r.oid and tgname='pack99_release_write_guard') then
              execute format('create trigger pack99_release_write_guard before insert or update or delete or truncate on %I.%I for each statement execute function private.guard_release_write()',r.nspname,r.relname);
            end if;
          end loop;end$$;""")
    return plan(project, root)


def bundle(root, slug, destination):
    # Bundle bare npm dependencies too, pinning deployed code to package-lock.json.
    options = {'entryPoints': [f'supabase/functions/{slug}/index.ts'], 'outfile': str(destination),
               'bundle': True, 'format': 'esm', 'platform': 'neutral', 'target': 'es2022',
               'mainFields': ['module', 'main'], 'conditions': ['deno', 'import', 'default'], 'external': ['node:*']}
    script = "import{build}from'esbuild';await build(" + json.dumps(options) + ');'
    result = subprocess.run(['node', '--input-type=module', '-e', script], cwd=root, capture_output=True)
    if result.returncode:
        raise RuntimeError('Function bundle failed: ' + slug)


def deploy_functions(project, root, *, staging=False, archive=None):
    project_ref(project, staging=staging)
    if staging:
        entry = Path(root) / 'supabase/functions/parent-notifications/index.ts'
        if (not (Path(root) / 'supabase/functions/staging-auth-email/index.ts').is_file()
                or not all(flag in entry.read_text() for flag in ('PACK99_DELIVERY_PAUSED', 'PACK99_ENVIRONMENT', 'PACK99_EMAIL_ALLOWLIST'))):
            raise RuntimeError('Staging requires a recipient-gated, pause-aware backend source')
    outcomes = []
    assistant = (Path(root) / 'supabase/functions/fieldbook-assistant/index.ts').is_file()
    # Older rollback sources predate this optional function. Restore its absence
    # instead of leaving a newer active endpoint behind the older application.
    if not assistant:
        remote = supabase('/v1/projects/' + project + '/functions')
        if any(item['slug'] == 'fieldbook-assistant' for item in remote):
            supabase('/v1/projects/' + project + '/functions/fieldbook-assistant', method='DELETE')
            print('Removed assistant endpoint absent from selected backend source')
    slugs = SLUGS + (('staging-auth-email',) if staging else ()) + (('fieldbook-assistant',) if assistant else ())
    for slug in slugs:
        with tempfile.TemporaryDirectory(prefix='pack99-edge-') as temp:
            path = Path(temp) / 'index.ts'
            bundle(root, slug, path)
            code = path.read_bytes()
            boundary = 'pack99-' + uuid.uuid4().hex
            parts = []
            for field, body, filename, mime in [('metadata', json.dumps({'name': slug, 'entrypoint_path': 'index.ts', 'verify_jwt': False}).encode(), None, 'application/json'), ('file', code, 'index.ts', 'application/typescript')]:
                disposition = 'form-data; name="' + field + '"' + ('; filename="' + filename + '"' if filename else '')
                parts.append(('--' + boundary + '\r\nContent-Disposition: ' + disposition + '\r\nContent-Type: ' + mime + '\r\n\r\n').encode() + body + b'\r\n')
            value = supabase('/v1/projects/' + project + '/functions/deploy?slug=' + slug, method='POST',
                raw=b''.join(parts) + ('--' + boundary + '--\r\n').encode(), content_type='multipart/form-data; boundary=' + boundary)
            if value.get('status') != 'ACTIVE' or value.get('verify_jwt') is not False:
                raise RuntimeError('Function deployment did not verify: ' + slug)
            digest = hashlib.sha256(code).hexdigest()
            if archive:
                archive(slug, code)
            outcomes.append({'slug': slug, 'version': value['version'], 'sha256': digest})
            print('Deployed function ' + slug + ' version ' + str(value['version']))
    return outcomes
