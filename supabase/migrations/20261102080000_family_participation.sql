-- All community mutations use audited RPCs; client roles have no direct table access.
create table public.pack_events (
 id uuid primary key, title text not null check(length(btrim(title)) between 1 and 200),
 event_date date not null, den text, details text not null default '' check(length(details)<=4000),
 rsvp_mode text not null check(rsvp_mode in('none','unlimited','scouts','attendees')),
 capacity integer check(capacity between 1 and 10000), cancelled boolean not null default false,
 revision integer not null default 1, created_by uuid not null,
 check((rsvp_mode in('scouts','attendees'))=(capacity is not null))
);
create table public.pack_event_bookings (
 event_id uuid not null references public.pack_events(id), scout_id uuid not null references public.scouts(id),
 others integer not null default 0 check(others between 0 and 100), recorded_by uuid not null,
 primary key(event_id,scout_id)
);
create table public.pack_volunteer_jobs (
 id uuid primary key, event_id uuid references public.pack_events(id), title text not null check(length(btrim(title)) between 1 and 200),
 details text not null default '' check(length(details)<=4000), capacity integer check(capacity between 1 and 10000),
 closed boolean not null default false, created_by uuid not null
);
create table public.pack_volunteers (
 job_id uuid not null references public.pack_volunteer_jobs(id), user_id uuid not null references auth.users(id),
 scout_id uuid not null references public.scouts(id), primary key(job_id,user_id)
);
create table public.pack_meeting_plans (
 id uuid primary key, meeting_date date not null, den text,
 pack_activity text not null default '' check(length(pack_activity)<=2000),
 agenda text not null default '' check(length(agenda)<=4000), supplies text not null default '' check(length(supplies)<=4000),
 requirements jsonb not null default '[]' check(jsonb_typeof(requirements)='array'),
 revision integer not null default 1, recorded_by uuid not null
);
create unique index meeting_plan_scope on public.pack_meeting_plans(meeting_date,coalesce(den,''));
create table public.pack_family_photos (
 scout_id uuid not null references public.scouts(id), kind text not null check(kind in('scout','family')),
 image text not null check(image ~ '^data:image/jpeg;base64,[A-Za-z0-9+/=]+$' and length(image)<=180000),
 recorded_by uuid not null references auth.users(id), primary key(scout_id,kind)
);
create table public.pack_community_commands (
 request_id uuid primary key, command jsonb not null, recorded_by uuid not null, recorded_at timestamptz not null default now()
);
do $$ declare t text; begin foreach t in array array['pack_events','pack_event_bookings','pack_volunteer_jobs','pack_volunteers','pack_meeting_plans','pack_family_photos','pack_community_commands'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from public,anon,authenticated',t);
end loop; end $$;

create function private.community_visible(event public.pack_events) returns boolean
language sql stable security definer set search_path='' as $$
 select private.is_approved_leader() or exists(select 1 from public.scouts s where private.parent_can_read_scout(s.id) and (event.den is null or event.den=s.den));
$$;
revoke all on function private.community_visible(public.pack_events) from public,anon,authenticated;

create function public.read_pack_community(as_parent boolean default false) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare leader boolean:=private.is_approved_leader() and not as_parent; ids uuid[];
begin
 select coalesce(array_agg(s.id),array[]::uuid[]) into ids from public.scouts s where coalesce(s.den,'') !~* '^\s*\(withdraw\)' and (leader or private.parent_can_read_scout(s.id));
 if cardinality(ids)=0 and not leader then raise exception 'Family access denied' using errcode='42501'; end if;
 return jsonb_build_object('leader',leader,'can_record',private.can_record() and not as_parent,
 'scouts',(select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'name',s.scout_name,'den',s.den)order by s.scout_name),'[]')from public.scouts s where s.id=any(ids)),
 'events',(select coalesce(jsonb_agg(to_jsonb(e)||jsonb_build_object('used',coalesce((select sum(1+case when e.rsvp_mode='attendees' then b.others else 0 end)from public.pack_event_bookings b where b.event_id=e.id),0))order by e.event_date,e.title),'[]')from public.pack_events e where private.community_visible(e) and (leader or e.den is null or exists(select 1 from public.scouts s where s.id=any(ids) and s.den=e.den))),
 'bookings',(select coalesce(jsonb_agg(to_jsonb(b)),'[]')from public.pack_event_bookings b join public.pack_events e on e.id=b.event_id where private.community_visible(e) and (leader or b.scout_id=any(ids))),
 'jobs',(select coalesce(jsonb_agg(to_jsonb(j)||jsonb_build_object('used',(select count(*)from public.pack_volunteers v where v.job_id=j.id),'mine',exists(select 1 from public.pack_volunteers v where v.job_id=j.id and v.user_id=auth.uid()))order by j.title),'[]')from public.pack_volunteer_jobs j where j.event_id is null or exists(select 1 from public.pack_events e where e.id=j.event_id and private.community_visible(e) and (leader or e.den is null or exists(select 1 from public.scouts s where s.id=any(ids) and s.den=e.den)))),
 'volunteers',case when leader then (select coalesce(jsonb_agg(jsonb_build_object('job_id',v.job_id,'scout_id',v.scout_id,'name',u.email)),'[]')from public.pack_volunteers v join auth.users u on u.id=v.user_id) else '[]'::jsonb end,
 'meetings',(select coalesce(jsonb_agg(to_jsonb(m)order by m.meeting_date,m.den nulls first),'[]')from public.pack_meeting_plans m where leader or m.den is null or exists(select 1 from public.scouts s where s.id=any(ids)and s.den=m.den)),
 'photos',(select coalesce(jsonb_agg(to_jsonb(p)),'[]')from public.pack_family_photos p where p.scout_id=any(ids)),
 'adventures',case when leader then (select coalesce(jsonb_agg(jsonb_build_object('id',a.id,'name',a.name,'rank',a.rank,'requirements',a.requirements)),'[]')from public.pack_adventures a)else '[]'::jsonb end);
