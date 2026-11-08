alter function public.read_pack_community(boolean)rename to read_community_before_usability;
alter function public.read_community_before_usability(boolean)set schema private;
revoke all on function private.read_community_before_usability(boolean)from public,anon,authenticated;
create function public.read_pack_community(as_parent boolean default false)returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;leader boolean:=private.is_approved_leader()and not as_parent;ids uuid[];
begin
 result:=private.read_community_before_usability(as_parent);select array_agg((x->>'id')::uuid)into ids from jsonb_array_elements(result->'scouts')x;
 result:=result||jsonb_build_object(
 'identity',(select email from auth.users where id=auth.uid()),
 'events',(select coalesce(jsonb_agg(x||jsonb_build_object('rsvp_deadline_local',(select to_char(e.rsvp_deadline at time zone e.timezone,'YYYY-MM-DD"T"HH24:MI')from public.pack_events e where e.id=(x->>'id')::uuid),'going_count',(select count(*)from public.pack_event_responses r where r.event_id=(x->>'id')::uuid and response='going'),'declined_count',(select count(*)from public.pack_event_responses r where r.event_id=(x->>'id')::uuid and response='not_going'))order by x->>'event_date'),'[]')from jsonb_array_elements(result->'events')x),
 'responses',(select coalesce(jsonb_agg(to_jsonb(r)),'[]')from public.pack_event_responses r where r.scout_id=any(ids)),
 'jobs',(select coalesce(jsonb_agg(x||jsonb_build_object('my_note',(select v.note from public.pack_volunteers v where v.job_id=(x->>'id')::uuid and private.parent_can_read_scout(v.scout_id)and(v.user_id=auth.uid()or x->>'capacity_unit'='family')limit 1),'family_commitment_count',(select count(*)from public.pack_volunteers v where v.job_id=(x->>'id')::uuid and v.scout_id=any(ids)),'can_edit_note',exists(select 1 from public.pack_volunteers v where v.job_id=(x->>'id')::uuid and private.parent_can_read_scout(v.scout_id)and(v.user_id=auth.uid()or x->>'capacity_unit'='family')),'on_waitlist',exists(select 1 from public.pack_volunteer_waitlist w where w.job_id=(x->>'id')::uuid and w.status='waiting'and(w.user_id=auth.uid()or x->>'capacity_unit'='family'and exists(select 1 from public.scouts s where private.parent_can_read_scout(s.id)and private.volunteer_family_key(s.id)=private.volunteer_family_key(w.scout_id)))),'waitlist_count',(select count(*)from public.pack_volunteer_waitlist w where w.job_id=(x->>'id')::uuid and w.status='waiting'))),'[]')from jsonb_array_elements(result->'jobs')x));
 if leader then
  result:=result||jsonb_build_object('meetings',(select coalesce(jsonb_agg(x||jsonb_build_object('created_by_name',(select coalesce(to_jsonb(u)->'raw_user_meta_data'->>'full_name',u.email)from auth.users u where u.id=(x->>'created_by')::uuid),'attendance_activity_id',(select a.id from public.pack_activities a where a.event_id=nullif(x->>'event_id','')::uuid order by scouting_year desc limit 1))),'[]')from jsonb_array_elements(result->'meetings')x),
  'volunteers',(select coalesce(jsonb_agg(jsonb_build_object('job_id',v.job_id,'scout_id',v.scout_id,'name',u.email,'note',v.note)),'[]')from public.pack_volunteers v join auth.users u on u.id=v.user_id),
  'waitlist',(select coalesce(jsonb_agg(jsonb_build_object('job_id',w.job_id,'scout_id',w.scout_id,'name',u.email,'note',w.note,'requested_at',w.requested_at)order by w.requested_at),'[]')from public.pack_volunteer_waitlist w join auth.users u on u.id=w.user_id where w.status='waiting'));
 end if;return result;
end;$$;
revoke all on function public.read_pack_community(boolean)from public,anon;
grant execute on function public.read_pack_community(boolean)to authenticated;

create or replace function public.read_pack_workspace(view_name text,as_parent boolean default false,scouting_year text default '2026-27')returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;leader boolean:=private.is_approved_leader()and not as_parent;
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
 return result||jsonb_build_object('attribution',case when leader then private.pack_value_attribution(case view_name
 when 'planner'then array['pack_meeting_plans'] when 'notes'then array['pack_leader_notes'] when 'events'then array['pack_events','pack_volunteer_jobs','pack_volunteer_signups'] when 'images'then array['pack_family_photos'] when 'admin'then array['pack_retention','pack_deletion_requests','pack_scoutbook_mappings','pack_scoutbook_names']else array[]::text[]end)else '[]'::jsonb end);
end;$$;
revoke all on function public.read_pack_workspace(text,boolean,text)from public,anon;
grant execute on function public.read_pack_workspace(text,boolean,text)to authenticated;



