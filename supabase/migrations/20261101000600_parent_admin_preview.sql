-- One minimal data projection shared by real family access and admin preview.
-- It accepts explicit IDs but is executable only by the function owner.
create function private.parent_portal_projection(child_ids uuid[],scouting_year text) returns jsonb
language plpgsql stable security definer set search_path='' set statement_timeout='5s' as $$
#variable_conflict use_variable
declare result jsonb;
begin
 if scouting_year is null or scouting_year !~ '^[0-9]{4}-[0-9]{2}$' or right(scouting_year,2)<>right((left(scouting_year,4)::int+1)::text,2) then raise exception 'Invalid scouting year'; end if;
 with children as materialized (
   select s.id,s.scout_name,s.den,s.grade,s.bsa_member_id from public.scouts s
   where s.id=any(child_ids) and coalesce(s.den,'') !~* '^\s*\(withdraw\)'
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
revoke all on function private.parent_portal_projection(uuid[],text) from public,anon,authenticated;

create or replace function public.read_parent_portal(scouting_year text default '2026-27') returns jsonb
language plpgsql stable security definer set search_path='' set statement_timeout='5s' as $$
#variable_conflict use_variable
declare children uuid[];
begin
 if not exists(select 1 from auth.users u where u.id=auth.uid() and u.email_confirmed_at is not null) then
   raise exception 'Verified email required' using errcode='42501'; end if;
 select coalesce(array_agg(s.id),array[]::uuid[]) into children from public.scouts s where private.parent_can_read_scout(s.id);
 return private.parent_portal_projection(children,scouting_year);
end;
$$;
revoke all on function public.read_parent_portal(text) from public,anon;
grant execute on function public.read_parent_portal(text) to authenticated;

-- This separate read-only route uses the existing approved Google/admin role.
-- It never claims parent links or treats a den as a family.
create function public.read_parent_preview(scouting_year text default '2026-27') returns jsonb
language plpgsql stable security definer set search_path='' set statement_timeout='5s' as $$
#variable_conflict use_variable
declare children uuid[];
begin
 if not private.is_approved_leader() or not exists(
   select 1 from public.leader_access l join auth.users u on private.canonical_leader_email(u.email)=private.canonical_leader_email(l.email)
   where u.id=auth.uid() and l.active and l.role='admin'
 ) then raise exception 'Parent preview requires pack administrator access' using errcode='42501'; end if;
 select coalesce(array_agg(s.id),array[]::uuid[]) into children from public.scouts s
 where coalesce(s.den,'') !~* '^\s*\(withdraw\)' and lower(btrim(regexp_replace(coalesce(s.den,''),'^\d+\s*[-–]\s*',''))) in ('lion','lions');
 return private.parent_portal_projection(children,scouting_year);
end;
$$;
revoke all on function public.read_parent_preview(text) from public,anon;
grant execute on function public.read_parent_preview(text) to authenticated;
