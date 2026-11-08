-- First M2 slice. Direct writes remain forbidden; bounded RPCs own mutations.
alter table public.leader_access add column can_record boolean not null default false;
update public.leader_access set can_record=true where role='admin' and active;
create function private.can_record() returns boolean
language sql stable security definer set search_path='' as $$
  select private.is_approved_leader() and exists (
    select 1 from public.leader_access a join auth.users u on lower(u.email)=a.email
    where u.id=auth.uid() and a.active and a.can_record
  );
$$;
revoke all on function private.can_record() from public, anon;
grant execute on function private.can_record() to authenticated;

create table public.pack_activities (
  id uuid primary key,
  title text not null check (length(btrim(title)) between 1 and 200),
  kind text not null check (kind in ('session','hike','event')),
  occurred_on date not null,
  scouting_year text not null check (scouting_year ~ '^[0-9]{4}-[0-9]{2}$'),
  recorded_at timestamptz not null default now(),
  recorded_by uuid not null
);
create table public.pack_attendance (
  activity_id uuid not null references public.pack_activities(id),
  scout_id uuid not null references public.scouts(id),
  status text not null check (status in ('present','absent','excused')),
  occurred_on date not null,
  revision integer not null check (revision>0),
  recorded_at timestamptz not null default now(),
  recorded_by uuid not null,
  primary key(activity_id,scout_id)
);
create index pack_attendance_scout on public.pack_attendance(scout_id);
create table public.pack_registrations (
  scout_id uuid not null references public.scouts(id),
  scouting_year text not null,
  platform text not null check (platform in ('active.com','scouting.org')),
  status text not null check (status in ('confirmed','not_registered','unknown')),
  occurred_on date not null,
  revision integer not null check (revision>0),
  recorded_at timestamptz not null default now(),
  recorded_by uuid not null,
  primary key(scout_id,scouting_year,platform)
);
create table public.pack_commands (
  request_id uuid primary key,
  command jsonb not null,
  result jsonb not null,
  recorded_at timestamptz not null default now(),
  recorded_by uuid not null
);
-- The immutable command history includes every previous status/date and actor.
alter table public.pack_activities enable row level security;
alter table public.pack_attendance enable row level security;
alter table public.pack_registrations enable row level security;
alter table public.pack_commands enable row level security;
revoke all on public.pack_activities,public.pack_attendance,public.pack_registrations,public.pack_commands from public,anon,authenticated;
grant select on public.pack_activities,public.pack_attendance,public.pack_registrations to authenticated;
create policy approved_activity_read on public.pack_activities for select to authenticated using ((select public.is_approved_leader()));
create policy approved_attendance_read on public.pack_attendance for select to authenticated using ((select public.is_approved_leader()));
create policy approved_registration_read on public.pack_registrations for select to authenticated using ((select public.is_approved_leader()));

create function public.record_pack_operation(request_id uuid, command jsonb) returns jsonb
language plpgsql security definer set search_path='' set statement_timeout='5s' as $$
#variable_conflict use_variable
declare
  previous public.pack_commands;
  action text := command->>'action';
  happened date := coalesce((command->>'occurred_on')::date,(now() at time zone 'America/Los_Angeles')::date);
  activity uuid;
  scout uuid;
  expected integer;
  new_revision integer;
  result jsonb;
  allowed text[];
