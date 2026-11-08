-- A signup owns several independently limited roles; existing job IDs and reservations survive.
create table public.pack_volunteer_signups(
 id uuid primary key,title text not null check(length(btrim(title))between 1 and 200),
 details text not null default ''check(length(details)<=4000),event_id uuid references public.pack_events(id),signup_date date,
 closed boolean not null default false,revision integer not null default 1,created_by uuid not null,
 recorded_by uuid not null,recorded_at timestamptz not null default now()
);
alter table public.pack_volunteer_signups enable row level security;
revoke all on public.pack_volunteer_signups from public,anon,authenticated;
alter table public.pack_volunteer_jobs add column signup_id uuid references public.pack_volunteer_signups(id);
alter table public.pack_volunteer_jobs add column capacity_unit text not null default 'person'check(capacity_unit in('family','person'));
insert into public.pack_volunteer_signups(id,title,event_id,signup_date,closed,created_by,recorded_by)
 select id,title,event_id,signup_date,closed,created_by,created_by from public.pack_volunteer_jobs;
update public.pack_volunteer_jobs set signup_id=id;
alter table public.pack_volunteer_jobs alter column signup_id set not null;
create index volunteer_signup_items on public.pack_volunteer_jobs(signup_id);
create trigger pack_audit after insert or update or delete on public.pack_volunteer_signups for each row execute function private.capture_pack_change();

-- Cached older clients may still create a single role. Keep that path working.
create function private.ensure_volunteer_signup()returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.signup_id is null then
  insert into public.pack_volunteer_signups(id,title,event_id,signup_date,closed,created_by,recorded_by)
   values(new.id,new.title,new.event_id,new.signup_date,new.closed,new.created_by,new.created_by);
  new.signup_id:=new.id;
 end if;return new;
end;$$;
revoke all on function private.ensure_volunteer_signup()from public,anon,authenticated;
create trigger ensure_volunteer_signup before insert on public.pack_volunteer_jobs for each row execute function private.ensure_volunteer_signup();

-- Families are connected by explicit active guardian links; photos/names never grant membership.
create function private.volunteer_family_key(child uuid)returns uuid
language sql stable security definer set search_path='' as $$
 with recursive family(scout_id)as(
  select child union select b.scout_id from family f join public.parent_scout_links a on a.scout_id=f.scout_id and a.active
  join public.parent_scout_links b on lower(btrim(a.parent_email))=lower(btrim(b.parent_email))and b.active
 )select scout_id from family order by scout_id limit 1;
$$;
revoke all on function private.volunteer_family_key(uuid)from public,anon,authenticated;

alter function public.record_pack_community(uuid,jsonb)rename to record_pack_community_before_signups;
alter function public.record_pack_community_before_signups(uuid,jsonb)set schema private;
revoke all on function private.record_pack_community_before_signups(uuid,jsonb)from public,anon,authenticated;
create function public.record_pack_community(request_id uuid,command jsonb)returns void
language plpgsql security definer set search_path='' set statement_timeout='15s' as $$
#variable_conflict use_variable
declare action text:=command->>'action';target uuid:=(command->>'id')::uuid;prior public.pack_community_commands;
 signup public.pack_volunteer_signups;job public.pack_volunteer_jobs;item jsonb;role_id uuid;child uuid;family_key uuid;actor uuid:=auth.uid();event public.pack_events;joining boolean;had_prior boolean;
