-- Change only portal URL literals in existing function definitions.
-- Existing queued email links remain valid through the retained old hostname.
CREATE OR REPLACE FUNCTION private.queue_family_email(child uuid, key text, title text, content text)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
 insert into private.pack_email_outbox(dedupe_key,scout_id,recipient,subject,body)
 select key||':'||lower(btrim(l.parent_email)),child,lower(btrim(l.parent_email)),title,content||E'\n\nOpen your family portal: https://packpilot.example/parents'
 from public.parent_scout_links l join public.scouts s on s.id=l.scout_id
 where l.scout_id=child and l.active and coalesce(s.den,'') !~* '^\s*\(withdraw\)'
 group by lower(btrim(l.parent_email)) on conflict(dedupe_key)do nothing;
$function$
;

CREATE OR REPLACE FUNCTION private.queue_pack_admin_email(key text, title text, content text)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
 insert into private.pack_email_outbox(dedupe_key,recipient,subject,body,audience)
 values(key,'contact@example.test',title,content||E'\n\nOpen the Admin page: https://packpilot.example/admin','admin')on conflict(dedupe_key)do nothing;
$function$
;

CREATE OR REPLACE FUNCTION private.parent_context_before_tasks(email_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare q private.pack_email_outbox;items jsonb;names jsonb;parent_name text;links jsonb;item jsonb;i integer:=0;enabled boolean:=false;kind text;
begin
 select * into q from private.pack_email_outbox where id=email_id;
 if not found or q.status<>'sending'or not private.parent_email_still_allowed(q)then raise exception 'Email is no longer eligible';end if;
 kind:=coalesce(q.content->>'kind',split_part(q.dedupe_key,':',1));items:=q.content->'items';
 if q.audience='admin'then
  parent_name:='PackPilot administrator';names:='[]';items:=jsonb_build_array(jsonb_build_object('kind','admin','text',q.body));
 else
  select coalesce(jsonb_agg(n.name order by n.name),'[]')into names from(select distinct s.scout_name name from public.parent_scout_links l join public.scouts s on s.id=l.scout_id where l.active and lower(btrim(l.parent_email))=q.recipient and coalesce(s.den,'')!~* '^\s*\(withdraw\)')n;
  select coalesce(nullif(case when private.canonical_leader_email(s.parent_1_email)=private.canonical_leader_email(q.recipient)then s.parent_1_name else s.parent_2_name end,''),'PackPilot parent')into parent_name from public.parent_scout_links l join public.scouts s on s.id=l.scout_id where l.active and lower(btrim(l.parent_email))=q.recipient order by s.scout_name limit 1;
  if items is null then
   if kind='homework'then
    select jsonb_build_array(jsonb_build_object('kind','homework','scout_name',s.scout_name,'adventure',a.name,'requirement',h.requirement_code,'description',(select r->>'description'from jsonb_array_elements(a.requirements)r where r->>'code'=h.requirement_code limit 1),'url',a.source_url,'due_on',h.due_on))into items
    from public.pack_home_assignments h join public.pack_adventures a on a.id=h.adventure_id join public.scouts s on s.id=h.scout_id where h.id::text=split_part(q.dedupe_key,':',2)and h.status in('todo','returned');
   elsif kind='message'then
    select jsonb_build_array(jsonb_build_object('kind','message','scout_name',s.scout_name,'date',(m.recorded_at at time zone 'America/Los_Angeles')::date))into items from public.pack_family_messages m join public.scouts s on s.id=m.scout_id where m.id::text=split_part(q.dedupe_key,':',2);
   end if;
   items:=coalesce(items,jsonb_build_array(jsonb_build_object('kind',kind,'text',q.body)));
  end if;
  -- New engagement measurement starts only after the current policy was accepted.
  enabled:=exists(select 1 from public.parent_scout_links l join private.site_policy_acceptances a on a.user_id=l.claimed_user_id join private.site_policy_versions p on p.version=a.version where l.active and lower(btrim(l.parent_email))=q.recipient and p.current and a.terms_hash=p.terms_hash and a.privacy_hash=p.privacy_hash and p.engagement_enabled);
 end if;
 links:=jsonb_build_object('portal','https://packpilot.example/parents','national','https://example.test/national-registration','guide','https://example.test/registration-guide','active','https://example.test/pack-registration','survey','https://example.test/skills-survey');
 for item in select * from jsonb_array_elements(items)loop
  if item->>'url'like 'https://%'and item->>'url'!~'[\r\n]'then links:=links||jsonb_build_object('item-'||i,item->>'url');end if;i:=i+1;
 end loop;
 update private.pack_email_outbox set content=coalesce(content,'{}')||jsonb_build_object('kind',kind,'items',items,'links',links),tracking_enabled=enabled where id=email_id;
 return jsonb_build_object('kind',kind,'parent_name',coalesce(parent_name,'PackPilot parent'),'scout_names',names,'items',items,'links',links,'tracking_token',case when enabled then q.tracking_token else null end,'admin',q.audience='admin');
end;$function$
;

CREATE OR REPLACE FUNCTION public.track_parent_email(token uuid, engagement_kind text, target_key text DEFAULT 'portal'::text, automated boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_variable
declare q private.pack_email_outbox;destination text;
begin
 select * into q from private.pack_email_outbox where tracking_token=token and status='sent';
 if not found or not q.tracking_enabled or not private.parent_email_still_allowed(q)then return jsonb_build_object('url','https://packpilot.example/parents','tracked',false);end if;
 if q.sent_at<now()-interval '360 days'then return jsonb_build_object('url','https://packpilot.example/parents','tracked',false);end if;
 destination:=coalesce(q.content->'links'->>target_key,'https://packpilot.example/parents');
 if engagement_kind not in('opened','clicked')then raise exception 'Invalid engagement event';end if;
 -- Coalesce repeated image fetches and scanners; record signals without claiming human reading.
 if not exists(select 1 from private.pack_email_engagement e where e.email_id=q.id and e.kind=engagement_kind and e.target=target_key and e.automated=automated and e.recorded_at>now()-interval '1 hour')then
  insert into private.pack_email_engagement(email_id,kind,target,automated)values(q.id,engagement_kind,target_key,automated);
 end if;
 return jsonb_build_object('url',destination,'tracked',true);
end;$function$
;

CREATE OR REPLACE FUNCTION private.parent_reminder_items(mailbox text, year text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
 with children as(select distinct s.* from public.parent_scout_links l join public.scouts s on s.id=l.scout_id where l.active and lower(btrim(l.parent_email))=mailbox and coalesce(s.den,'')!~* '^\s*\(withdraw\)'),items as(
 select '1:'||s.scout_name||':'||a.id sort,jsonb_build_object('kind','homework','scout_name',s.scout_name,'adventure',d.name,'requirement',a.requirement_code,'description',(select r->>'description'from jsonb_array_elements(d.requirements)r where r->>'code'=a.requirement_code limit 1),'url',d.source_url,'due_on',a.due_on) item
 from children s join public.pack_home_assignments a on a.scout_id=s.id join public.pack_adventures d on d.id=a.adventure_id
 where a.scouting_year=year and a.status in('todo','returned')
 and not exists(select 1 from public.pack_requirement_progress p where p.scout_id=a.scout_id and p.adventure_id=a.adventure_id and p.scouting_year=year and p.requirement_code=a.requirement_code)
 and not exists(select 1 from public.pack_advancement v where v.scout_id=a.scout_id and v.adventure_id=a.adventure_id and v.scouting_year=year and v.earned_on is not null)
 union all
 select '2:'||s.scout_name||':'||m.id,jsonb_build_object('kind','message','scout_name',s.scout_name,'date',(m.recorded_at at time zone 'America/Los_Angeles')::date)
 from children s join public.pack_family_messages m on m.scout_id=s.id
 where m.scouting_year=year and exists(select 1 from public.parent_scout_links l where l.scout_id=s.id and l.active and lower(btrim(l.parent_email))=mailbox and m.recorded_by is distinct from l.claimed_user_id and not exists(select 1 from public.pack_family_message_reads r where r.user_id=l.claimed_user_id and r.message_id=m.id))
 union all
 select '3:'||s.scout_name||':'||platform,jsonb_build_object('kind',case when platform='scouting.org'then 'national_registration'else 'active_registration'end,'scout_name',s.scout_name)
 from children s cross join unnest(array['active.com','scouting.org'])p(platform)
 where not exists(select 1 from public.pack_registrations r where r.scout_id=s.id and r.scouting_year=year and r.platform=p.platform and r.status='confirmed')
 union all
 select '4:'||j.title||':'||j.id,jsonb_build_object('kind','volunteer','title',case when g.title=j.title then j.title else g.title||' — '||j.title end,'unit',j.capacity_unit,'instructions',concat_ws(E'\n',nullif(g.details,''),nullif(j.details,'')),'event',e.title,'date',coalesce(e.event_date,j.signup_date),'remaining',case when j.capacity is null then null else greatest(0,j.capacity-(select count(*)from public.pack_volunteers v where v.job_id=j.id))end,'url','https://packpilot.example/events?parent=1&job='||j.id)
 from public.pack_volunteer_jobs j join public.pack_volunteer_signups g on g.id=j.signup_id left join public.pack_events e on e.id=j.event_id
 where not g.closed and not j.closed and(e.id is null or(not e.cancelled and e.event_date>=(now()at time zone 'America/Los_Angeles')::date and(e.den is null or exists(select 1 from children s where s.den=e.den))))
 and(j.signup_date is null or j.signup_date>=(now()at time zone 'America/Los_Angeles')::date)
 and(j.capacity is null or(select count(*)from public.pack_volunteers v where v.job_id=j.id)<j.capacity)
 and not exists(select 1 from public.pack_volunteers v where v.job_id=j.id and(case when j.capacity_unit='family'then exists(select 1 from children c where private.volunteer_family_key(c.id)=private.volunteer_family_key(v.scout_id))else exists(select 1 from public.parent_scout_links l where l.claimed_user_id=v.user_id and l.active and lower(btrim(l.parent_email))=mailbox)end))
 and exists(select 1 from children)
 )select coalesce(jsonb_agg(item order by sort),'[]')from items;
$function$
;

CREATE OR REPLACE FUNCTION private.record_community_before_waitlists(request_id uuid, command jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET statement_timeout TO '20s'
AS $function$
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
  perform private.queue_pack_admin_email('registration-report:'||request_id,'PackPilot: registration verification requested','A parent reported that '||(command->>'platform')||' registration was submitted for '||(select scout_name from public.scouts where id=target)||'. Review the record: https://packpilot.example/?year='||(command->>'year')||'#scout/'||target||'/registration');
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
end;$function$
;

CREATE OR REPLACE FUNCTION private.promote_volunteer_waitlist(job uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_variable
declare j public.pack_volunteer_jobs;w public.pack_volunteer_waitlist;n integer:=0;title text;old_source text:=coalesce(current_setting('pack.audit_source',true),'');
begin
 perform pg_advisory_xact_lock(hashtextextended('job:'||job::text,0));select * into j from public.pack_volunteer_jobs where id=job for update;if not found then return 0;end if;
 if j.closed or exists(select 1 from public.pack_volunteer_signups where id=j.signup_id and closed)then return 0;end if;
 perform set_config('pack.audit_source','automation:waitlist',true);
 for w in select * from public.pack_volunteer_waitlist where job_id=job and status='waiting'order by requested_at,id for update loop
  if j.capacity is not null and(select count(*)from public.pack_volunteers where job_id=job)>=j.capacity then exit;end if;
  if not private.volunteer_is_eligible(w.user_id,w.scout_id,job)then update public.pack_volunteer_waitlist set status='expired',updated_at=now()where id=w.id;continue;end if;
  if exists(select 1 from public.pack_volunteers v where v.job_id=job and(v.user_id=w.user_id or j.capacity_unit='family'and private.volunteer_family_key(v.scout_id)=private.volunteer_family_key(w.scout_id)))then update public.pack_volunteer_waitlist set status='promoted',updated_at=now()where id=w.id;continue;end if;
  insert into public.pack_volunteers(job_id,user_id,scout_id,note)values(job,w.user_id,w.scout_id,w.note);
  update public.pack_volunteer_waitlist set status='promoted',updated_at=now()where id=w.id;
  select g.title||' — '||j.title into title from public.pack_volunteer_signups g where g.id=j.signup_id;
  perform private.queue_family_email(w.scout_id,'volunteer-promoted:'||w.id||':'||w.requested_at,'PackPilot: a volunteer place opened for your family','A place opened on the waitlist you joined. Your family is now signed up for '||title||E'.\nReview the commitment or release your place: https://packpilot.example/events?parent=1&job='||job);
  n:=n+1;
 end loop;
 perform set_config('pack.audit_source',old_source,true);return n;
end;$function$
;

CREATE OR REPLACE FUNCTION public.prepare_volunteer_followups(at_time timestamp with time zone DEFAULT now())
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
declare queued_job record;v record;n integer:=0;day date:=(at_time at time zone 'America/Los_Angeles')::date;
begin
 for queued_job in select distinct job_id from public.pack_volunteer_waitlist where status='waiting'loop n:=n+private.promote_volunteer_waitlist(queued_job.job_id);end loop;
 if(at_time at time zone 'America/Los_Angeles')::time<time '08:00'then return n;end if;
 for v in select v.*,j.title role,g.title signup,coalesce(e.event_date,j.signup_date)event_date,e.start_time,e.timezone,e.location from public.pack_volunteers v join public.pack_volunteer_jobs j on j.id=v.job_id join public.pack_volunteer_signups g on g.id=j.signup_id left join public.pack_events e on e.id=j.event_id where coalesce(e.event_date,j.signup_date)=day+1 and(e.id is null or not e.cancelled)and(exists(select 1 from public.parent_scout_links l join public.scouts s on s.id=l.scout_id where j.capacity_unit='family'and l.scout_id=v.scout_id and l.active and coalesce(s.den,'')!~*'^\s*\(withdraw\)')or exists(select 1 from public.parent_scout_links l join auth.users u on u.id=l.claimed_user_id join public.scouts s on s.id=l.scout_id where l.scout_id=v.scout_id and l.claimed_user_id=v.user_id and l.active and u.email_confirmed_at is not null and l.email_canonical=private.canonical_leader_email(u.email)and coalesce(s.den,'')!~*'^\s*\(withdraw\)'))loop
  perform private.queue_family_email(v.scout_id,'volunteer-reminder:'||v.job_id||':'||v.user_id||':'||v.event_date,'PackPilot: your volunteer commitment tomorrow','Your family has a volunteer commitment tomorrow: '||v.signup||' — '||v.role||E'.\nDate: '||v.event_date||coalesce(E'\nTime: '||v.start_time::text||' ('||v.timezone||')','')||coalesce(E'\nLocation: '||v.location,'')||coalesce(E'\nYour note: '||nullif(v.note,''),'')||E'\nReview or release your place: https://packpilot.example/events?parent=1&job='||v.job_id);
 end loop;return n;
end;$function$
;

CREATE OR REPLACE FUNCTION public.manage_pack_access(request_id uuid, command jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_variable
declare prior private.pack_admin_commands;fingerprint text:=md5(request_id::text||command::text);email text:=lower(btrim(command->>'email'));canon text;old_email text;target uuid;slot integer;enabled boolean:=coalesce((command->>'enabled')::boolean,true);result jsonb;existing public.leader_access;
begin
 if not private.is_pack_admin()then raise exception 'Administrator access required'using errcode='42501';end if;
 if request_id is null or jsonb_typeof(command)is distinct from 'object'or length(command::text)>10000 or coalesce((command->>'verified')::boolean,false)is not true then raise exception 'Verify the person, email and intended access first';end if;
 if email is null or length(email)>254 or email!~'^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'then raise exception 'Provide a valid email address';end if;
 canon:=private.canonical_leader_email(email);
 perform pg_advisory_xact_lock(hashtextextended('admin:'||request_id::text,0));
 select * into prior from private.pack_admin_commands c where c.request_id=request_id;
 if found then if prior.recorded_by<>auth.uid()or prior.fingerprint<>fingerprint then raise exception 'Request ID conflict';end if;return prior.result;end if;
 if command->>'action'='leader_access'then
  perform pg_advisory_xact_lock(hashtextextended('manage-leader-access',0));
  select * into existing from public.leader_access l where private.canonical_leader_email(l.email)=canon order by(l.email=email)desc limit 1 for update;
  if command->>'role'not in('leader','admin')then raise exception 'Choose leader or administrator';end if;
  if existing.role='admin'and existing.active and(not enabled or command->>'role'<>'admin')and(select count(*)from public.leader_access where role='admin'and active)<=1 then raise exception 'Keep at least one active administrator';end if;
  if existing.email is not null then
   if command->>'expected_state'is distinct from md5(to_jsonb(existing)::text)then raise exception 'Access changed; refresh and review';end if;
   update public.leader_access set active=enabled,role=command->>'role',can_record=case when command->>'role'='admin'then true else coalesce((command->>'can_record')::boolean,false)end,default_den=nullif(command->>'den','')where leader_access.email=existing.email;
  else
   if nullif(command->>'expected_state','')is not null then raise exception 'Access changed; refresh';end if;
   insert into public.leader_access(email,role,active,can_record,default_den)values(email,command->>'role',enabled,case when command->>'role'='admin'then true else coalesce((command->>'can_record')::boolean,false)end,nullif(command->>'den',''));
  end if;
  result:=jsonb_build_object('saved',true,'invitation_url','https://packpilot.example/?welcome=leader');
 elsif command->>'action'='family_link'then
  target:=(command->>'scout_id')::uuid;slot:=(command->>'slot')::int;
  if slot not in(1,2)or target is null then raise exception 'Choose a scout and parent slot';end if;
  perform 1 from public.scouts where id=target for update;if not found then raise exception 'Scout unavailable';end if;
  if command->>'expected_state'is distinct from private.pack_access_token(target)then raise exception 'Family links changed; refresh and review';end if;
  select case slot when 1 then parent_1_email else parent_2_email end into old_email from public.scouts where id=target;
  if enabled then
   if old_email is not null and private.canonical_leader_email(old_email)<>canon and not exists(select 1 from public.scouts s where s.id=target and private.canonical_leader_email(case slot when 1 then s.parent_2_email else s.parent_1_email end)=private.canonical_leader_email(old_email))then update public.parent_scout_links set active=false where scout_id=target and email_canonical=private.canonical_leader_email(old_email);end if;
   insert into public.parent_scout_links(scout_id,parent_email,created_by,source_context)values(target,email,auth.uid(),'{"approval":"verified admin repair"}')on conflict(scout_id,email_canonical)do update set active=true,parent_email=excluded.parent_email;
   if slot=1 then update public.scouts set parent_1_email=email,parent_1_name=nullif(btrim(command->>'name'),'')where id=target;else update public.scouts set parent_2_email=email,parent_2_name=nullif(btrim(command->>'name'),'')where id=target;end if;
  else update public.parent_scout_links set active=false where scout_id=target and email_canonical=canon;if not found then raise exception 'No approved family link exists for that email';end if;end if;
  update private.pack_email_outbox q set status='cancelled'where q.status in('pending','sending')and q.audience='parent'and(q.scout_id=target or target=any(q.child_ids))and not private.parent_email_still_allowed(q);
  result:=jsonb_build_object('saved',true,'scout_id',target);
 else raise exception 'Unknown access action';end if;
 insert into private.pack_admin_commands values(request_id,command,result,fingerprint,auth.uid(),now());return result;
end;$function$
;

CREATE OR REPLACE FUNCTION public.parent_email_context(email_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare result jsonb;q private.pack_email_outbox;destination text;kind text;task_year text;volunteer_job uuid;
begin
 result:=private.parent_context_before_tasks(email_id);select * into q from private.pack_email_outbox where id=email_id;kind:=split_part(q.dedupe_key,':',1);
 if q.scout_id is not null and kind in('homework','message','earned','badge')then
  destination:='https://packpilot.example/parents?child='||q.scout_id||'&section='||case when kind='homework'then 'homework'when kind='message'then 'messages'else 'progress'end;
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
   destination:='https://packpilot.example/events?parent=1&job='||volunteer_job;
   result:=jsonb_set(result,'{links,portal}',to_jsonb(destination));update private.pack_email_outbox set content=jsonb_set(content,'{links,portal}',to_jsonb(destination))where id=email_id;
  end if;
 end if;return result;
end;$function$
;
