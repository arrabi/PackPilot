create function private.program_year_valid(y text)returns boolean language sql immutable set search_path='' as $$select case when y~'^[0-9]{4}-[0-9]{2}$'then right(y,2)=right((left(y,4)::int+1)::text,2)else false end$$;
revoke all on function private.program_year_valid(text)from public,anon,authenticated;
-- Public event logistics remain separate from internal leader plans.
alter table public.pack_events add column start_time time;
alter table public.pack_events add column end_time time;
alter table public.pack_events add column end_date date;
alter table public.pack_events add column timezone text not null default 'America/Los_Angeles';
alter table public.pack_events add column rsvp_deadline timestamptz;
alter table public.pack_activities add column event_id uuid references public.pack_events(id);
create unique index attendance_event_year on public.pack_activities(event_id,scouting_year)where event_id is not null;
create table public.pack_event_responses(event_id uuid not null references public.pack_events(id),scout_id uuid not null references public.scouts(id)on delete cascade,response text not null check(response in('going','not_going')),recorded_by uuid not null,recorded_at timestamptz not null default now(),primary key(event_id,scout_id));
insert into public.pack_event_responses select event_id,scout_id,'going',recorded_by,now()from public.pack_event_bookings;
create table public.pack_registration_reports(scout_id uuid not null references public.scouts(id)on delete cascade,scouting_year text not null,platform text not null check(platform in('active.com','scouting.org')),reported_by uuid not null,reported_at timestamptz not null default now(),primary key(scout_id,scouting_year,platform));
alter table public.pack_event_responses enable row level security;
alter table public.pack_registration_reports enable row level security;
revoke all on public.pack_event_responses,public.pack_registration_reports from public,anon,authenticated;
create trigger pack_audit after insert or update or delete on public.pack_event_responses for each row execute function private.capture_pack_change();
create trigger pack_audit after insert or update or delete on public.pack_registration_reports for each row execute function private.capture_pack_change();
create function public.read_pack_registration_reports(scouting_year text)returns jsonb language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(to_jsonb(r)),'[]')from public.pack_registration_reports r where r.scouting_year=read_pack_registration_reports.scouting_year and(private.is_approved_leader()or private.parent_can_read_scout(r.scout_id));
$$;
revoke all on function public.read_pack_registration_reports(text)from public,anon;
grant execute on function public.read_pack_registration_reports(text)to authenticated;

