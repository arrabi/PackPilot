-- Versioned definitions are immutable. Operational writes retain command history.
create table public.pack_adventures (
  id uuid primary key,
  name text not null check(length(btrim(name)) between 1 and 200),
  rank text not null check(rank in ('lion','tiger','wolf','bear','webelos','arrow_of_light')),
  program_version text not null check(length(btrim(program_version)) between 1 and 100),
  source_url text not null check(source_url ~ '^https://[^ /]+/'),
  source_verified_on date not null,
  requirements jsonb not null,
  readiness_mode text not null default 'automatic' check(readiness_mode in ('automatic','leader_review')),
  catalog_context jsonb not null default '{}'::jsonb check(jsonb_typeof(catalog_context)='object'),
  completion_groups jsonb not null,
  recorded_at timestamptz not null default now(),
  recorded_by uuid not null,
  unique(name,rank,program_version)
);
create table public.pack_advancement (
  scout_id uuid not null references public.scouts(id),
  adventure_id uuid not null references public.pack_adventures(id),
  scouting_year text not null,
  revision integer not null check(revision>0),
  earned_on date,
  badge_delivered_on date,
  badge_form text check(badge_form in ('belt_loop','pin')),
  recorded_at timestamptz not null default now(),
  recorded_by uuid not null,
  primary key(scout_id,adventure_id,scouting_year),
  check(badge_delivered_on is null or (earned_on is not null and badge_delivered_on>=earned_on and badge_form is not null)),
  check(badge_delivered_on is not null or badge_form is null)
);
create index pack_advancement_adventure on public.pack_advancement(adventure_id);
create table public.pack_requirement_progress (
  scout_id uuid not null,
  adventure_id uuid not null,
  scouting_year text not null,
  requirement_code text not null,
  completed_on date not null,
  completion_source text not null check(completion_source in ('individual','award')),
  recorded_at timestamptz not null default now(),
  recorded_by uuid not null,
  primary key(scout_id,adventure_id,scouting_year,requirement_code),
  foreign key(scout_id,adventure_id,scouting_year) references public.pack_advancement(scout_id,adventure_id,scouting_year)
);
alter table public.pack_adventures enable row level security;
alter table public.pack_advancement enable row level security;
alter table public.pack_requirement_progress enable row level security;
revoke all on public.pack_adventures,public.pack_advancement,public.pack_requirement_progress from public,anon,authenticated;
grant select on public.pack_adventures,public.pack_advancement,public.pack_requirement_progress to authenticated;
create policy approved_adventure_read on public.pack_adventures for select to authenticated using ((select public.is_approved_leader()));
create policy approved_advancement_read on public.pack_advancement for select to authenticated using ((select public.is_approved_leader()));
create policy approved_progress_read on public.pack_requirement_progress for select to authenticated using ((select public.is_approved_leader()));

-- Retain first-slice behavior behind an owner-only dispatch function.
alter function public.record_pack_operation(uuid,jsonb) set schema private;
revoke all on function private.record_pack_operation(uuid,jsonb) from public,anon,authenticated;

create function private.record_advancement_operation(request_id uuid, command jsonb) returns jsonb
language plpgsql security definer set search_path='' set statement_timeout='5s' as $$
#variable_conflict use_variable
declare
  previous public.pack_commands;
  action text:=command->>'action';
  happened date;
  actor uuid:=auth.uid();
  scout uuid;
  adventure uuid;
  year text;
  definition public.pack_adventures;
  state public.pack_advancement;
  expected integer;
  allowed text[];
  requirement jsonb;
  group_rule jsonb;
  code text;
  result jsonb;
