-- Personal Gmail mailbox equivalence only; custom Workspace domains stay exact.
-- Preserve original addresses and all verified-Google/approval requirements.
create function private.canonical_leader_email(address text) returns text
language sql immutable strict set search_path = '' as $$
  select case
    when lower(btrim(address)) ~ '^[a-z0-9]+(\.[a-z0-9]+)*(\+[^@[:space:]]+)?@(gmail|googlemail)\.com$'
    then replace(split_part(split_part(lower(btrim(address)), '@', 1), '+', 1), '.', '') || '@gmail.com'
    else lower(btrim(address))
  end;
$$;
revoke all on function private.canonical_leader_email(text) from public, anon, authenticated;
grant execute on function private.canonical_leader_email(text) to service_role;

-- One grant/revocation per mailbox, including inactive rows. Abort atomically if
-- existing aliases conflict; do not merge roles or recording grants implicitly.
create unique index leader_access_canonical_email_key
  on public.leader_access (private.canonical_leader_email(email));

create or replace function private.is_approved_leader() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.leader_access a
    join auth.users u on private.canonical_leader_email(u.email) = private.canonical_leader_email(a.email)
    join auth.identities i on i.user_id = u.id and i.provider = 'google'
    where u.id = auth.uid() and a.active
      and u.email_confirmed_at is not null
      and private.canonical_leader_email(i.identity_data->>'email') = private.canonical_leader_email(a.email)
      and i.identity_data->>'email_verified' = 'true'
  );
$$;

create or replace function private.can_record() returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_approved_leader() and exists (
    select 1 from public.leader_access a
    join auth.users u on private.canonical_leader_email(u.email) = private.canonical_leader_email(a.email)
    where u.id = auth.uid() and a.active and a.can_record
  );
$$;

revoke all on function private.is_approved_leader(), private.can_record() from public, anon;
grant execute on function private.is_approved_leader(), private.can_record() to authenticated;
