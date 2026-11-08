-- UI preference only: this does not restrict a leader's access to other dens.
alter table public.leader_access add column default_den text default null
  check (default_den is null or length(default_den) <= 100);
comment on column public.leader_access.default_den is
  'Optional portal starting den: Lion, Tiger, Wolf, Bear, Webelos, or AOL. Blank means All dens. Does not change permissions.';

create function private.leader_default_den() returns text
language sql stable security definer set search_path = '' as $$
  select nullif(btrim(a.default_den), '')
  from public.leader_access a
  join auth.users u on private.canonical_leader_email(u.email) = private.canonical_leader_email(a.email)
  where u.id = auth.uid() and a.active and private.is_approved_leader();
$$;
revoke all on function private.leader_default_den() from public, anon;
grant execute on function private.leader_default_den() to authenticated;

create or replace function public.get_pack_capabilities() returns jsonb
language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'approved', public.is_approved_leader(),
    'can_record', private.can_record(),
    'default_den', private.leader_default_den()
  );
$$;
revoke all on function public.get_pack_capabilities() from public, anon;
grant execute on function public.get_pack_capabilities() to authenticated;