begin
  if not private.can_record() then raise exception 'Recording access denied' using errcode='42501'; end if;
  if request_id is null or jsonb_typeof(command) is distinct from 'object' or octet_length(command::text)>32768 then raise exception 'Invalid command'; end if;
  perform pg_advisory_xact_lock(hashtextextended(request_id::text,0));
  select * into previous from public.pack_commands c where c.request_id=record_advancement_operation.request_id;
  if found then
    if previous.recorded_by<>actor or previous.command<>command then raise exception 'Request ID conflict'; end if;
    return previous.result;
  end if;
  if action='define_adventure' then
    allowed:=array['action','adventure_id','name','rank','program_version','source_url','source_verified_on','requirements','completion_groups','readiness_mode','catalog_context'];
  elsif action='record_requirement' then
    allowed:=array['action','adventure_id','scout_id','scouting_year','expected_revision','occurred_on','requirement_code','status'];
  elsif action='earn_adventure' then
    allowed:=array['action','adventure_id','scout_id','scouting_year','expected_revision','occurred_on'];
  elsif action='deliver_badge' then
    allowed:=array['action','adventure_id','scout_id','scouting_year','expected_revision','occurred_on','badge_form'];
  elsif action in ('revoke_adventure','retract_badge_delivery') then
    allowed:=array['action','adventure_id','scout_id','scouting_year','expected_revision','occurred_on','reason'];
  else raise exception 'Unknown advancement action'; end if;
  if exists(select 1 from jsonb_each(command) e where not e.key=any(allowed) or jsonb_typeof(e.value)='null'
    or (e.key='expected_revision' and (jsonb_typeof(e.value)<>'number' or e.value::text !~ '^[0-9]+$'))
    or (e.key in ('requirements','completion_groups') and jsonb_typeof(e.value)<>'array')
    or (e.key='catalog_context' and jsonb_typeof(e.value)<>'object')
    or (e.key not in ('expected_revision','requirements','completion_groups','catalog_context') and jsonb_typeof(e.value)<>'string')) then raise exception 'Invalid command fields'; end if;
  adventure:=(command->>'adventure_id')::uuid;
  if action='define_adventure' then
    if jsonb_typeof(command->'requirements') is distinct from 'array' or jsonb_array_length(command->'requirements') not between 1 and 100
       or jsonb_typeof(command->'completion_groups') is distinct from 'array' or jsonb_array_length(command->'completion_groups') not between 1 and 100 then raise exception 'Requirements and completion groups required'; end if;
    for requirement in select * from jsonb_array_elements(command->'requirements') loop
      if jsonb_typeof(requirement) is distinct from 'object'
        or requirement->>'code' is null or requirement->>'code' !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,29}$'
        or jsonb_typeof(requirement->'code') is distinct from 'string'
        or jsonb_typeof(requirement->'description') is distinct from 'string'
        or length(btrim(requirement->>'description')) not between 1 and 2000
        or exists(select 1 from jsonb_object_keys(requirement) k where k not in ('code','description','source_url')) then raise exception 'Invalid requirement definition'; end if;
      if requirement ? 'source_url' and (jsonb_typeof(requirement->'source_url') is distinct from 'string'
        or requirement->>'source_url' !~ '^https://[^ /]+/') then raise exception 'Invalid requirement source URL'; end if;
    end loop;
    if (select count(distinct r->>'code') from jsonb_array_elements(command->'requirements') r)<>jsonb_array_length(command->'requirements') then raise exception 'Duplicate requirement code'; end if;
    for group_rule in select * from jsonb_array_elements(command->'completion_groups') loop
      if jsonb_typeof(group_rule) is distinct from 'object'
        or jsonb_typeof(group_rule->'minimum') is distinct from 'number' or (group_rule->>'minimum') !~ '^[0-9]+$'
        or jsonb_typeof(group_rule->'codes') is distinct from 'array'
        or jsonb_array_length(group_rule->'codes') not between 1 and 100
        or exists(select 1 from jsonb_object_keys(group_rule) k where k not in ('minimum','codes')) then raise exception 'Invalid completion group'; end if;
      if (group_rule->>'minimum')::integer not between 1 and jsonb_array_length(group_rule->'codes')
        or (select count(distinct c) from jsonb_array_elements_text(group_rule->'codes') c)<>jsonb_array_length(group_rule->'codes') then raise exception 'Invalid completion minimum'; end if;
      if exists(select 1 from jsonb_array_elements(group_rule->'codes') c where jsonb_typeof(c)<>'string'
        or not exists(select 1 from jsonb_array_elements(command->'requirements') r where r->>'code'=c#>>'{}')) then raise exception 'Unknown completion requirement'; end if;
    end loop;
    if exists(select 1 from jsonb_array_elements(command->'requirements') r where not exists(
      select 1 from jsonb_array_elements(command->'completion_groups') g, jsonb_array_elements_text(g->'codes') c where c=r->>'code'
    )) then raise exception 'Every requirement must belong to a completion group'; end if;
    if command->>'source_verified_on' is null or command->>'source_verified_on' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      or to_char((command->>'source_verified_on')::date,'YYYY-MM-DD')<>command->>'source_verified_on' then raise exception 'Invalid source verification date'; end if;
    if command ? 'catalog_context' then
      if octet_length((command->'catalog_context')::text)>8192 or exists(
        select 1 from jsonb_each(command->'catalog_context') e
        where e.key not in ('grade','adventure_type','completion_options','notes','den_list_url','source_filename','source_sha256','source_row','verification_basis')
          or (e.key='source_row' and (jsonb_typeof(e.value)<>'number' or e.value::text !~ '^[0-9]+$'))
          or (e.key<>'source_row' and jsonb_typeof(e.value)<>'string')
      ) then raise exception 'Invalid catalog context'; end if;
      -- Rich completion text is preserved for leader review; it is never executed.
      if command->'catalog_context'->>'completion_options' is distinct from 'Complete all listed requirements.'
        or coalesce(command->'catalog_context'->>'notes','')<>'' then
        if command->>'readiness_mode' is distinct from 'leader_review' then raise exception 'Catalog conditions require leader review'; end if;
      end if;
    end if;
    insert into public.pack_adventures(id,name,rank,program_version,source_url,source_verified_on,requirements,completion_groups,recorded_by,readiness_mode,catalog_context)
    values(adventure,command->>'name',command->>'rank',command->>'program_version',command->>'source_url',
      (command->>'source_verified_on')::date,command->'requirements',command->'completion_groups',actor,coalesce(command->>'readiness_mode','automatic'),coalesce(command->'catalog_context','{}'::jsonb));
    result:=jsonb_build_object('adventure_id',adventure);
  else
    happened:=coalesce((command->>'occurred_on')::date,(now() at time zone 'America/Los_Angeles')::date);
    if command ? 'occurred_on' and (command->>'occurred_on' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      or to_char(happened,'YYYY-MM-DD')<>command->>'occurred_on') then raise exception 'Invalid occurrence date'; end if;
    scout:=(command->>'scout_id')::uuid;
    expected:=(command->>'expected_revision')::integer;
    year:=command->>'scouting_year';
    if scout is null or expected is null or expected<0 or expected>2147483646 then raise exception 'Scout and expected revision required'; end if;
    if year is null or year !~ '^[0-9]{4}-[0-9]{2}$' or right(year,2)<>right((left(year,4)::int+1)::text,2) then raise exception 'Invalid scouting year'; end if;
    perform 1 from public.scouts where id=scout for update;
    if not found then raise exception 'Unknown scout'; end if;
    select * into definition from public.pack_adventures where id=adventure;
    if not found then raise exception 'Unknown adventure'; end if;
    select * into state from public.pack_advancement where scout_id=scout and adventure_id=adventure and scouting_year=year;
    if coalesce(state.revision,0)<>expected then raise exception 'Revision conflict; read current state'; end if;
    if state.revision is null then
      insert into public.pack_advancement(scout_id,adventure_id,scouting_year,revision,recorded_by)
      values(scout,adventure,year,1,actor);
    end if;
    if action='record_requirement' then
      if state.earned_on is not null then raise exception 'Revoke the earned adventure before correcting requirements'; end if;
      code:=command->>'requirement_code';
      if code is null or not exists(select 1 from jsonb_array_elements(definition.requirements) r where r->>'code'=code) then raise exception 'Unknown requirement'; end if;
      if command->>'status'='completed' then
        insert into public.pack_requirement_progress(scout_id,adventure_id,scouting_year,requirement_code,completed_on,completion_source,recorded_by)
        values(scout,adventure,year,code,happened,'individual',actor)
        on conflict on constraint pack_requirement_progress_pkey do update set completed_on=excluded.completed_on,
          completion_source='individual',recorded_at=now(),recorded_by=actor;
      elsif command->>'status'='not_completed' then
        delete from public.pack_requirement_progress where scout_id=scout and adventure_id=adventure and scouting_year=year and requirement_code=code;
      else raise exception 'Invalid requirement status'; end if;
    elsif action='earn_adventure' then
      if state.earned_on is not null then raise exception 'Adventure already earned; revoke before correcting'; end if;
      if exists(select 1 from public.pack_requirement_progress where scout_id=scout and adventure_id=adventure and scouting_year=year and completed_on>happened) then raise exception 'Earned date precedes recorded completion'; end if;
      insert into public.pack_requirement_progress(scout_id,adventure_id,scouting_year,requirement_code,completed_on,completion_source,recorded_by)
      select scout,adventure,year,r->>'code',happened,'award',actor from jsonb_array_elements(definition.requirements) r
      on conflict on constraint pack_requirement_progress_pkey do nothing;
      update public.pack_advancement set earned_on=happened where scout_id=scout and adventure_id=adventure and scouting_year=year;
    elsif action='deliver_badge' then
      if state.earned_on is null then raise exception 'Adventure must be earned before delivery'; end if;
      if happened<state.earned_on then raise exception 'Delivery date precedes earned date'; end if;
      if command->>'badge_form' is null or command->>'badge_form' not in ('belt_loop','pin') then raise exception 'Invalid badge form'; end if;
      update public.pack_advancement set badge_delivered_on=happened,badge_form=command->>'badge_form'
        where scout_id=scout and adventure_id=adventure and scouting_year=year;
    else
      if command->>'reason' is null or length(btrim(command->>'reason')) not between 1 and 500 then raise exception 'Correction reason required'; end if;
      if action='retract_badge_delivery' then
        if state.badge_delivered_on is null then raise exception 'No badge delivery to retract'; end if;
        if happened<state.badge_delivered_on then raise exception 'Retraction date precedes delivery'; end if;
        update public.pack_advancement set badge_delivered_on=null,badge_form=null where scout_id=scout and adventure_id=adventure and scouting_year=year;
      else
        if state.earned_on is null then raise exception 'No earned adventure to revoke'; end if;
        if state.badge_delivered_on is not null then raise exception 'Retract badge delivery before revoking adventure'; end if;
        if happened<state.earned_on then raise exception 'Revocation date precedes earned date'; end if;
        delete from public.pack_requirement_progress where scout_id=scout and adventure_id=adventure and scouting_year=year and completion_source='award';
        update public.pack_advancement set earned_on=null where scout_id=scout and adventure_id=adventure and scouting_year=year;
      end if;
    end if;
    update public.pack_advancement set revision=expected+1,recorded_at=now(),recorded_by=actor
      where scout_id=scout and adventure_id=adventure and scouting_year=year returning * into state;
    result:=jsonb_build_object('scout_id',scout,'adventure_id',adventure,'scouting_year',year,'revision',state.revision,
      'occurred_on',happened,'earned_on',state.earned_on,'badge_delivered_on',state.badge_delivered_on);
  end if;
  insert into public.pack_commands(request_id,command,result,recorded_by) values(request_id,command,result,actor);
  return result;
end;
$$;
revoke all on function private.record_advancement_operation(uuid,jsonb) from public,anon,authenticated;

create function public.record_pack_operation(request_id uuid, command jsonb) returns jsonb
language plpgsql security definer set search_path='' set statement_timeout='5s' as $$
begin
  if not private.can_record() then raise exception 'Recording access denied' using errcode='42501'; end if;
  if command->>'action' in ('define_adventure','record_requirement','earn_adventure','deliver_badge','revoke_adventure','retract_badge_delivery') then
    return private.record_advancement_operation(request_id,command);
  end if;
  return private.record_pack_operation(request_id,command);
end;
$$;
revoke all on function public.record_pack_operation(uuid,jsonb) from public,anon;
grant execute on function public.record_pack_operation(uuid,jsonb) to authenticated;

create function public.read_pack_advancement(entity text, scout_id uuid default null, adventure_id uuid default null,
  scouting_year text default null, page_offset integer default 0, page_limit integer default 50) returns jsonb
language plpgsql stable security invoker set search_path='' set statement_timeout='5s' as $$
#variable_conflict use_variable
declare rows jsonb; total integer;
begin
  if not public.is_approved_leader() then raise exception 'Access denied' using errcode='42501'; end if;
  if entity is null or entity not in ('adventures','advancement','requirements') or page_limit is null or page_limit not between 1 and 100
    or page_offset is null or page_offset not between 0 and 10000 then raise exception 'Invalid query'; end if;
  if entity='adventures' and (scout_id is not null or scouting_year is not null) then raise exception 'Scout/year filters require advancement or requirements'; end if;
  with records as (
    select to_jsonb(a) as record,a.id::text as key from public.pack_adventures a where entity='adventures'
      and (adventure_id is null or a.id=adventure_id)
    union all
    select to_jsonb(a)||jsonb_build_object('completion_ready',case when (select d.readiness_mode from public.pack_adventures d where d.id=a.adventure_id)='leader_review' then null else not exists(
      select 1 from public.pack_adventures d,jsonb_array_elements(d.completion_groups) g
      where d.id=a.adventure_id and (select count(*) from public.pack_requirement_progress p
        where p.scout_id=a.scout_id and p.adventure_id=a.adventure_id and p.scouting_year=a.scouting_year
          and p.requirement_code in (select jsonb_array_elements_text(g->'codes'))) < (g->>'minimum')::int
    ) end),a.scout_id::text||a.adventure_id::text||a.scouting_year from public.pack_advancement a where entity='advancement'
      and (scout_id is null or a.scout_id=scout_id) and (adventure_id is null or a.adventure_id=adventure_id)
      and (scouting_year is null or a.scouting_year=scouting_year)
    union all
    select to_jsonb(p),p.scout_id::text||p.adventure_id::text||p.scouting_year||p.requirement_code from public.pack_requirement_progress p where entity='requirements'
      and (scout_id is null or p.scout_id=scout_id) and (adventure_id is null or p.adventure_id=adventure_id)
      and (scouting_year is null or p.scouting_year=scouting_year)
  ), page as(select record from records order by key limit page_limit offset page_offset)
  select (select count(*) from records),coalesce(jsonb_agg(page.record),'[]'::jsonb) into total,rows from page;
  return jsonb_build_object('total',total,'rows',rows,'next_offset',case when page_offset+jsonb_array_length(rows)<total then page_offset+jsonb_array_length(rows) else null end);
end;
$$;
revoke all on function public.read_pack_advancement(text,uuid,uuid,text,integer,integer) from public,anon;
grant execute on function public.read_pack_advancement(text,uuid,uuid,text,integer,integer) to authenticated;