create function public.read_parent_dashboard(scouting_year text default '2026-27')returns jsonb language plpgsql stable security definer set search_path='' as $$
declare ids uuid[];result jsonb;
begin
 if not private.has_accepted_site_policies()then raise exception 'Accept the current policies first'using errcode='42501';end if;
 select coalesce(array_agg(s.id),array[]::uuid[])into ids from public.scouts s where private.parent_can_read_scout(s.id);
 result:=private.parent_portal_projection(ids,scouting_year);
 return result||jsonb_build_object('registration_reports',(select coalesce(jsonb_agg(to_jsonb(r)),'[]')from public.pack_registration_reports r where r.scout_id=any(ids)and r.scouting_year=read_parent_dashboard.scouting_year),'participation',case when cardinality(ids)>0 then public.read_pack_workspace('events',true,scouting_year)else jsonb_build_object('scouts','[]'::jsonb,'events','[]'::jsonb,'jobs','[]'::jsonb,'bookings','[]'::jsonb,'signups','[]'::jsonb)end);
end;$$;
revoke all on function public.read_parent_dashboard(text)from public,anon;
grant execute on function public.read_parent_dashboard(text)to authenticated;
create function public.read_parent_preview_scope(scouting_year text default '2026-27',den_filter text default null,child uuid default null)returns jsonb language plpgsql stable security definer set search_path='' as $$
#variable_conflict use_variable
declare ids uuid[];result jsonb;community jsonb;events jsonb;jobs jsonb;
begin
 if not private.is_pack_admin()then raise exception 'Administrator access required'using errcode='42501';end if;
 select coalesce(array_agg(s.id),array[]::uuid[])into ids from public.scouts s where coalesce(s.den,'')!~*'^\s*\(withdraw\)'and(den_filter is null or s.den=den_filter)and(child is null or s.id=child);
 result:=private.parent_portal_projection(ids,scouting_year);community:=public.read_pack_community(false);
 select coalesce(jsonb_agg(e),'[]')into events from jsonb_array_elements(community->'events')e where e->>'den'is null or exists(select 1 from public.scouts s where s.id=any(ids)and s.den=e->>'den');
 select coalesce(jsonb_agg(j||jsonb_build_object('mine',exists(select 1 from public.pack_volunteers v where v.job_id=(j->>'id')::uuid and v.scout_id=any(ids)),'my_note',null,'can_edit_note',false,'family_commitment_count',(select count(*)from public.pack_volunteers v where v.job_id=(j->>'id')::uuid and v.scout_id=any(ids)),'on_waitlist',false)),'[]')into jobs from jsonb_array_elements(community->'jobs')j where j->>'event_id'is null or exists(select 1 from jsonb_array_elements(events)e where e->>'id'=j->>'event_id');
 return result||jsonb_build_object('preview_scope',coalesce((select s.scout_name from public.scouts s where s.id=child),den_filter,'Pack'),'registration_reports',(select coalesce(jsonb_agg(to_jsonb(r)),'[]')from public.pack_registration_reports r where r.scout_id=any(ids)and r.scouting_year=scouting_year),'participation',jsonb_build_object('scouts',result->'scouts','events',events,'jobs',jobs,'signups',(select coalesce(jsonb_agg(g),'[]')from jsonb_array_elements(community->'signups')g where exists(select 1 from jsonb_array_elements(jobs)j where j->>'signup_id'=g->>'id')),'bookings',(select coalesce(jsonb_agg(to_jsonb(b)),'[]')from public.pack_event_bookings b where b.scout_id=any(ids))));
end;$$;
revoke all on function public.read_parent_preview_scope(text,text,uuid)from public,anon;
grant execute on function public.read_parent_preview_scope(text,text,uuid)to authenticated;

-- A generated package has the same authorization/expiry rules as before, including new scoped data.
alter function public.prepare_pack_export(uuid,uuid[],text)rename to prepare_export_before_usability;
alter function public.prepare_export_before_usability(uuid,uuid[],text)set schema private;
revoke all on function private.prepare_export_before_usability(uuid,uuid[],text)from public,anon,authenticated;
create function public.prepare_pack_export(request_id uuid,children uuid[]default null,export_kind text default 'family')returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;ids uuid[];
begin
 result:=private.prepare_export_before_usability(request_id,children,export_kind);select array_agg((s->>'id')::uuid)into ids from jsonb_array_elements(result->'scouts')s;
 update private.pack_email_outbox set child_ids=ids where dedupe_key='parent-export:'||request_id;
 return result||jsonb_build_object('waitlist',(select coalesce(jsonb_agg(to_jsonb(w)),'[]')from public.pack_volunteer_waitlist w where w.scout_id=any(ids)),'event_responses',(select coalesce(jsonb_agg(to_jsonb(r)),'[]')from public.pack_event_responses r where r.scout_id=any(ids)),'registration_reports',(select coalesce(jsonb_agg(to_jsonb(r)),'[]')from public.pack_registration_reports r where r.scout_id=any(ids)));