alter function public.record_pack_community(uuid,jsonb)rename to record_community_before_event_flow;
alter function public.record_community_before_event_flow(uuid,jsonb)set schema private;
revoke all on function private.record_community_before_event_flow(uuid,jsonb)from public,anon,authenticated;
create function public.record_pack_community(request_id uuid,command jsonb)returns void language plpgsql security definer set search_path='' set statement_timeout='20s' as $$
#variable_conflict use_variable
declare action text:=command->>'action';target uuid:=(command->>'id')::uuid;prior public.pack_community_commands;e public.pack_events;m public.pack_meeting_plans;effective jsonb:=command;zone text;start_time time;end_time time;ending date;deadline timestamptz;req jsonb;child uuid;selected uuid[];actor uuid:=auth.uid();
begin
 if action is null or not(action in('event','rsvp','registration_report')or(action='meeting'and command?'public_title')or(action='finish_meeting'and command?'completed_requirements'))then perform private.record_community_before_event_flow(request_id,command);return;end if;
 if not private.is_approved_leader()and not exists(select 1 from public.scouts s where private.parent_can_read_scout(s.id))then raise exception 'Authorized account required'using errcode='42501';end if;
 if request_id is null or target is null or jsonb_typeof(command)is distinct from 'object'or length(command::text)>100000 then raise exception 'Invalid command';end if;
 perform pg_advisory_xact_lock(hashtextextended('community-request:'||request_id::text,0));
 select * into prior from public.pack_community_commands c where c.request_id=request_id;
 if found then if prior.recorded_by<>actor or prior.command<>command then raise exception 'Request ID conflict';end if;return;end if;
 if action in('event','meeting','finish_meeting')and not private.can_record()then raise exception 'Leader recording access required'using errcode='42501';end if;
 if action='event'then
  if exists(select 1 from public.pack_events old_event join public.pack_activities a on a.event_id=old_event.id where old_event.id=target and old_event.event_date is distinct from(command->>'date')::date and exists(select 1 from public.pack_attendance atn where atn.activity_id=a.id))then raise exception 'This event has attendance. Preserve its date and create a new event to reschedule.';end if;
  select * into e from public.pack_events where id=target;
  zone:=coalesce(nullif(command->>'timezone',''),e.timezone,'America/Los_Angeles');
  if not exists(select 1 from pg_catalog.pg_timezone_names where name=zone)then raise exception 'Choose a valid timezone';end if;
  start_time:=case when command?'start_time'then nullif(command->>'start_time','')::time else e.start_time end;end_time:=case when command?'end_time'then nullif(command->>'end_time','')::time else e.end_time end;ending:=coalesce(case when command?'end_date'then nullif(command->>'end_date','')::date else e.end_date end,(command->>'date')::date);
  if ending<(command->>'date')::date or ending>(command->>'date')::date+365 or(end_time is not null and(start_time is null or ending=(command->>'date')::date and end_time<=start_time))then raise exception 'Event end must follow its start';end if;
  deadline:=case when command?'rsvp_deadline_local'then nullif(command->>'rsvp_deadline_local','')::timestamp at time zone zone else e.rsvp_deadline end;
  if command?'rsvp_deadline_local'and deadline is not null and deadline at time zone zone is distinct from(command->>'rsvp_deadline_local')::timestamp then raise exception 'That local time does not exist in this timezone';end if;
  if deadline is not null and deadline>((command->>'date')::date+coalesce(start_time,time '23:59:59'))at time zone zone then raise exception 'RSVP deadline must be before the event starts';end if;
  perform private.record_community_before_event_flow(request_id,command);
  update public.pack_events set start_time=start_time,end_time=end_time,end_date=case when ending=(command->>'date')::date then null else ending end,timezone=zone,rsvp_deadline=deadline where id=target;
 elsif action='rsvp'then
  select * into e from public.pack_events where id=target;
  if not found then raise exception 'Event unavailable';end if;
  if jsonb_array_length(coalesce(command->'scouts','[]'))>0 and e.rsvp_deadline is not null and now()>e.rsvp_deadline then raise exception 'RSVP deadline has passed. You can still cancel your reservation.';end if;
  if command?'response'and command->>'response'not in('going','not_going')then raise exception 'Choose Going or Not going';end if;
  if command->>'response'='going'and jsonb_array_length(command->'scouts')=0 then raise exception 'Select at least one scout who is going';end if;
  if command->>'response'='not_going'and(jsonb_array_length(command->'scouts')<>0 or coalesce((command->>'others')::int,0)<>0)then raise exception 'Not going cannot include attendees';end if;
  perform private.record_community_before_event_flow(request_id,command);
  delete from public.pack_event_responses r where r.event_id=target and private.parent_can_read_scout(r.scout_id);
  insert into public.pack_event_responses(event_id,scout_id,response,recorded_by)
   select target,s.id,case when exists(select 1 from jsonb_array_elements_text(command->'scouts')x where x=s.id::text)then 'going'else 'not_going'end,actor
   from public.scouts s where private.parent_can_read_scout(s.id)and(e.den is null or e.den=s.den)and(command?'response'or exists(select 1 from jsonb_array_elements_text(command->'scouts')x where x=s.id::text));
 elsif action='registration_report'then
  if not private.parent_can_read_scout(target)then raise exception 'Family access denied'using errcode='42501';end if;
  if not private.program_year_valid(command->>'year')or command->>'platform'not in('active.com','scouting.org')then raise exception 'Choose a valid registration';end if;
  if exists(select 1 from public.pack_registrations where scout_id=target and scouting_year=command->>'year'and platform=command->>'platform'and status='confirmed')then raise exception 'Registration is already verified; refresh your family records';end if;
  insert into public.pack_registration_reports values(target,command->>'year',command->>'platform',actor,now())on conflict(scout_id,scouting_year,platform)do update set reported_by=actor,reported_at=now();
  perform private.queue_pack_admin_email('registration-report:'||request_id,'PackPilot: registration verification requested','A parent reported that '||(command->>'platform')||' registration was submitted for '||(select scout_name from public.scouts where id=target)||'. Review the record: https://legacy.packpilot.example/?year='||(command->>'year')||'#scout/'||target||'/registration');
  update private.pack_email_outbox set scout_id=target,child_ids=array[target]where dedupe_key='registration-report:'||request_id;
  insert into public.pack_community_commands values(request_id,command,actor,now());
 elsif action='meeting'then
  if not private.program_year_valid(command->>'year')or(command->>'date')::date<make_date(left(command->>'year',4)::int,7,1)or(command->>'date')::date>coalesce((select ends_on from private.pack_year_ends where scouting_year=command->>'year'),make_date(left(command->>'year',4)::int+1,6,30))then raise exception 'Choose a meeting date in the selected program year';end if;
  if nullif(command->>'event_id','')is null and nullif(btrim(command->>'public_title'),'')is not null then
   e.id:=md5(request_id::text||':meeting-event')::uuid;
   insert into public.pack_events(id,title,event_date,den,details,rsvp_mode,event_type,created_by)values(e.id,btrim(command->>'public_title'),(command->>'date')::date,nullif(command->>'den',''),coalesce(command->>'public_details',''),'none',case when nullif(command->>'den','')is null then 'pack_meeting'else 'den_meeting'end,actor);
   effective:=command||jsonb_build_object('event_id',e.id);
  end if;
  perform private.record_community_before_event_flow(request_id,effective);
  update public.pack_community_commands c set command=command where c.request_id=request_id;
 elsif action='finish_meeting'then
  select * into m from public.pack_meeting_plans where id=target for update;
  if not found or m.revision is distinct from(command->>'revision')::int then raise exception 'Meeting changed; refresh and review';end if;
  if m.den is null or m.meeting_date>(now()at time zone 'America/Los_Angeles')::date or not exists(select 1 from public.pack_activities a where a.id=(command->>'activity_id')::uuid and a.occurred_on=m.meeting_date and a.scouting_year=command->>'year'and(m.event_id is null or a.event_id=m.event_id))then raise exception 'Choose matching dated attendance for this meeting';end if;
  if jsonb_typeof(command->'completed_requirements')is distinct from 'array'or jsonb_array_length(command->'completed_requirements')not between 1 and 30 then raise exception 'Select the requirements actually completed';end if;
  if exists(select 1 from jsonb_array_elements(command->'completed_requirements')r where not m.requirements @>jsonb_build_array(r))then raise exception 'Review only requirements from this plan';end if;
  select array_agg(value::uuid)into selected from jsonb_array_elements_text(command->'scouts');
  if coalesce(cardinality(selected),0)=0 or exists(select 1 from unnest(selected)c where not exists(select 1 from public.pack_attendance a join public.scouts s on s.id=a.scout_id where a.activity_id=(command->>'activity_id')::uuid and a.status='present'and s.id=c and s.den=m.den and coalesce(s.den,'')!~*'^\s*\(withdraw\)'))then raise exception 'Choose present scouts in the meeting den';end if;
  for child in select distinct unnest(selected)order by 1 loop
   perform 1 from public.scouts where id=child for update;
   for req in select * from jsonb_array_elements(command->'completed_requirements')loop
    if not exists(select 1 from public.pack_requirement_progress p where p.scout_id=child and p.adventure_id=(req->>'adventure_id')::uuid and p.scouting_year=command->>'year'and p.requirement_code=req->>'code')and not exists(select 1 from public.pack_advancement v where v.scout_id=child and v.adventure_id=(req->>'adventure_id')::uuid and v.scouting_year=command->>'year'and v.earned_on is not null)then
     perform public.record_pack_operation(gen_random_uuid(),jsonb_build_object('action','record_requirement','scout_id',child,'adventure_id',req->>'adventure_id','scouting_year',command->>'year','expected_revision',coalesce((select revision from public.pack_advancement where scout_id=child and adventure_id=(req->>'adventure_id')::uuid and scouting_year=command->>'year'),0),'occurred_on',m.meeting_date,'requirement_code',req->>'code','status','completed'));
    end if;
   end loop;
  end loop;
  insert into public.pack_community_commands values(request_id,command,actor,now());
 end if;
