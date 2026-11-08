-- Apply to staging and rehearse before any production deployment.
create table private.pack_release_maintenance (
 singleton boolean primary key default true check(singleton),
 enabled boolean not null default false,
 changed_at timestamptz not null default now()
);
insert into private.pack_release_maintenance(singleton) values(true);
alter table private.pack_release_maintenance enable row level security;
revoke all on private.pack_release_maintenance from public, anon, authenticated, service_role;

create function private.guard_release_write() returns trigger
language plpgsql security definer set search_path='' as $$
declare paused boolean;
begin
 -- Hold until transaction end. Enabling maintenance drains prior writes first.
 perform pg_catalog.pg_advisory_xact_lock_shared(990050900);
 -- Row locking also rejects stale repeatable-read snapshots after activation.
 select enabled into paused from private.pack_release_maintenance where singleton for share;
 if paused is distinct from false then
  raise exception 'PackPilot is in maintenance; retry later' using errcode='55000';
 end if;
 return null;
end;$$;
revoke all on function private.guard_release_write() from public, anon, authenticated, service_role;

create function private.set_release_maintenance(paused boolean) returns void
language plpgsql security definer set search_path='' as $$
begin
 if paused is null then raise exception 'Maintenance state required';end if;
 perform pg_catalog.pg_advisory_xact_lock(990050900);
 update private.pack_release_maintenance set enabled=paused,changed_at=clock_timestamp() where singleton;
end;$$;
revoke all on function private.set_release_maintenance(boolean) from public, anon, authenticated, service_role;

do $$declare target record;
begin
 for target in select n.nspname,c.relname from pg_catalog.pg_class c
 join pg_catalog.pg_namespace n on n.oid=c.relnamespace
 where n.nspname in ('public','private') and c.relkind in ('r','p')
 and c.oid<>'private.pack_release_maintenance'::regclass
 loop
  execute format('create trigger pack99_release_write_guard before insert or update or delete or truncate on %I.%I for each statement execute function private.guard_release_write()',target.nspname,target.relname);
 end loop;
end;$$;
-- Every future application table must attach the same statement trigger.
-- Auth/storage/platform mutation needs a separate deployment/restore control;
-- this barrier covers application, service-role and scheduler application writes.