end;$$;
revoke all on function public.read_pack_community(boolean) from public,anon;
grant execute on function public.read_pack_community(boolean) to authenticated;

create function public.record_pack_community(request_id uuid,command jsonb) returns void
language plpgsql security definer set search_path='' set statement_timeout='10s' as $$
#variable_conflict use_variable
declare actor uuid:=auth.uid(); a text:=command->>'action'; target uuid:=(command->>'id')::uuid;
 prev public.pack_community_commands; e public.pack_events; j public.pack_volunteer_jobs; child uuid; used integer; n integer; req jsonb; m public.pack_meeting_plans;
begin
 if actor is null or not exists(select 1 from auth.users u where u.id=actor and u.email_confirmed_at is not null)then raise exception 'Verified account required' using errcode='42501';end if;
 if request_id is null or target is null or command is null or jsonb_typeof(command)<>'object' or length(command::text)>200000 then raise exception 'Invalid command';end if;
 perform pg_advisory_xact_lock(hashtextextended('community-request:'||request_id::text,0));
 select * into prev from public.pack_community_commands c where c.request_id=request_id;
 if found then if prev.recorded_by<>actor or prev.command<>(case when a='photo' then (command-'image')||jsonb_build_object('image_hash',md5(coalesce(command->>'image',''))) else command end) then raise exception 'Request ID conflict';end if;return;end if;
 if a in('event','job','close_job','meeting','finish_meeting')and not private.can_record()then raise exception 'Leader recording access denied'using errcode='42501';end if;
 if a='event'then
  perform pg_advisory_xact_lock(hashtextextended('event:'||target::text,0));
  select * into e from public.pack_events where id=target for update;
  if coalesce(e.revision,0)<>coalesce((command->>'revision')::int,0)then raise exception 'Event changed; refresh';end if;
  n:=nullif(command->>'capacity','')::int;
  if command->>'mode' in('scouts','attendees')and (n is null or n<1)then raise exception 'Capacity required';end if;
  select coalesce(sum(1+case when command->>'mode'='attendees'then b.others else 0 end),0)into used from public.pack_event_bookings b where b.event_id=target;
  if (n is not null and used>n)or(command->>'mode'='none'and used>0)then raise exception 'Existing reservations exceed this limit';end if;
  if nullif(command->>'den','')is not null and command->>'den'not in('0-Lions','1-Tigers','2-Wolves','3-Bears','4-Webelos','5-AOL')then raise exception 'Invalid den';end if;
  if exists(select 1 from public.pack_event_bookings b join public.scouts s on s.id=b.scout_id where b.event_id=target and nullif(command->>'den','')is not null and s.den<>command->>'den')then raise exception 'Existing reservations outside selected den';end if;
  insert into public.pack_events(id,title,event_date,den,details,rsvp_mode,capacity,cancelled,created_by)
  values(target,command->>'title',(command->>'date')::date,nullif(command->>'den',''),coalesce(command->>'details',''),command->>'mode',n,coalesce((command->>'cancelled')::boolean,false),actor)
  on conflict(id)do update set title=excluded.title,event_date=excluded.event_date,den=excluded.den,details=excluded.details,rsvp_mode=excluded.rsvp_mode,capacity=excluded.capacity,cancelled=excluded.cancelled,revision=pack_events.revision+1;
 elsif a='rsvp'then
  perform pg_advisory_xact_lock(hashtextextended('event:'||target::text,0));
  select * into e from public.pack_events where id=target for update;
  if not found or not private.community_visible(e)then raise exception 'Event access denied'using errcode='42501';end if;
  if e.cancelled or e.rsvp_mode='none' or e.event_date<(now()at time zone 'America/Los_Angeles')::date then raise exception 'RSVP is closed';end if;
  if jsonb_typeof(command->'scouts')is distinct from 'array'or jsonb_array_length(command->'scouts')>20 then raise exception 'Select attending scouts';end if;
  -- One reservation per child, shared by both authorized parents. Replace only this family's choices.
  delete from public.pack_event_bookings b where b.event_id=target and private.parent_can_read_scout(b.scout_id);
  n:=coalesce((command->>'others')::int,0);
  if n<0 or n>100 or(e.rsvp_mode<>'attendees'and n<>0)then raise exception 'Invalid other attendee count';end if;
  if n>0 and jsonb_array_length(command->'scouts')=0 then raise exception 'Select a scout for the family booking';end if;
  for child in select distinct value::uuid from jsonb_array_elements_text(command->'scouts') loop
   if not private.parent_can_read_scout(child)or not exists(select 1 from public.scouts s where s.id=child and(e.den is null or s.den=e.den))then raise exception 'Child access denied'using errcode='42501';end if;
   insert into public.pack_event_bookings values(target,child,n,actor);n:=0;
  end loop;
  select coalesce(sum(1+case when e.rsvp_mode='attendees'then b.others else 0 end),0)into used from public.pack_event_bookings b where b.event_id=target;
  if e.capacity is not null and used>e.capacity then raise exception 'Not enough places remaining';end if;
 elsif a='job'then
  if nullif(command->>'event_id','')is not null and not exists(select 1 from public.pack_events where id=(command->>'event_id')::uuid and not cancelled)then raise exception 'Choose an active event';end if;
  insert into public.pack_volunteer_jobs(id,event_id,title,details,capacity,created_by)values(target,nullif(command->>'event_id','')::uuid,command->>'title',coalesce(command->>'details',''),nullif(command->>'capacity','')::int,actor);
 elsif a='close_job'then
  update public.pack_volunteer_jobs set closed=true where id=target;
 elsif a='volunteer'then
  perform pg_advisory_xact_lock(hashtextextended('job:'||target::text,0));
  select * into j from public.pack_volunteer_jobs where id=target for update;
  if not found then raise exception 'Job not found';end if;
  if not exists(select 1 from public.scouts s where private.parent_can_read_scout(s.id))then raise exception 'Family access denied'using errcode='42501';end if;
  if coalesce((command->>'join')::boolean,false)then
   if j.closed or(j.event_id is not null and not exists(select 1 from public.pack_events e where e.id=j.event_id and not e.cancelled and private.community_visible(e)and e.event_date>=(now()at time zone 'America/Los_Angeles')::date))then raise exception 'Signup closed';end if;
   child:=(command->>'scout_id')::uuid;
   if not private.parent_can_read_scout(child)then raise exception 'Child access denied'using errcode='42501';end if;
   insert into public.pack_volunteers values(target,actor,child)on conflict do nothing;
   if j.capacity is not null and(select count(*)from public.pack_volunteers where job_id=target)>j.capacity then raise exception 'Volunteer role is full';end if;
  else delete from public.pack_volunteers where job_id=target and user_id=actor;end if;
 elsif a='photo'then
  child:=target;
  if not private.parent_can_read_scout(child)then raise exception 'Family access denied'using errcode='42501';end if;
  if command->>'kind'not in('scout','family')then raise exception 'Invalid photo kind';end if;
  if coalesce(command->>'image','')=''then delete from public.pack_family_photos where scout_id=child and kind=command->>'kind';
  else insert into public.pack_family_photos values(child,command->>'kind',command->>'image',actor)on conflict(scout_id,kind)do update set image=excluded.image,recorded_by=actor;end if;
 elsif a='meeting'then
  perform pg_advisory_xact_lock(hashtextextended('meeting:'||target::text,0));
  select * into m from public.pack_meeting_plans where id=target for update;
  if coalesce(m.revision,0)<>coalesce((command->>'revision')::int,0)then raise exception 'Meeting changed; refresh';end if;
  if nullif(command->>'den','')is not null and command->>'den'not in('0-Lions','1-Tigers','2-Wolves','3-Bears','4-Webelos','5-AOL')then raise exception 'Invalid den';end if;
  if jsonb_typeof(command->'requirements')is distinct from 'array'or jsonb_array_length(command->'requirements')>30 then raise exception 'Invalid requirements';end if;
  for req in select * from jsonb_array_elements(command->'requirements')loop
   if not exists(select 1 from public.pack_adventures d cross join lateral jsonb_array_elements(d.requirements)r where d.id=(req->>'adventure_id')::uuid and r->>'code'=req->>'code' and d.rank=case command->>'den'when '0-Lions'then 'lion'when '1-Tigers'then 'tiger'when '2-Wolves'then 'wolf'when '3-Bears'then 'bear'when '4-Webelos'then 'webelos'when '5-AOL'then 'arrow_of_light'end)then raise exception 'Choose a requirement for this den';end if;
  end loop;
  insert into public.pack_meeting_plans(id,meeting_date,den,pack_activity,agenda,supplies,requirements,recorded_by)values(target,(command->>'date')::date,nullif(command->>'den',''),coalesce(command->>'pack_activity',''),coalesce(command->>'agenda',''),coalesce(command->>'supplies',''),command->'requirements',actor)
  on conflict(id)do update set meeting_date=excluded.meeting_date,den=excluded.den,pack_activity=excluded.pack_activity,agenda=excluded.agenda,supplies=excluded.supplies,requirements=excluded.requirements,revision=pack_meeting_plans.revision+1,recorded_by=actor;
 elsif a='finish_meeting'then
  select * into m from public.pack_meeting_plans where id=target;
  if m.revision is distinct from (command->>'revision')::int then raise exception 'Meeting changed; refresh';end if;
  if not found or m.den is null or m.meeting_date>(now()at time zone 'America/Los_Angeles')::date then raise exception 'Choose a completed den meeting';end if;
  if not exists(select 1 from public.pack_activities ac where ac.id=(command->>'activity_id')::uuid and ac.occurred_on=m.meeting_date)then raise exception 'Choose attendance for the meeting date';end if;
  for child in select s.id from public.scouts s join public.pack_attendance atn on atn.scout_id=s.id where atn.activity_id=(command->>'activity_id')::uuid and atn.status='present'and s.den=m.den order by s.id loop
   -- Lock child consistently with family/advancement operations.
   perform 1 from public.scouts where id=child for update;
   for req in select * from jsonb_array_elements(m.requirements)loop
    if not exists(select 1 from public.pack_requirement_progress p where p.scout_id=child and p.adventure_id=(req->>'adventure_id')::uuid and p.scouting_year=command->>'year' and p.requirement_code=req->>'code')and not exists(select 1 from public.pack_advancement v where v.scout_id=child and v.adventure_id=(req->>'adventure_id')::uuid and v.scouting_year=command->>'year'and v.earned_on is not null)then
     perform public.record_pack_operation(gen_random_uuid(),jsonb_build_object('action','record_requirement','scout_id',child,'adventure_id',req->>'adventure_id','scouting_year',command->>'year','expected_revision',coalesce((select v.revision from public.pack_advancement v where v.scout_id=child and v.adventure_id=(req->>'adventure_id')::uuid and v.scouting_year=command->>'year'),0),'occurred_on',m.meeting_date,'requirement_code',req->>'code','status','completed'));
    end if;
   end loop;
  end loop;
 else raise exception 'Unknown community action';end if;
 -- Do not retain photo bytes in audit history after deletion/replacement.
 insert into public.pack_community_commands values(request_id,case when a='photo' then (command-'image')||jsonb_build_object('image_hash',md5(coalesce(command->>'image',''))) else command end,actor,now());
end;$$;
revoke all on function public.record_pack_community(uuid,jsonb) from public,anon;
grant execute on function public.record_pack_community(uuid,jsonb) to authenticated;

-- Small projection for roster/attendance avatars; no public object URLs.
create function public.read_scout_photos() returns jsonb
language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('scout_id',p.scout_id,'image',p.image)),'[]')from public.pack_family_photos p where p.kind='scout'and(private.is_approved_leader()or private.parent_can_read_scout(p.scout_id));
$$;
revoke all on function public.read_scout_photos()from public,anon;
grant execute on function public.read_scout_photos()to authenticated;