end;$$;
revoke all on function public.prepare_pack_export(uuid,uuid[],text)from public,anon;
grant execute on function public.prepare_pack_export(uuid,uuid[],text)to authenticated;

-- Task destinations survive sign-in; tokens never grant access to the target child/item.
alter function public.parent_email_context(uuid)rename to parent_context_before_tasks;
alter function public.parent_context_before_tasks(uuid)set schema private;
revoke all on function private.parent_context_before_tasks(uuid)from public,anon,authenticated;
create function public.parent_email_context(email_id uuid)returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;q private.pack_email_outbox;destination text;kind text;task_year text;volunteer_job uuid;
begin
 result:=private.parent_context_before_tasks(email_id);select * into q from private.pack_email_outbox where id=email_id;kind:=split_part(q.dedupe_key,':',1);
 if q.scout_id is not null and kind in('homework','message','earned','badge')then
  destination:='https://legacy.packpilot.example/parents?child='||q.scout_id||'&section='||case when kind='homework'then 'homework'when kind='message'then 'messages'else 'progress'end;
  if kind in('homework','message')then destination:=destination||'&item='||case when kind='homework'then 'assignment-'else 'message-'end||split_part(q.dedupe_key,':',2);else destination:=destination||'&item=adventure-'||split_part(q.dedupe_key,':',3);end if;
  if kind='homework'then select scouting_year into task_year from public.pack_home_assignments where id=split_part(q.dedupe_key,':',2)::uuid;
  elsif kind='message'then select scouting_year into task_year from public.pack_family_messages where id=split_part(q.dedupe_key,':',2)::uuid;
  else task_year:=split_part(q.dedupe_key,':',4);end if;
  if private.program_year_valid(task_year)then destination:=destination||'&year='||task_year;end if;
  result:=jsonb_set(result,'{links,portal}',to_jsonb(destination));update private.pack_email_outbox set content=jsonb_set(content,'{links,portal}',to_jsonb(destination))where id=email_id;
 elsif kind in('volunteer-reminder','volunteer-promoted')then
  if kind='volunteer-reminder'then volunteer_job:=split_part(q.dedupe_key,':',2)::uuid;
  else select job_id into volunteer_job from public.pack_volunteer_waitlist where id=split_part(q.dedupe_key,':',2)::uuid;end if;
  if volunteer_job is not null then
   destination:='https://legacy.packpilot.example/events?parent=1&job='||volunteer_job;
   result:=jsonb_set(result,'{links,portal}',to_jsonb(destination));update private.pack_email_outbox set content=jsonb_set(content,'{links,portal}',to_jsonb(destination))where id=email_id;
  end if;
 end if;return result;
end;$$;
revoke all on function public.parent_email_context(uuid)from public,anon,authenticated;
grant execute on function public.parent_email_context(uuid)to service_role;

-- Extend the existing confirmed parent-exclusion workflow to the new personal entries.
-- Full scout removal already cascades the three new child-owned tables.
alter function public.record_pack_admin(uuid,jsonb)rename to record_admin_before_usability;
alter function public.record_admin_before_usability(uuid,jsonb)set schema private;
revoke all on function private.record_admin_before_usability(uuid,jsonb)from public,anon,authenticated;
create function public.record_pack_admin(request_id uuid,command jsonb)returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;child uuid;actors uuid[];jobs uuid[];
begin
 if not private.is_pack_admin()then raise exception 'Administrator access required'using errcode='42501';end if;
 if command->>'action'='exclude_parent'then
  child:=(command->>'scout_id')::uuid;
  select array_agg(claimed_user_id)into actors from public.parent_scout_links where scout_id=child and lower(btrim(parent_email))=lower(btrim(command->>'email'));
  select array_agg(job_id)into jobs from public.pack_volunteers where scout_id=child and user_id=any(actors);
 end if;
 result:=private.record_admin_before_usability(request_id,command);
 if command->>'action'='exclude_parent'and cardinality(actors)>0 then
  perform set_config('pack.privacy_erasure','on',true);
  delete from public.pack_volunteer_waitlist where scout_id=child and user_id=any(actors);
  delete from public.pack_registration_reports where scout_id=child and reported_by=any(actors);
  delete from public.pack_event_responses where scout_id=child and recorded_by=any(actors);
  update public.pack_volunteers set note=''where scout_id=child and user_id=any(actors);
  delete from public.pack_community_commands c where c.recorded_by=any(actors)and(c.command->>'scout_id'=child::text or c.command->>'action'='volunteer_note'and(c.command->>'id')::uuid=any(jobs));
  perform set_config('pack.privacy_erasure','off',true);
 end if;
 return result;
end;$$;
revoke all on function public.record_pack_admin(uuid,jsonb)from public,anon;
grant execute on function public.record_pack_admin(uuid,jsonb)to authenticated;
