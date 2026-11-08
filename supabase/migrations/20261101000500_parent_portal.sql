-- Parent access is independent of leader_access and never opens pack-wide APIs.
create table public.parent_scout_links (
  id uuid primary key default gen_random_uuid(),
  scout_id uuid not null references public.scouts(id),
  parent_email text not null check(parent_email=lower(btrim(parent_email)) and parent_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  email_canonical text generated always as (private.canonical_leader_email(parent_email)) stored,
  active boolean not null default true,
  claimed_user_id uuid references auth.users(id),
  claimed_at timestamptz,
  source_context jsonb not null default '{}'::jsonb check(jsonb_typeof(source_context)='object'),
  created_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id),
  unique(scout_id,email_canonical),
  check((claimed_user_id is null)=(claimed_at is null))
);
alter table public.parent_scout_links enable row level security;
revoke all on public.parent_scout_links from public,anon,authenticated;
create index parent_scout_links_user on public.parent_scout_links(claimed_user_id) where active;
comment on table public.parent_scout_links is 'Administrative approval of a parent email for one child. Revocable per relationship. No parent-facing writes; claiming requires control of a confirmed email. Source contact edits never automatically grant access.';

create function private.parent_can_read_scout(child uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists (
   select 1 from public.parent_scout_links l
   join auth.users u on u.id=l.claimed_user_id
   join public.scouts s on s.id=l.scout_id
   where l.scout_id=child and l.active and u.id=auth.uid()
     and u.email_confirmed_at is not null
     and private.canonical_leader_email(u.email)=l.email_canonical
     and coalesce(s.den,'') !~* '^\s*\(withdraw\)'
 );
$$;
revoke all on function private.parent_can_read_scout(uuid) from public,anon,authenticated;

create function public.claim_parent_links() returns integer
language plpgsql security definer set search_path='' set statement_timeout='5s' as $$
declare mailbox text; claimed integer;
begin
 select private.canonical_leader_email(u.email) into mailbox from auth.users u
 where u.id=auth.uid() and u.email_confirmed_at is not null;
 if mailbox is null then raise exception 'Verified email required' using errcode='42501'; end if;
 update public.parent_scout_links l set claimed_user_id=auth.uid(),claimed_at=now()
 where l.active and l.email_canonical=mailbox and l.claimed_user_id is null
   and exists(select 1 from public.scouts s where s.id=l.scout_id and coalesce(s.den,'') !~* '^\s*\(withdraw\)');
 get diagnostics claimed=row_count;
 return claimed;
end;
$$;
revoke all on function public.claim_parent_links() from public,anon;
grant execute on function public.claim_parent_links() to authenticated;

create function public.read_parent_portal(scouting_year text default '2026-27') returns jsonb
language plpgsql stable security definer set search_path='' set statement_timeout='5s' as $$
#variable_conflict use_variable
declare result jsonb;
begin
 if not exists(select 1 from auth.users u where u.id=auth.uid() and u.email_confirmed_at is not null) then
   raise exception 'Verified email required' using errcode='42501'; end if;
 if scouting_year is null or scouting_year !~ '^[0-9]{4}-[0-9]{2}$' or right(scouting_year,2)<>right((left(scouting_year,4)::int+1)::text,2) then raise exception 'Invalid scouting year'; end if;
 with children as materialized (
   select s.id,s.scout_name,s.den,s.grade,s.bsa_member_id from public.scouts s
   where private.parent_can_read_scout(s.id)
 ), ranks as (
   select distinct case lower(regexp_replace(coalesce(den,''),'^\d+\s*[-–]\s*',''))
    when 'lions' then 'lion' when 'lion' then 'lion' when 'tigers' then 'tiger' when 'tiger' then 'tiger'
    when 'wolves' then 'wolf' when 'wolf' then 'wolf' when 'bears' then 'bear' when 'bear' then 'bear'
    when 'webelos' then 'webelos' when 'aol' then 'arrow_of_light' when 'arrow of light' then 'arrow_of_light' end as rank
   from children
 )
 select jsonb_build_object(
   'scouts',coalesce((select jsonb_agg(to_jsonb(c)order by c.scout_name)from children c),'[]'::jsonb),
   'adventures',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'name',a.name,'rank',a.rank,'program_version',a.program_version,'source_url',a.source_url,'requirements',a.requirements,'readiness_mode',a.readiness_mode,'catalog_context',a.catalog_context) order by a.rank,a.name)from public.pack_adventures a where a.rank in(select rank from ranks)),'[]'::jsonb),
   'advancement',coalesce((select jsonb_agg(jsonb_build_object('scout_id',a.scout_id,'adventure_id',a.adventure_id,'earned_on',a.earned_on,'badge_delivered_on',a.badge_delivered_on,'badge_form',a.badge_form))from public.pack_advancement a join children c on c.id=a.scout_id where a.scouting_year=scouting_year),'[]'::jsonb),
   'progress',coalesce((select jsonb_agg(jsonb_build_object('scout_id',p.scout_id,'adventure_id',p.adventure_id,'requirement_code',p.requirement_code,'completed_on',p.completed_on,'completion_source',p.completion_source))from public.pack_requirement_progress p join children c on c.id=p.scout_id where p.scouting_year=scouting_year),'[]'::jsonb),
   'registrations',coalesce((select jsonb_agg(jsonb_build_object('scout_id',r.scout_id,'platform',r.platform,'status',r.status,'occurred_on',r.occurred_on))from public.pack_registrations r join children c on c.id=r.scout_id where r.scouting_year=scouting_year),'[]'::jsonb)
 ) into result;
 return result;
end;
$$;
revoke all on function public.read_parent_portal(text) from public,anon;
grant execute on function public.read_parent_portal(text) to authenticated;

-- Public readiness exposes no addresses or account information. The administrator
-- enables code requests only after a custom SMTP sender and OTP templates work.
create table private.parent_portal_settings (
 singleton boolean primary key default true check(singleton),
 email_ready boolean not null default false
);
insert into private.parent_portal_settings(singleton,email_ready) values(true,false);
alter table private.parent_portal_settings enable row level security;
revoke all on private.parent_portal_settings from public,anon,authenticated;
create function public.get_parent_portal_status() returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('email_ready',coalesce((select email_ready from private.parent_portal_settings where singleton),false));
$$;
revoke all on function public.get_parent_portal_status() from public;
grant execute on function public.get_parent_portal_status() to anon,authenticated;