begin
  if not private.can_record() then raise exception 'Recording access denied' using errcode='42501'; end if;
  if request_id is null or jsonb_typeof(command) is distinct from 'object' or octet_length(command::text)>8192 then
    raise exception 'Invalid command';
  end if;
  -- Serialize retries before reading history; never return another actor's result.
  perform pg_advisory_xact_lock(hashtextextended(request_id::text,0));
  select * into previous from public.pack_commands c where c.request_id=record_pack_operation.request_id;
  if found then
    if previous.recorded_by<>auth.uid() or previous.command<>command then raise exception 'Request ID conflict'; end if;
    return previous.result;
  end if;
  if action='create_activity' then allowed:=array['action','activity_id','title','kind','scouting_year','occurred_on'];
  elsif action='record_attendance' then allowed:=array['action','activity_id','scout_id','status','expected_revision','occurred_on'];
  elsif action='record_registration' then allowed:=array['action','scout_id','platform','scouting_year','status','expected_revision','occurred_on'];
  else raise exception 'Unknown action'; end if;
  if exists(select 1 from jsonb_object_keys(command) k where not k=any(allowed)) or
     exists(select 1 from jsonb_each(command) e where jsonb_typeof(e.value)='null') then raise exception 'Invalid command fields'; end if;
  if exists(select 1 from jsonb_each(command) e
    where (e.key='expected_revision' and (jsonb_typeof(e.value)<>'number' or e.value::text !~ '^[0-9]+$'))
       or (e.key<>'expected_revision' and jsonb_typeof(e.value)<>'string')) then
    raise exception 'Invalid command field types';
  end if;
  if command ? 'occurred_on' and (command->>'occurred_on' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    or to_char(happened,'YYYY-MM-DD')<>command->>'occurred_on') then raise exception 'Invalid occurrence date'; end if;
  if action in ('create_activity','record_registration') and (
    command->>'scouting_year' is null or command->>'scouting_year' !~ '^[0-9]{4}-[0-9]{2}$' or
    right(command->>'scouting_year',2) <> right(((left(command->>'scouting_year',4))::int+1)::text,2)
  ) then raise exception 'Invalid scouting year'; end if;
  if action='create_activity' then
    activity:=(command->>'activity_id')::uuid;
    insert into public.pack_activities(id,title,kind,occurred_on,scouting_year,recorded_by)
    values(activity,command->>'title',command->>'kind',happened,command->>'scouting_year',auth.uid());
    result:=jsonb_build_object('activity_id',activity,'occurred_on',happened);
  else
    scout:=(command->>'scout_id')::uuid;
    expected:=(command->>'expected_revision')::integer;
    if scout is null or expected is null or expected<0 then raise exception 'Scout and expected revision required'; end if;
    -- A scout row lock prevents simultaneous writes from losing corrections.
    perform 1 from public.scouts where id=scout for update;
    if not found then raise exception 'Unknown scout'; end if;
    if action='record_attendance' then
      activity:=(command->>'activity_id')::uuid;
      select occurred_on into happened from public.pack_activities where id=activity;
      if not found then raise exception 'Unknown activity'; end if;
      if command ? 'occurred_on' and (command->>'occurred_on')::date<>happened then raise exception 'Attendance date must match activity date'; end if;
      select revision into new_revision from public.pack_attendance where scout_id=scout and activity_id=activity;
      if coalesce(new_revision,0)<>expected then raise exception 'Revision conflict; read current state'; end if;
      new_revision:=expected+1;
      insert into public.pack_attendance(activity_id,scout_id,status,occurred_on,revision,recorded_by)
      values(activity,scout,command->>'status',happened,new_revision,auth.uid())
      on conflict on constraint pack_attendance_pkey do update set status=excluded.status,occurred_on=excluded.occurred_on,
        revision=excluded.revision,recorded_at=now(),recorded_by=auth.uid();
    else
      select revision into new_revision from public.pack_registrations where scout_id=scout and scouting_year=command->>'scouting_year' and platform=command->>'platform';
      if coalesce(new_revision,0)<>expected then raise exception 'Revision conflict; read current state'; end if;
      new_revision:=expected+1;
      insert into public.pack_registrations(scout_id,scouting_year,platform,status,occurred_on,revision,recorded_by)
      values(scout,command->>'scouting_year',command->>'platform',command->>'status',happened,new_revision,auth.uid())
      on conflict on constraint pack_registrations_pkey do update set status=excluded.status,occurred_on=excluded.occurred_on,
        revision=excluded.revision,recorded_at=now(),recorded_by=auth.uid();
    end if;
    result:=jsonb_build_object('scout_id',scout,'revision',new_revision,'occurred_on',happened);
  end if;
  insert into public.pack_commands(request_id,command,result,recorded_by) values(request_id,command,result,auth.uid());
  return result;
end;
$$;
revoke all on function public.record_pack_operation(uuid,jsonb) from public,anon;
grant execute on function public.record_pack_operation(uuid,jsonb) to authenticated;

create function public.read_pack_operations(entity text, scout_id uuid default null, activity_id uuid default null,
  scouting_year text default null, page_offset integer default 0, page_limit integer default 50) returns jsonb
language plpgsql stable security invoker set search_path='' set statement_timeout='5s' as $$
#variable_conflict use_variable
declare rows jsonb; total integer;
begin
  if not public.is_approved_leader() then raise exception 'Access denied' using errcode='42501'; end if;
  if entity not in ('activities','attendance','registrations') or entity is null or page_limit is null or page_limit not between 1 and 100 or page_offset is null or page_offset not between 0 and 10000 then raise exception 'Invalid query'; end if;
  if entity='activities' and scout_id is not null then raise exception 'Scout filter requires attendance or registrations'; end if;
  if entity='registrations' and activity_id is not null then raise exception 'Activity filter requires activities or attendance'; end if;
  with records as (
    select to_jsonb(a) as record,a.id::text as key from public.pack_activities a where entity='activities'
      and (activity_id is null or a.id=activity_id) and (scouting_year is null or a.scouting_year=scouting_year)
    union all
    select to_jsonb(a),a.activity_id::text||a.scout_id::text from public.pack_attendance a join public.pack_activities v on v.id=a.activity_id
      where entity='attendance' and (read_pack_operations.scout_id is null or a.scout_id=read_pack_operations.scout_id)
      and (read_pack_operations.activity_id is null or a.activity_id=read_pack_operations.activity_id)
      and (scouting_year is null or v.scouting_year=scouting_year)
    union all
    select to_jsonb(r),r.scout_id::text||r.scouting_year||r.platform from public.pack_registrations r where entity='registrations'
      and (read_pack_operations.scout_id is null or r.scout_id=read_pack_operations.scout_id)
      and (read_pack_operations.scouting_year is null or r.scouting_year=read_pack_operations.scouting_year)
  ), page as (select record from records order by key limit page_limit offset page_offset)
  select (select count(*) from records),coalesce(jsonb_agg(page.record),'[]'::jsonb) into total,rows from page;
  return jsonb_build_object('total',total,'rows',rows,'next_offset',case when page_offset+jsonb_array_length(rows)<total then page_offset+jsonb_array_length(rows) else null end);
end;
$$;
revoke all on function public.read_pack_operations(text,uuid,uuid,text,integer,integer) from public,anon;
grant execute on function public.read_pack_operations(text,uuid,uuid,text,integer,integer) to authenticated;
