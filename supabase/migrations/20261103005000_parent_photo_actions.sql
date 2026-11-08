-- Parent action-center photo presence only; image payloads remain in the scoped Images workspace.
create or replace function public.read_parent_dashboard(scouting_year text default '2026-27')returns jsonb language plpgsql stable security definer set search_path='' as $$
declare ids uuid[];result jsonb;
begin
 if not private.has_accepted_site_policies()then raise exception 'Accept the current policies first'using errcode='42501';end if;
 select coalesce(array_agg(s.id),array[]::uuid[])into ids from public.scouts s where private.parent_can_read_scout(s.id);
 result:=private.parent_portal_projection(ids,scouting_year);
 return result||jsonb_build_object('scout_photos',(select coalesce(jsonb_agg(jsonb_build_object('scout_id',p.scout_id)),'[]')from public.pack_family_photos p where p.scout_id=any(ids)and p.kind='scout'),'registration_reports',(select coalesce(jsonb_agg(to_jsonb(r)),'[]')from public.pack_registration_reports r where r.scout_id=any(ids)and r.scouting_year=read_parent_dashboard.scouting_year),'participation',case when cardinality(ids)>0 then public.read_pack_workspace('events',true,scouting_year)else jsonb_build_object('scouts','[]'::jsonb,'events','[]'::jsonb,'jobs','[]'::jsonb,'bookings','[]'::jsonb,'signups','[]'::jsonb)end);
end;$$;
revoke all on function public.read_parent_dashboard(text)from public,anon;
grant execute on function public.read_parent_dashboard(text)to authenticated;
create or replace function public.read_parent_preview_scope(scouting_year text default '2026-27',den_filter text default null,child uuid default null)returns jsonb language plpgsql stable security definer set search_path='' as $$
#variable_conflict use_variable
declare ids uuid[];result jsonb;community jsonb;events jsonb;jobs jsonb;
begin
 if not private.is_pack_admin()then raise exception 'Administrator access required'using errcode='42501';end if;
 select coalesce(array_agg(s.id),array[]::uuid[])into ids from public.scouts s where coalesce(s.den,'')!~*'^\s*\(withdraw\)'and(den_filter is null or s.den=den_filter)and(child is null or s.id=child);
 result:=private.parent_portal_projection(ids,scouting_year);community:=public.read_pack_community(false);
 select coalesce(jsonb_agg(e),'[]')into events from jsonb_array_elements(community->'events')e where e->>'den'is null or exists(select 1 from public.scouts s where s.id=any(ids)and s.den=e->>'den');
 select coalesce(jsonb_agg(j||jsonb_build_object('mine',exists(select 1 from public.pack_volunteers v where v.job_id=(j->>'id')::uuid and v.scout_id=any(ids)),'my_note',null,'can_edit_note',false,'family_commitment_count',(select count(*)from public.pack_volunteers v where v.job_id=(j->>'id')::uuid and v.scout_id=any(ids)),'on_waitlist',false)),'[]')into jobs from jsonb_array_elements(community->'jobs')j where j->>'event_id'is null or exists(select 1 from jsonb_array_elements(events)e where e->>'id'=j->>'event_id');
 return result||jsonb_build_object('scout_photos',(select coalesce(jsonb_agg(jsonb_build_object('scout_id',p.scout_id)),'[]')from public.pack_family_photos p where p.scout_id=any(ids)and p.kind='scout'),'preview_scope',coalesce((select s.scout_name from public.scouts s where s.id=child),den_filter,'Pack'),'registration_reports',(select coalesce(jsonb_agg(to_jsonb(r)),'[]')from public.pack_registration_reports r where r.scout_id=any(ids)and r.scouting_year=scouting_year),'participation',jsonb_build_object('scouts',result->'scouts','events',events,'jobs',jobs,'signups',(select coalesce(jsonb_agg(g),'[]')from jsonb_array_elements(community->'signups')g where exists(select 1 from jsonb_array_elements(jobs)j where j->>'signup_id'=g->>'id')),'bookings',(select coalesce(jsonb_agg(to_jsonb(b)),'[]')from public.pack_event_bookings b where b.scout_id=any(ids))));
end;$$;
revoke all on function public.read_parent_preview_scope(text,text,uuid)from public,anon;
grant execute on function public.read_parent_preview_scope(text,text,uuid)to authenticated;