begin
 if action is null or action not in('signup','volunteer')then
  if action='close_job'and request_id is not null then
   perform pg_advisory_xact_lock(hashtextextended('community-request:'||request_id::text,0));
   select exists(select 1 from public.pack_community_commands c where c.request_id=request_id)into had_prior;
  end if;
  perform private.record_pack_community_before_signups(request_id,command);
  -- The old writer fills the standalone date after insertion.
  if action='job'then update public.pack_volunteer_signups s set signup_date=j.signup_date from public.pack_volunteer_jobs j where j.id=target and s.id=j.signup_id and s.id=j.id;end if;
  if action='close_job'and not had_prior then update public.pack_volunteer_signups s set revision=s.revision+1,recorded_at=now(),recorded_by=actor from public.pack_volunteer_jobs j where j.id=target and s.id=j.signup_id;end if;
  return;
 end if;
 if not private.is_approved_leader()and not exists(select 1 from public.scouts s where private.parent_can_read_scout(s.id))then raise exception 'Authorized account required'using errcode='42501';end if;
 if request_id is null or target is null or jsonb_typeof(command)is distinct from 'object'or length(command::text)>64000 then raise exception 'Invalid signup command';end if;
 perform pg_advisory_xact_lock(hashtextextended('community-request:'||request_id::text,0));
 select * into prior from public.pack_community_commands c where c.request_id=request_id;
 if found then if prior.recorded_by<>actor or prior.command<>command then raise exception 'Request ID conflict';end if;return;end if;
 if action='signup'then
  if not private.can_record()then raise exception 'Leader recording access required'using errcode='42501';end if;
  perform pg_advisory_xact_lock(hashtextextended('signup:'||target::text,0));
  select * into signup from public.pack_volunteer_signups where id=target for update;
  if coalesce(signup.revision,0)<>coalesce((command->>'revision')::int,0)then raise exception 'Signup changed; refresh before editing';end if;
  if jsonb_typeof(command->'items')is distinct from 'array'or jsonb_array_length(command->'items')not between 1 and 50 then raise exception 'Add between one and 50 signup items';end if;
  if(select count(distinct x->>'id')from jsonb_array_elements(command->'items')x)<>jsonb_array_length(command->'items')then raise exception 'Each signup item needs a distinct ID';end if;
  if nullif(command->>'event_id','')is not null then
   select * into event from public.pack_events where id=(command->>'event_id')::uuid;
   if not found or(event.cancelled and not coalesce((command->>'closed')::boolean,false))then raise exception 'Choose an active event';end if;
  end if;
  if exists(select 1 from public.pack_volunteer_jobs j where j.signup_id=target and not exists(select 1 from jsonb_array_elements(command->'items')x where x->>'id'=j.id::text))then raise exception 'Keep existing items; close an item instead of removing it';end if;
  insert into public.pack_volunteer_signups(id,title,details,event_id,signup_date,closed,created_by,recorded_by)
   values(target,btrim(command->>'title'),coalesce(command->>'details',''),nullif(command->>'event_id','')::uuid,nullif(command->>'signup_date','')::date,coalesce((command->>'closed')::boolean,false),actor,actor)
  on conflict(id)do update set title=excluded.title,details=excluded.details,event_id=excluded.event_id,signup_date=excluded.signup_date,closed=excluded.closed,revision=pack_volunteer_signups.revision+1,recorded_by=actor,recorded_at=now();
  for item in select x from jsonb_array_elements(command->'items')x order by x->>'id'loop
   role_id:=(item->>'id')::uuid;if role_id is null then raise exception 'Each signup item needs an ID';end if;
   select * into job from public.pack_volunteer_jobs where id=role_id for update;
   if found then
    if job.signup_id<>target then raise exception 'Item belongs to another signup';end if;
    if exists(select 1 from public.pack_volunteers where job_id=role_id)then
     if job.capacity_unit<>coalesce(item->>'capacity_unit','family')then raise exception 'Cannot change family/person units while an item has volunteers';end if;
     if nullif(item->>'capacity','')::int<(select count(*)from public.pack_volunteers where job_id=role_id)then raise exception 'Capacity cannot be smaller than current signups';end if;
     if signup.event_id is distinct from nullif(command->>'event_id','')::uuid or signup.signup_date is distinct from nullif(command->>'signup_date','')::date then raise exception 'A signup with existing volunteers cannot move to a different event/date';end if;
    end if;
   end if;
   insert into public.pack_volunteer_jobs(id,signup_id,title,details,event_id,signup_date,capacity,capacity_unit,closed,created_by)
    values(role_id,target,btrim(item->>'title'),coalesce(item->>'details',''),nullif(command->>'event_id','')::uuid,nullif(command->>'signup_date','')::date,nullif(item->>'capacity','')::int,coalesce(item->>'capacity_unit','family'),coalesce((item->>'closed')::boolean,false),actor)
   on conflict(id)do update set title=excluded.title,details=excluded.details,event_id=excluded.event_id,signup_date=excluded.signup_date,capacity=excluded.capacity,capacity_unit=excluded.capacity_unit,closed=excluded.closed;
  end loop;
 else
  perform pg_advisory_xact_lock(hashtextextended('job:'||target::text,0));
  select * into job from public.pack_volunteer_jobs where id=target for update;if not found then raise exception 'Signup item not found';end if;
  select * into signup from public.pack_volunteer_signups where id=job.signup_id;
  if not exists(select 1 from public.scouts s where private.parent_can_read_scout(s.id))then raise exception 'Family access denied'using errcode='42501';end if;
  joining:=coalesce((command->>'join')::boolean,false);
  if joining then
   child:=(command->>'scout_id')::uuid;
   if not private.parent_can_read_scout(child)then raise exception 'Child access denied'using errcode='42501';end if;
   if signup.closed or job.closed or coalesce(job.signup_date<(now()at time zone 'America/Los_Angeles')::date,false)then raise exception 'Signup closed';end if;
   if job.event_id is not null and not exists(select 1 from public.pack_events e join public.scouts s on s.id=child where e.id=job.event_id and not e.cancelled and e.event_date>=(now()at time zone 'America/Los_Angeles')::date and(e.den is null or e.den=s.den))then raise exception 'Choose an available signup for this scout';end if;
   family_key:=private.volunteer_family_key(child);
   if job.capacity_unit='family'and exists(select 1 from public.pack_volunteers v where v.job_id=target and private.volunteer_family_key(v.scout_id)=family_key)then
    null; -- Linked guardians share one family place and may safely join again.
   else insert into public.pack_volunteers values(target,actor,child)on conflict do nothing;end if;
   if job.capacity is not null and(select count(*)from public.pack_volunteers where job_id=target)>job.capacity then raise exception 'Volunteer item is full';end if;
  elsif job.capacity_unit='family'then
   delete from public.pack_volunteers v where v.job_id=target and exists(select 1 from public.scouts s where private.parent_can_read_scout(s.id)and private.volunteer_family_key(s.id)=private.volunteer_family_key(v.scout_id));
  else delete from public.pack_volunteers where job_id=target and user_id=actor;
  end if;
 end if;
 insert into public.pack_community_commands values(request_id,command,actor,now());
