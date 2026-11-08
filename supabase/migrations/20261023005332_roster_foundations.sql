-- Roster queries run as the requesting user. Only dashboard/administrative
-- connections can change memberships or import data.
create table public.leader_access (
  email text primary key check (email = lower(btrim(email)) and position('@' in email) > 1),
  role text not null default 'leader' check (role in ('admin', 'leader')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.leader_access enable row level security;
revoke all on public.leader_access from anon, authenticated;

insert into public.leader_access (email, role) values ('admin@example.test', 'admin');

create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

create function private.is_approved_leader() returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.leader_access a
    join auth.users u on lower(u.email) = a.email
    join auth.identities i on i.user_id = u.id and i.provider = 'google'
    where u.id = auth.uid() and a.active
      and u.email_confirmed_at is not null
      and lower(i.identity_data->>'email') = a.email
      and i.identity_data->>'email_verified' = 'true'
  );
$$;
revoke all on function private.is_approved_leader() from public, anon;
grant execute on function private.is_approved_leader() to authenticated;

-- Public RPC is invoker-security; the privileged lookup stays in a schema
-- excluded from the Data API. It only checks the current verified identity.
create function public.is_approved_leader() returns boolean
language sql stable security invoker set search_path = ''
as $$ select private.is_approved_leader(); $$;
revoke all on function public.is_approved_leader() from public, anon;
grant execute on function public.is_approved_leader() to authenticated;

create table public.roster_snapshots (
  id uuid primary key default gen_random_uuid(),
  source_sha256 text not null unique check (source_sha256 ~ '^[0-9a-f]{64}$'),
  source_file text not null,
  source_sheet text not null check (source_sheet = 'Roster 2026-27'),
  snapshot_date date not null,
  imported_at timestamptz not null default now(),
  expected_rows integer not null check (expected_rows between 1 and 10000),
  singleton boolean not null default true unique check (singleton)
);

create table public.scouts (
  id uuid primary key default gen_random_uuid(),
  snapshot_id uuid not null references public.roster_snapshots(id),
  snapshot_date date not null,
  source_row integer not null check (source_row >= 2),
  scout_name text,
  den text,
  den_leaders text,
  present_last_year text,
  parent_1_name text,
  participant_email text,
  parent_1_email text,
  parent_1_phone text,
  parent_2_name text,
  parent_2_email text,
  parent_2_phone text,
  birth_date date,
  allergy text,
  medication text,
  grade text,
  registered_date date,
  gender text,
  registration_status text,
  in_sa text,
  sa_expiry date,
  source_values jsonb not null,
  unique (snapshot_id, source_row)
);

alter table public.roster_snapshots enable row level security;
alter table public.scouts enable row level security;
revoke all on public.scouts, public.roster_snapshots from anon, authenticated;
grant select on public.scouts, public.roster_snapshots to authenticated;
create policy approved_roster_read on public.scouts for select to authenticated
using ((select public.is_approved_leader()));
create policy approved_snapshot_read on public.roster_snapshots for select to authenticated
using ((select public.is_approved_leader()));

-- Scalar JSON response avoids PostgREST's row cap and reads one consistent
-- database snapshot. Invoker security preserves RLS. No SQL argument is accepted.
create function public.read_roster_snapshot() returns jsonb
language plpgsql stable security invoker set search_path = ''
set statement_timeout = '5s'
as $$
declare
  result jsonb;
  expected integer;
begin
  if not public.is_approved_leader() then
    raise exception 'Roster access denied' using errcode = '42501';
  end if;
  select expected_rows into expected from public.roster_snapshots;
  if expected is null then
    raise exception 'Roster has not been imported' using errcode = 'P0001';
  end if;
  select coalesce(jsonb_agg(to_jsonb(s) order by s.source_row), '[]'::jsonb)
    into result from (select * from public.scouts order by source_row limit 10001) s;
  if jsonb_array_length(result) > 10000 or jsonb_array_length(result) <> expected then
    raise exception 'Roster size or import reconciliation failed' using errcode = 'P0001';
  end if;
  return result;
end;
$$;
revoke all on function public.read_roster_snapshot() from public, anon;
grant execute on function public.read_roster_snapshot() to authenticated;

-- Explicit administrative grants; these are never used by the MCP handler.
grant all on public.leader_access, public.scouts, public.roster_snapshots to service_role;