end;$$;
revoke all on function public.record_pack_community(uuid,jsonb)from public,anon;
grant execute on function public.record_pack_community(uuid,jsonb)to authenticated;

create function public.prepare_meeting_attendance(request_id uuid,event uuid,scouting_year text)returns jsonb language plpgsql security definer set search_path='' as $$
#variable_conflict use_variable
declare e public.pack_events;activity uuid;command jsonb:=jsonb_build_object('action','prepare_meeting_attendance','id',event,'year',scouting_year);prior public.pack_community_commands;
begin
 if not private.can_record()then raise exception 'Leader recording access required'using errcode='42501';end if;
 if request_id is null or event is null then raise exception 'Choose a meeting';end if;
 perform pg_advisory_xact_lock(hashtextextended('community-request:'||request_id::text,0));
 select * into prior from public.pack_community_commands c where c.request_id=request_id;
 if found and(prior.recorded_by<>auth.uid()or prior.command<>command)then raise exception 'Request ID conflict';end if;
 perform pg_advisory_xact_lock(hashtextextended('meeting-attendance:'||event::text||':'||scouting_year,0));
 select * into e from public.pack_events where id=event;
 if not found or e.cancelled or e.event_date>(now()at time zone 'America/Los_Angeles')::date or not private.program_year_valid(scouting_year)or e.event_date<make_date(left(scouting_year,4)::int,7,1)or e.event_date>coalesce((select ends_on from private.pack_year_ends where pack_year_ends.scouting_year=prepare_meeting_attendance.scouting_year),make_date(left(scouting_year,4)::int+1,6,30))then raise exception 'Choose a past or current meeting in the selected year';end if;
 select id into activity from public.pack_activities a where a.event_id=event and a.scouting_year=scouting_year;
 if activity is null then activity:=gen_random_uuid();insert into public.pack_activities(id,title,kind,occurred_on,scouting_year,event_id,recorded_by)values(activity,e.title,case when e.event_type='outing'then 'hike'else 'session'end,e.event_date,scouting_year,event,auth.uid());end if;
 if prior.request_id is null then insert into public.pack_community_commands values(request_id,command,auth.uid(),now());end if;
 return jsonb_build_object('activity_id',activity,'event_id',event,'den',e.den,'scouting_year',scouting_year);
end;$$;
revoke all on function public.prepare_meeting_attendance(uuid,uuid,text)from public,anon;
grant execute on function public.prepare_meeting_attendance(uuid,uuid,text)to authenticated;