end;$$;
revoke all on function public.record_pack_community(uuid,jsonb)from public,anon;
grant execute on function public.record_pack_community(uuid,jsonb)to authenticated;

alter function public.read_pack_community(boolean)rename to read_pack_community_before_signups;
alter function public.read_pack_community_before_signups(boolean)set schema private;
revoke all on function private.read_pack_community_before_signups(boolean)from public,anon,authenticated;
create function public.read_pack_community(as_parent boolean default false)returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;leader boolean:=private.is_approved_leader()and not as_parent;
begin
 result:=private.read_pack_community_before_signups(as_parent);
 return result||jsonb_build_object(
 'jobs',(select coalesce(jsonb_agg(x||jsonb_build_object('mine',case when x->>'capacity_unit'='family'then exists(select 1 from public.pack_volunteers v join public.scouts s on private.parent_can_read_scout(s.id) where v.job_id=(x->>'id')::uuid and private.volunteer_family_key(v.scout_id)=private.volunteer_family_key(s.id))else (x->>'mine')::boolean end)),'[]')from jsonb_array_elements(result->'jobs')x),
 'signups',(select coalesce(jsonb_agg(to_jsonb(s)order by coalesce(e.event_date,s.signup_date),s.title),'[]')from public.pack_volunteer_signups s left join public.pack_events e on e.id=s.event_id where leader or exists(select 1 from jsonb_array_elements(result->'jobs')j where j->>'signup_id'=s.id::text)));
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
  result:=result||jsonb_build_object('activities',(select coalesce(jsonb_agg(jsonb_build_object('id',a.id,'title',a.title,'occurred_on',a.occurred_on)order by a.occurred_on desc),'[]')from public.pack_activities a where a.scouting_year=read_pack_workspace.scouting_year));
 else result:=result||jsonb_build_object('meetings','[]'::jsonb,'progress','[]'::jsonb,'advancement','[]'::jsonb,'priorities','[]'::jsonb);end if;
 if view_name='notes'then result:=result||jsonb_build_object('notes',public.read_leader_notes());end if;
 if view_name not in('planner','data-export')then result:=result||jsonb_build_object('adventures','[]'::jsonb);end if;
 return result||jsonb_build_object('attribution',case when leader then private.pack_value_attribution(case view_name
 when 'planner'then array['pack_meeting_plans'] when 'notes'then array['pack_leader_notes'] when 'events'then array['pack_events','pack_volunteer_jobs','pack_volunteer_signups'] when 'images'then array['pack_family_photos'] when 'admin'then array['pack_retention','pack_deletion_requests','pack_scoutbook_mappings','pack_scoutbook_names']else array[]::text[]end)else '[]'::jsonb end);
