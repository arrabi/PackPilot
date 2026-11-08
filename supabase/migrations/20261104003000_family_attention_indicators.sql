-- Read-only Family Hub indicators. No records, delivery state or permissions are broadened.
create or replace function private.family_work_data(child_ids uuid[],year text) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object(
 'assignments',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'scout_id',a.scout_id,'adventure_id',a.adventure_id,'scouting_year',a.scouting_year,'requirement_code',a.requirement_code,'instructions',a.instructions,'assigned_on',a.assigned_on,'created_at',a.created_at,'due_on',a.due_on,
 'status',case when a.status<>'cancelled' and (v.earned_on is not null or p.completed_on is not null)then 'completed'else a.status end,
 'completed_on',coalesce(p.completed_on,v.earned_on,a.completed_on),'parent_note',a.parent_note,'submitted_at',a.submitted_at,'review_note',a.review_note,'reviewed_at',a.reviewed_at,'revision',a.revision)
 order by a.created_at,a.id)from public.pack_home_assignments a
 left join public.pack_advancement v on v.scout_id=a.scout_id and v.adventure_id=a.adventure_id and v.scouting_year=a.scouting_year
 left join public.pack_requirement_progress p on p.scout_id=a.scout_id and p.adventure_id=a.adventure_id and p.scouting_year=a.scouting_year and p.requirement_code=a.requirement_code
 where a.scout_id=any(child_ids)and a.scouting_year=year),'[]'::jsonb),
 'familyMessages',coalesce((select jsonb_agg(jsonb_build_object('id',m.id,'scout_id',m.scout_id,'scouting_year',m.scouting_year,'body',m.body,'sender_role',m.sender_role,'sender_name',m.sender_name,'recorded_at',m.recorded_at,'is_mine',m.recorded_by=auth.uid(),'unread',m.recorded_by<>auth.uid()and not exists(select 1 from public.pack_family_message_reads r where r.user_id=auth.uid()and r.message_id=m.id))order by m.recorded_at,m.id)
 from public.pack_family_messages m where m.scout_id=any(child_ids)and m.scouting_year=year),'[]'::jsonb));
$$;
revoke all on function private.family_work_data(uuid[],text) from public,anon,authenticated;

-- Creation times come from original INSERT audit records, never the most recent edit.
-- Enrich only the items the established reader already authorized for this caller.
alter function public.read_pack_community(boolean) rename to read_community_before_family_attention;
alter function public.read_community_before_family_attention(boolean) set schema private;
revoke all on function private.read_community_before_family_attention(boolean) from public,anon,authenticated;
create function public.read_pack_community(as_parent boolean default false) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;part text;table_key text;
begin
 result:=private.read_community_before_family_attention(as_parent);
 foreach part in array array['events','jobs','signups'] loop
  table_key:=case part when 'events' then 'pack_events' when 'jobs' then 'pack_volunteer_jobs' else 'pack_volunteer_signups' end;
  result:=jsonb_set(result,array[part],(
   select coalesce(jsonb_agg(t.item||jsonb_build_object('created_at',coalesce(nullif(t.item->'created_at','null'::jsonb),to_jsonb((select min(l.recorded_at) from private.pack_change_log l where l.table_name=table_key and l.record_id=t.item->>'id' and l.action='INSERT')))) order by t.n),'[]'::jsonb)
   from jsonb_array_elements(coalesce(result->part,'[]'::jsonb)) with ordinality t(item,n)
  ));
 end loop;
 return result;
end;$$;
revoke all on function public.read_pack_community(boolean) from public,anon;
grant execute on function public.read_pack_community(boolean) to authenticated;

create or replace function public.read_pack_workspace(view_name text,as_parent boolean default false,scouting_year text default '2026-27')returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;unread integer;child uuid;leader boolean:=private.is_approved_leader()and not as_parent;
begin
 if view_name not in('events','calendar','images','planner','notes','history','admin','data-export')then raise exception 'Unknown workspace';end if;
 if view_name in('planner','notes','history','admin')and not leader then raise exception 'Adult leader access required'using errcode='42501';end if;
 if view_name='admin'and not private.is_pack_admin()then raise exception 'Administrator access required'using errcode='42501';end if;
 result:=public.read_pack_community(as_parent)||jsonb_build_object('year_end',coalesce((select ends_on from private.pack_year_ends where private.pack_year_ends.scouting_year=read_pack_workspace.scouting_year),make_date(left(read_pack_workspace.scouting_year,4)::int+1,6,30)),'user_id',auth.uid(),'default_den',case when leader then(select l.default_den from public.leader_access l join auth.users u on private.canonical_leader_email(l.email)=private.canonical_leader_email(u.email)where u.id=auth.uid()and l.active limit 1)else null end);
 if view_name<>'images'then result:=result||jsonb_build_object('photos','[]'::jsonb);end if;
 if view_name='planner'then
  result:=result||jsonb_build_object('activities',(select coalesce(jsonb_agg(jsonb_build_object('id',a.id,'title',a.title,'occurred_on',a.occurred_on,'event_id',a.event_id,'present',(select coalesce(jsonb_agg(atn.scout_id),'[]')from public.pack_attendance atn where atn.activity_id=a.id and atn.status='present'))order by a.occurred_on desc),'[]')from public.pack_activities a where a.scouting_year=read_pack_workspace.scouting_year));
 else result:=result||jsonb_build_object('meetings','[]'::jsonb,'progress','[]'::jsonb,'advancement','[]'::jsonb,'priorities','[]'::jsonb);end if;
 if view_name='notes'then result:=result||jsonb_build_object('notes',public.read_leader_notes());end if;
 if view_name not in('planner','data-export','history')then result:=result||jsonb_build_object('adventures','[]'::jsonb);end if;
 if as_parent then
  select count(*)::integer,(array_agg(m.scout_id order by m.recorded_at,m.id))[1] into unread,child
  from public.pack_family_messages m
  where m.scouting_year=read_pack_workspace.scouting_year and m.recorded_by<>auth.uid()
   and m.scout_id in(select (s->>'id')::uuid from jsonb_array_elements(result->'scouts')s)
   and not exists(select 1 from public.pack_family_message_reads r where r.user_id=auth.uid() and r.message_id=m.id);
  result:=result||jsonb_build_object('unread_family_messages',unread,'unread_family_message_child',child);
 end if;
 return result||jsonb_build_object('attribution',case when leader then private.pack_value_attribution(case view_name
 when 'planner'then array['pack_meeting_plans'] when 'notes'then array['pack_leader_notes'] when 'events'then array['pack_events','pack_volunteer_jobs','pack_volunteer_signups'] when 'images'then array['pack_family_photos'] when 'admin'then array['pack_retention','pack_deletion_requests','pack_scoutbook_mappings','pack_scoutbook_names']else array[]::text[]end)else '[]'::jsonb end);
end;$$;
revoke all on function public.read_pack_workspace(text,boolean,text)from public,anon;
grant execute on function public.read_pack_workspace(text,boolean,text)to authenticated;
