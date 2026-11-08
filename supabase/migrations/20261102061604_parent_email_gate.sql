-- Called only by the signed email hook using its service credential. Never expose
-- an anonymous mailbox-membership oracle. Keep this independent of leader access.
create table private.parent_email_throttle (
 email_canonical text primary key,
 last_sent_at timestamptz not null,
 window_started_at timestamptz not null,
 attempts integer not null check(attempts > 0)
);
alter table private.parent_email_throttle enable row level security;
revoke all on private.parent_email_throttle from public,anon,authenticated;

create function public.reserve_parent_email(mailbox text, account_id uuid) returns boolean
language plpgsql security definer set search_path='' set statement_timeout='5s' as $$
declare canonical text; reserved boolean;
begin
 canonical := private.canonical_leader_email(mailbox);
 if canonical is null or not coalesce((select email_ready from private.parent_portal_settings where singleton),false) then
  return false;
 end if;
 if not exists (
  select 1 from public.parent_scout_links l join public.scouts s on s.id=l.scout_id
  where l.active and l.email_canonical=canonical
   and (l.claimed_user_id is null or l.claimed_user_id=account_id)
   and coalesce(s.den,'') !~* '^\s*\(withdraw\)'
 ) then return false; end if;
 -- Atomic UPSERT serializes requests, including concurrent Gmail aliases.
 insert into private.parent_email_throttle as t(email_canonical,last_sent_at,window_started_at,attempts)
 values(canonical,clock_timestamp(),clock_timestamp(),1)
 on conflict(email_canonical) do update set
  last_sent_at=excluded.last_sent_at,
  window_started_at=case when t.window_started_at <= excluded.last_sent_at-interval '1 hour' then excluded.last_sent_at else t.window_started_at end,
  attempts=case when t.window_started_at <= excluded.last_sent_at-interval '1 hour' then 1 else t.attempts+1 end
 where t.last_sent_at <= excluded.last_sent_at-interval '1 minute'
  and (t.window_started_at <= excluded.last_sent_at-interval '1 hour' or t.attempts < 5)
 returning true into reserved;
 return coalesce(reserved,false);
end;
$$;
revoke all on function public.reserve_parent_email(text,uuid) from public,anon,authenticated;
grant execute on function public.reserve_parent_email(text,uuid) to service_role;