end;$$;
revoke all on function public.read_pack_workspace(text,boolean,text)from public,anon;
grant execute on function public.read_pack_workspace(text,boolean,text)to authenticated;


create or replace function private.parent_reminder_items(mailbox text,year text)returns jsonb
language sql stable security definer set search_path='' as $$
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
 select '4:'||j.title||':'||j.id,jsonb_build_object('kind','volunteer','title',case when g.title=j.title then j.title else g.title||' — '||j.title end,'unit',j.capacity_unit,'instructions',concat_ws(E'\n',nullif(g.details,''),nullif(j.details,'')),'event',e.title,'date',coalesce(e.event_date,j.signup_date),'remaining',case when j.capacity is null then null else greatest(0,j.capacity-(select count(*)from public.pack_volunteers v where v.job_id=j.id))end,'url','https://legacy.packpilot.example/events?parent=1&job='||j.id)
 from public.pack_volunteer_jobs j join public.pack_volunteer_signups g on g.id=j.signup_id left join public.pack_events e on e.id=j.event_id
 where not g.closed and not j.closed and(e.id is null or(not e.cancelled and e.event_date>=(now()at time zone 'America/Los_Angeles')::date and(e.den is null or exists(select 1 from children s where s.den=e.den))))
 and(j.signup_date is null or j.signup_date>=(now()at time zone 'America/Los_Angeles')::date)
 and(j.capacity is null or(select count(*)from public.pack_volunteers v where v.job_id=j.id)<j.capacity)
 and not exists(select 1 from public.pack_volunteers v where v.job_id=j.id and(case when j.capacity_unit='family'then exists(select 1 from children c where private.volunteer_family_key(c.id)=private.volunteer_family_key(v.scout_id))else exists(select 1 from public.parent_scout_links l where l.claimed_user_id=v.user_id and l.active and lower(btrim(l.parent_email))=mailbox)end))
 and exists(select 1 from children)
 )select coalesce(jsonb_agg(item order by sort),'[]')from items;
$$;
revoke all on function private.parent_reminder_items(text,text)from public,anon,authenticated;

