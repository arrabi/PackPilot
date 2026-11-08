create function public.read_pack_workspace(view_name text,as_parent boolean default false,scouting_year text default '2026-27')returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;leader boolean:=private.is_approved_leader()and not as_parent;
begin
 if view_name not in('events','calendar','images','planner','notes','history','admin','data-export')then raise exception 'Unknown workspace';end if;
 if view_name in('planner','notes','history','admin')and not leader then raise exception 'Adult leader access required'using errcode='42501';end if;
 if view_name='admin'and not private.is_pack_admin()then raise exception 'Administrator access required'using errcode='42501';end if;
 result:=public.read_pack_community(as_parent)||jsonb_build_object('year_end',coalesce((select ends_on from private.pack_year_ends where private.pack_year_ends.scouting_year=read_pack_workspace.scouting_year),make_date(left(read_pack_workspace.scouting_year,4)::int+1,6,30)),'user_id',auth.uid(),'default_den',case when leader then(select l.default_den from public.leader_access l join auth.users u on private.canonical_leader_email(l.email)=private.canonical_leader_email(u.email)where u.id=auth.uid()and l.active limit 1)else null end);
 if view_name<>'images'then result:=result||jsonb_build_object('photos','[]'::jsonb);end if;
 if view_name='planner'then
  result:=result||jsonb_build_object('activities',(select coalesce(jsonb_agg(jsonb_build_object('id',a.id,'title',a.title,'occurred_on',a.occurred_on)order by a.occurred_on desc),'[]')from public.pack_activities a where a.scouting_year=read_pack_workspace.scouting_year));
 else result:=result||jsonb_build_object('meetings','[]'::jsonb,'progress','[]'::jsonb,'advancement','[]'::jsonb,'priorities','[]'::jsonb);end if;
 if view_name='notes'then result:=result||jsonb_build_object('notes',public.read_leader_notes());end if;
 if view_name not in('planner','data-export')then result:=result||jsonb_build_object('adventures','[]'::jsonb);end if;
 return result||jsonb_build_object('attribution',case when leader then private.pack_value_attribution(case view_name
 when 'planner'then array['pack_meeting_plans'] when 'notes'then array['pack_leader_notes'] when 'events'then array['pack_events','pack_volunteer_jobs'] when 'images'then array['pack_family_photos'] when 'admin'then array['pack_retention','pack_deletion_requests','pack_scoutbook_mappings','pack_scoutbook_names']else array[]::text[]end)else '[]'::jsonb end);
end;$$;
revoke all on function public.read_pack_workspace(text,boolean,text)from public,anon;
grant execute on function public.read_pack_workspace(text,boolean,text)to authenticated;

create function public.read_scout_photo_pair(child uuid)returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if not private.is_approved_leader()and not private.parent_can_read_scout(child)then raise exception 'Photo access denied'using errcode='42501';end if;
 return(select coalesce(jsonb_agg(to_jsonb(p)),'[]')from public.pack_family_photos p where p.scout_id=child);
end;$$;
revoke all on function public.read_scout_photo_pair(uuid)from public,anon;
grant execute on function public.read_scout_photo_pair(uuid)to authenticated;

create function private.pack_value_attribution(tables text[],child uuid default null)returns jsonb
language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(to_jsonb(x)),'[]')from(
 select distinct on(l.table_name,l.record_id,e.key)l.table_name,l.record_id,l.record_key,e.key field,e.value->'after'value,l.actor_name,l.actor_kind,l.recorded_at,l.effective_on,l.action
 from private.pack_change_log l cross join lateral jsonb_each(l.changes)e where l.table_name=any(tables)and(child is null or l.scout_id=child)and private.can_read_pack_change(l)
 order by l.table_name,l.record_id,e.key,l.id desc)x;
$$;
revoke all on function private.pack_value_attribution(text[],uuid)from public,anon,authenticated;
create function public.read_scout_attribution_bulk()returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if not private.is_approved_leader()then raise exception 'Leader access required'using errcode='42501';end if;
 return private.pack_value_attribution(array['scouts','pack_attendance','pack_registrations','pack_advancement','pack_requirement_progress','pack_equipment_events','pack_equipment_state','pack_home_assignments','pack_family_messages']);
end;$$;
revoke all on function public.read_scout_attribution_bulk()from public,anon;
grant execute on function public.read_scout_attribution_bulk()to authenticated;
create or replace function public.read_leader_notes()returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if not private.is_approved_leader()then raise exception 'Leader access required'using errcode='42501';end if;
 return(select coalesce(jsonb_agg(to_jsonb(n)||jsonb_build_object('owner_name',coalesce(to_jsonb(u)->'raw_user_meta_data'->>'full_name',u.email))order by n.den,n.recorded_at),'[]')from public.pack_leader_notes n join auth.users u on u.id=n.owner_id where n.owner_id=auth.uid()or private.is_pack_admin());
end;$$;