create or replace function public.prepare_pack_export(request_id uuid,children uuid[]default null,export_kind text default 'family')returns jsonb
language plpgsql security definer set search_path='' set statement_timeout='30s' as $$
#variable_conflict use_variable
declare ids uuid[];prior private.pack_export_runs;result jsonb;
begin
 if request_id is null or export_kind not in('family','scoutbook')then raise exception 'Invalid export request';end if;
 if export_kind='scoutbook'and not private.is_pack_admin()then raise exception 'Administrator access required'using errcode='42501';end if;
 if not private.is_pack_admin()and not exists(select 1 from public.scouts s where private.parent_can_read_scout(s.id))then raise exception 'Family access required'using errcode='42501';end if;
 select array_agg(distinct s.id order by s.id)into ids from public.scouts s where(children is null or s.id=any(children))and(private.is_pack_admin()or private.parent_can_read_scout(s.id));
 if ids is null or cardinality(ids)=0 or(children is not null and exists(select 1 from unnest(children)c where not c=any(ids)))then raise exception 'Export scope denied'using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended('export:'||request_id::text,0));
 select * into prior from private.pack_export_runs where id=request_id;
 if found then
  if prior.requested_by<>auth.uid()or prior.scout_ids<>ids or prior.kind<>export_kind then raise exception 'Request ID conflict';end if;
  if prior.expires_at<now()then raise exception 'Export expired; request a fresh copy';end if;
 else
  insert into private.pack_export_runs(id,requested_by,scout_ids,kind,record_count)values(request_id,auth.uid(),ids,export_kind,cardinality(ids));
  if not private.is_pack_admin()then
   perform private.queue_pack_admin_email('parent-export:'||request_id,'PackPilot: parent data export generated','A parent generated a private export.'||E'\nRequesting account: '||(select u.email from auth.users u where u.id=auth.uid())||E'\nScouts: '||(select string_agg(s.scout_name,', 'order by s.scout_name)from public.scouts s where s.id=any(ids))||E'\nGenerated: '||now()||E'\nExport reference: '||request_id||E'\nThe export contents are not attached. Sign in to review the export log.');
  end if;
 end if;
 result:=jsonb_build_object('run_id',request_id,'generated_at',now(),'expires_at',(select expires_at from private.pack_export_runs where id=request_id),
 'scouts',(select jsonb_agg(case when private.is_pack_admin()then to_jsonb(s)else jsonb_build_object('id',s.id,'scout_name',s.scout_name,'den',s.den,'birth_date',s.birth_date,'grade',s.grade,'bsa_member_id',s.bsa_member_id)end order by s.scout_name)from public.scouts s where s.id=any(ids)),
 'advancement',(select coalesce(jsonb_agg(to_jsonb(v)),'[]')from public.pack_advancement v where v.scout_id=any(ids)),
 'progress',(select coalesce(jsonb_agg(to_jsonb(p)),'[]')from public.pack_requirement_progress p where p.scout_id=any(ids)),
 'adventures',(select coalesce(jsonb_agg(to_jsonb(a)),'[]')from public.pack_adventures a where exists(select 1 from public.pack_advancement v where v.scout_id=any(ids)and v.adventure_id=a.id)or exists(select 1 from public.pack_home_assignments h where h.scout_id=any(ids)and h.adventure_id=a.id)),
 'registrations',(select coalesce(jsonb_agg(to_jsonb(r)),'[]')from public.pack_registrations r where r.scout_id=any(ids)),
 'attendance',(select coalesce(jsonb_agg(to_jsonb(a)||jsonb_build_object('activity_title',ac.title,'activity_kind',ac.kind)),'[]')from public.pack_attendance a join public.pack_activities ac on ac.id=a.activity_id where a.scout_id=any(ids)),
 'homework',(select coalesce(jsonb_agg(to_jsonb(h)),'[]')from public.pack_home_assignments h where h.scout_id=any(ids)),
 'messages',(select coalesce(jsonb_agg(to_jsonb(m)),'[]')from public.pack_family_messages m where m.scout_id=any(ids)),
 'photos',(select coalesce(jsonb_agg(to_jsonb(p)),'[]')from public.pack_family_photos p where p.scout_id=any(ids)),
 'bookings',(select coalesce(jsonb_agg(to_jsonb(b)||jsonb_build_object('event_title',e.title,'event_date',e.event_date)),'[]')from public.pack_event_bookings b join public.pack_events e on e.id=b.event_id where b.scout_id=any(ids)),
 'equipment',(select coalesce(jsonb_agg(to_jsonb(e)),'[]')from public.pack_equipment_state e where e.scout_id=any(ids)),
 'equipment_events',(select coalesce(jsonb_agg(to_jsonb(e)),'[]')from public.pack_equipment_events e where e.scout_id=any(ids)),
 'volunteering',(select coalesce(jsonb_agg(to_jsonb(v)||jsonb_build_object('signup_id',j.signup_id,'signup_title',(select g.title from public.pack_volunteer_signups g where g.id=j.signup_id),'role_title',j.title,'capacity_unit',j.capacity_unit,'details',j.details,'signup_date',j.signup_date,'event_id',j.event_id)),'[]')from public.pack_volunteers v join public.pack_volunteer_jobs j on j.id=v.job_id where v.scout_id=any(ids)),
 'mappings',case when export_kind='scoutbook'then(select coalesce(jsonb_agg(to_jsonb(m)),'[]')from private.pack_scoutbook_mappings m)else '[]'::jsonb end,
 'official_names',case when export_kind='scoutbook'then(select coalesce(jsonb_agg(to_jsonb(n)),'[]')from private.pack_scoutbook_names n where n.scout_id=any(ids))else '[]'::jsonb end);
 return result;
end;$$;
