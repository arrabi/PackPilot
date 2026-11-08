-- Child-scoped home work and shared family conversations. No direct client writes.
create table public.pack_home_assignments (
 id uuid primary key, scout_id uuid not null references public.scouts(id),
 adventure_id uuid not null references public.pack_adventures(id), scouting_year text not null,
 requirement_code text not null, instructions text not null default '' check(length(instructions)<=2000),
 assigned_on date not null, due_on date check(due_on is null or due_on>=assigned_on),
 status text not null default 'todo' check(status in('todo','submitted','approved','returned','cancelled')),
 completed_on date, parent_note text not null default '' check(length(parent_note)<=2000),
 submitted_by uuid references auth.users(id), submitted_at timestamptz,
 review_note text not null default '' check(length(review_note)<=2000), reviewed_by uuid references auth.users(id), reviewed_at timestamptz,
 revision integer not null default 1 check(revision>0), created_by uuid not null references auth.users(id),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create unique index home_assignment_active_key on public.pack_home_assignments(scout_id,adventure_id,scouting_year,requirement_code) where status in('todo','submitted','returned');
create table public.pack_family_messages (
 id uuid primary key, scout_id uuid not null references public.scouts(id), scouting_year text not null,
 body text not null check(length(btrim(body)) between 1 and 4000),
 sender_role text not null check(sender_role in('parent','leader')), sender_name text not null,
 recorded_by uuid not null references auth.users(id), recorded_at timestamptz not null default now()
);
create index family_messages_child on public.pack_family_messages(scout_id,scouting_year,recorded_at,id);
create table public.pack_family_message_reads (
 user_id uuid not null references auth.users(id), message_id uuid not null references public.pack_family_messages(id),
 read_at timestamptz not null default now(),primary key(user_id,message_id)
);
create table public.pack_family_commands (
 request_id uuid primary key, command jsonb not null, result jsonb not null,
 recorded_by uuid not null references auth.users(id),recorded_at timestamptz not null default now()
);
alter table public.pack_home_assignments enable row level security;
alter table public.pack_family_messages enable row level security;
alter table public.pack_family_message_reads enable row level security;
alter table public.pack_family_commands enable row level security;
revoke all on public.pack_home_assignments,public.pack_family_messages,public.pack_family_message_reads,public.pack_family_commands from public,anon,authenticated;

create function private.family_work_data(child_ids uuid[],year text) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object(
 'assignments',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'scout_id',a.scout_id,'adventure_id',a.adventure_id,'scouting_year',a.scouting_year,'requirement_code',a.requirement_code,'instructions',a.instructions,'assigned_on',a.assigned_on,'due_on',a.due_on,
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

create function public.read_leader_family_work(scouting_year text default '2026-27') returns jsonb
language plpgsql stable security definer set search_path='' set statement_timeout='5s' as $$
#variable_conflict use_variable
declare ids uuid[];
begin
 if not private.is_approved_leader()then raise exception 'Leader access denied' using errcode='42501';end if;
 if scouting_year is null or scouting_year !~ '^[0-9]{4}-[0-9]{2}$'or right(scouting_year,2)<>right((left(scouting_year,4)::int+1)::text,2)then raise exception 'Invalid scouting year';end if;
 select coalesce(array_agg(s.id),array[]::uuid[])into ids from public.scouts s where coalesce(s.den,'') !~* '^\s*\(withdraw\)';
 return private.family_work_data(ids,scouting_year);
end;$$;
revoke all on function public.read_leader_family_work(text) from public,anon;
grant execute on function public.read_leader_family_work(text) to authenticated;

create function public.record_family_operation(request_id uuid,command jsonb) returns jsonb
language plpgsql security definer set search_path='' set statement_timeout='10s' as $$
#variable_conflict use_variable
declare
 actor uuid:=auth.uid();action text:=command->>'action';child uuid;year text:=command->>'scouting_year';
 allowed text[];prev public.pack_family_commands;assignment public.pack_home_assignments;
 definition public.pack_adventures;message public.pack_family_messages;result jsonb;expected integer;
 happened date;due date;note text;body text;sender text;name text;state public.pack_advancement;new_id uuid;
 rank text;already boolean;leader boolean;parent boolean;
begin
 if actor is null or not exists(select 1 from auth.users u where u.id=actor and u.email_confirmed_at is not null)then raise exception 'Verified account required'using errcode='42501';end if;
 if request_id is null or command is null or jsonb_typeof(command)<>'object'or length(command::text)>20000 then raise exception 'Invalid family command';end if;
 if action not in('assign_requirement','submit_assignment','review_assignment','cancel_assignment','send_family_message','mark_family_read')or action is null then raise exception 'Unknown family action';end if;
 child:=(command->>'scout_id')::uuid;
 leader:=private.is_approved_leader();parent:=private.parent_can_read_scout(child);
 if action in('assign_requirement','review_assignment','cancel_assignment')and(not leader or not private.can_record())then raise exception 'Leader recording access denied'using errcode='42501';end if;
 if action='submit_assignment'and not parent then raise exception 'Family access denied'using errcode='42501';end if;
 if action='send_family_message'then
  sender:=command->>'as_role';
  if sender is null or sender not in('leader','parent')then raise exception 'Choose message role';end if;
  if(sender='leader'and(not leader or not private.can_record()))or(sender='parent'and not parent)then raise exception 'Family message access denied'using errcode='42501';end if;
 end if;
 if action='mark_family_read'and not(leader or parent)then raise exception 'Family access denied'using errcode='42501';end if;
 if year is null or year !~ '^[0-9]{4}-[0-9]{2}$'or right(year,2)<>right((left(year,4)::int+1)::text,2)then raise exception 'Invalid scouting year';end if;
 allowed:=array['action','scout_id','scouting_year'];
 case action
 when 'assign_requirement'then allowed:=allowed||array['adventure_id','requirement_code','assigned_on','due_on','instructions'];
 when 'submit_assignment'then allowed:=allowed||array['assignment_id','expected_revision','completed_on','parent_note'];
 when 'review_assignment'then allowed:=allowed||array['assignment_id','expected_revision','decision','review_note'];
 when 'cancel_assignment'then allowed:=allowed||array['assignment_id','expected_revision','review_note'];
 when 'send_family_message'then allowed:=allowed||array['body','as_role'];
 when 'mark_family_read'then allowed:=allowed||array['through_message_id'];
 end case;
 if exists(select 1 from jsonb_each(command)e where not(e.key=any(allowed))or jsonb_typeof(e.value)='null'or(e.key='expected_revision'and(jsonb_typeof(e.value)<>'number'or e.value::text !~ '^[0-9]+$'))or(e.key<>'expected_revision'and jsonb_typeof(e.value)<>'string'))then raise exception 'Invalid family command fields';end if;
 perform pg_advisory_xact_lock(hashtextextended('family-request:'||request_id::text,0));
 select * into prev from public.pack_family_commands c where c.request_id=request_id;
 if found then
  if prev.recorded_by<>actor or prev.command<>command then raise exception 'Request ID conflict';end if;
  return prev.result;
 end if;
 select case lower(btrim(regexp_replace(coalesce(s.den,''),'^\d+\s*[-–]\s*','')))
  when 'lions'then 'lion'when 'lion'then 'lion'when 'tigers'then 'tiger'when 'tiger'then 'tiger'
  when 'wolves'then 'wolf'when 'wolf'then 'wolf'when 'bears'then 'bear'when 'bear'then 'bear'
  when 'webelos'then 'webelos'when 'aol'then 'arrow_of_light'when 'arrow of light'then 'arrow_of_light'end into rank
 from public.scouts s where s.id=child and coalesce(s.den,'') !~* '^\s*\(withdraw\)'for update;
 if not found then raise exception 'Active scout required';end if;
 if action='assign_requirement'then
  select * into definition from public.pack_adventures a where a.id=(command->>'adventure_id')::uuid;
  if not found or definition.rank is distinct from rank or not exists(select 1 from jsonb_array_elements(definition.requirements)r where r->>'code'=command->>'requirement_code')then raise exception 'Choose a valid requirement for this den';end if;
  if not exists(select 1 from public.parent_scout_links l where l.scout_id=child and l.active)then raise exception 'No parent access linked to this scout';end if;
  happened:=(command->>'assigned_on')::date;due:=(command->>'due_on')::date;note:=coalesce(command->>'instructions','');
  if happened is null or command->>'assigned_on'!~ '^\d{4}-\d{2}-\d{2}$'or to_char(happened,'YYYY-MM-DD')<>command->>'assigned_on'or happened>(now()at time zone'America/Los_Angeles')::date or(due is not null and(due<happened or command->>'due_on'!~ '^\d{4}-\d{2}-\d{2}$'or to_char(due,'YYYY-MM-DD')<>command->>'due_on'))or length(note)>2000 then raise exception 'Invalid assignment dates or instructions';end if;
  already:=exists(select 1 from public.pack_advancement a where a.scout_id=child and a.adventure_id=definition.id and a.scouting_year=year and a.earned_on is not null)or exists(select 1 from public.pack_requirement_progress p where p.scout_id=child and p.adventure_id=definition.id and p.scouting_year=year and p.requirement_code=command->>'requirement_code');
  select a.id into new_id from public.pack_home_assignments a where a.scout_id=child and a.adventure_id=definition.id and a.scouting_year=year and a.requirement_code=command->>'requirement_code'and a.status in('todo','submitted','returned');
  if already then result:=jsonb_build_object('status','already_completed');
  elsif new_id is not null then result:=jsonb_build_object('status','already_assigned','assignment_id',new_id);
  else
   insert into public.pack_home_assignments(id,scout_id,adventure_id,scouting_year,requirement_code,instructions,assigned_on,due_on,created_by)values(request_id,child,definition.id,year,command->>'requirement_code',note,happened,due,actor);
   result:=jsonb_build_object('status','assigned','assignment_id',request_id);
  end if;
 elsif action in('submit_assignment','review_assignment','cancel_assignment')then
  select * into assignment from public.pack_home_assignments a where a.id=(command->>'assignment_id')::uuid and a.scout_id=child and a.scouting_year=year for update;
  if not found then raise exception 'Assignment unavailable';end if;
  if jsonb_typeof(command->'expected_revision')<>'number'or command->>'expected_revision'!~ '^\d+$'then raise exception 'Expected revision required';end if;
  expected:=(command->>'expected_revision')::integer;
  if expected is null or expected<>assignment.revision then raise exception 'Assignment changed; refresh and retry';end if;
  if action='submit_assignment'then
   if assignment.status not in('todo','returned')then raise exception 'Assignment is not accepting submissions';end if;
   if exists(select 1 from public.pack_advancement a where a.scout_id=child and a.adventure_id=assignment.adventure_id and a.scouting_year=year and a.earned_on is not null)or exists(select 1 from public.pack_requirement_progress p where p.scout_id=child and p.adventure_id=assignment.adventure_id and p.scouting_year=year and p.requirement_code=assignment.requirement_code)then raise exception 'Requirement already completed';end if;
   happened:=(command->>'completed_on')::date;note:=coalesce(command->>'parent_note','');
   if happened is null or command->>'completed_on'!~ '^\d{4}-\d{2}-\d{2}$'or to_char(happened,'YYYY-MM-DD')<>command->>'completed_on'or happened>(now()at time zone'America/Los_Angeles')::date or length(note)>2000 then raise exception 'Invalid completion date or note';end if;
   update public.pack_home_assignments a set status='submitted',completed_on=happened,parent_note=note,submitted_by=actor,submitted_at=now(),revision=a.revision+1,updated_at=now()where a.id=assignment.id;
   result:=jsonb_build_object('status','submitted','assignment_id',assignment.id);
  elsif action='cancel_assignment'then
   if assignment.status not in('todo','submitted','returned')then raise exception 'Assignment cannot be cancelled';end if;
   note:=coalesce(command->>'review_note','');if length(note)>2000 then raise exception 'Review note too long';end if;
   update public.pack_home_assignments a set status='cancelled',review_note=note,reviewed_by=actor,reviewed_at=now(),revision=a.revision+1,updated_at=now()where a.id=assignment.id;
   result:=jsonb_build_object('status','cancelled','assignment_id',assignment.id);
  else
   note:=coalesce(command->>'review_note','');if assignment.status<>'submitted'or command->>'decision'not in('approve','return')or command->>'decision'is null or length(note)>2000 then raise exception 'Choose a submitted assignment and review decision';end if;
   if command->>'decision'='return'then
    if length(btrim(note))=0 then raise exception 'Explain what the parent should revisit';end if;
    update public.pack_home_assignments a set status='returned',review_note=note,reviewed_by=actor,reviewed_at=now(),revision=a.revision+1,updated_at=now()where a.id=assignment.id;
   else
    select * into definition from public.pack_adventures d where d.id=assignment.adventure_id;
    select * into state from public.pack_advancement a where a.scout_id=child and a.adventure_id=assignment.adventure_id and a.scouting_year=year;
    if state.earned_on is null and not exists(select 1 from public.pack_requirement_progress p where p.scout_id=child and p.adventure_id=assignment.adventure_id and p.scouting_year=year and p.requirement_code=assignment.requirement_code)then
     perform public.record_pack_operation(md5(request_id::text||':approve')::uuid,jsonb_build_object('action','record_requirement','scout_id',child,'adventure_id',assignment.adventure_id,'scouting_year',year,'requirement_code',assignment.requirement_code,'status','completed','occurred_on',assignment.completed_on,'expected_revision',coalesce(state.revision,0)));
    end if;
    update public.pack_home_assignments a set status='approved',review_note=note,reviewed_by=actor,reviewed_at=now(),revision=a.revision+1,updated_at=now()where a.id=assignment.id;
   end if;
   result:=jsonb_build_object('status',case when command->>'decision'='approve'then 'approved'else 'returned'end,'assignment_id',assignment.id);
  end if;
 elsif action='send_family_message'then
  body:=btrim(command->>'body');if body is null or length(body)not between 1 and 4000 then raise exception 'Message must contain 1–4000 characters';end if;
  if not exists(select 1 from public.parent_scout_links l where l.scout_id=child and l.active)then raise exception 'No parent access linked to this scout';end if;
  select case when sender='parent'then coalesce(case when private.canonical_leader_email(s.parent_1_email)=private.canonical_leader_email(u.email)then nullif(s.parent_1_name,'')end,case when private.canonical_leader_email(s.parent_2_email)=private.canonical_leader_email(u.email)then nullif(s.parent_2_name,'')end,'Parent')else coalesce(nullif(to_jsonb(u)->'raw_user_meta_data'->>'full_name',''),'Den leader')end into name from auth.users u join public.scouts s on s.id=child where u.id=actor;
  insert into public.pack_family_messages(id,scout_id,scouting_year,body,sender_role,sender_name,recorded_by)values(request_id,child,year,body,sender,left(name,100),actor);
  result:=jsonb_build_object('status','sent','message_id',request_id);
 else
  select * into message from public.pack_family_messages m where m.id=(command->>'through_message_id')::uuid and m.scout_id=child and m.scouting_year=year;
  if not found then raise exception 'Message unavailable';end if;
  insert into public.pack_family_message_reads(user_id,message_id)select actor,m.id from public.pack_family_messages m where m.scout_id=child and m.scouting_year=year and(m.recorded_at,m.id)<=(message.recorded_at,message.id)on conflict do nothing;
  result:=jsonb_build_object('status','read');
 end if;
 insert into public.pack_family_commands(request_id,command,result,recorded_by)values(request_id,command,result,actor);
 return result;
end;$$;
revoke all on function public.record_family_operation(uuid,jsonb)from public,anon;
grant execute on function public.record_family_operation(uuid,jsonb)to authenticated;

create function public.record_family_batch(entries jsonb)returns jsonb
language plpgsql security invoker set search_path='' set statement_timeout='20s' as $$
declare entry jsonb;results jsonb:='[]'::jsonb;
begin
 if entries is null or jsonb_typeof(entries)<>'array'or jsonb_array_length(entries)not between 1 and 25 or length(entries::text)>60000 then raise exception 'Batch must contain 1–25 family commands';end if;
 for entry in select value from jsonb_array_elements(entries)with ordinality as e(value,n) order by value->'command'->>'scout_id',n loop
  if jsonb_typeof(entry)<>'object'or not(entry?'request_id'and entry?'command')or exists(select 1 from jsonb_object_keys(entry)k where k not in('request_id','command'))then raise exception 'Invalid family batch entry';end if;
  results:=results||jsonb_build_array(public.record_family_operation((entry->>'request_id')::uuid,entry->'command'));
 end loop;
 return results;
end;$$;
revoke all on function public.record_family_batch(jsonb)from public,anon;
grant execute on function public.record_family_batch(jsonb)to authenticated;

-- One minimal data projection shared by real family access and admin preview.
-- It accepts explicit IDs but is executable only by the function owner.
create or replace function private.parent_portal_projection(child_ids uuid[],scouting_year text) returns jsonb
language plpgsql stable security definer set search_path='' set statement_timeout='5s' as $$
#variable_conflict use_variable
declare result jsonb;
begin
 if scouting_year is null or scouting_year !~ '^[0-9]{4}-[0-9]{2}$' or right(scouting_year,2)<>right((left(scouting_year,4)::int+1)::text,2) then raise exception 'Invalid scouting year'; end if;
 with children as materialized (
   select s.id,s.scout_name,s.den,s.grade,s.bsa_member_id from public.scouts s
   where s.id=any(child_ids) and coalesce(s.den,'') !~* '^\s*\(withdraw\)'
 ), ranks as (
   select distinct case lower(regexp_replace(coalesce(den,''),'^\d+\s*[-–]\s*',''))
    when 'lions' then 'lion' when 'lion' then 'lion' when 'tigers' then 'tiger' when 'tiger' then 'tiger'
    when 'wolves' then 'wolf' when 'wolf' then 'wolf' when 'bears' then 'bear' when 'bear' then 'bear'
    when 'webelos' then 'webelos' when 'aol' then 'arrow_of_light' when 'arrow of light' then 'arrow_of_light' end as rank
   from children
 )
 select jsonb_build_object(
   'scouts',coalesce((select jsonb_agg(to_jsonb(c)order by c.scout_name)from children c),'[]'::jsonb),
   'adventures',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'name',a.name,'rank',a.rank,'program_version',a.program_version,'source_url',a.source_url,'requirements',a.requirements,'readiness_mode',a.readiness_mode,'catalog_context',a.catalog_context) order by a.rank,a.name)from public.pack_adventures a where a.rank in(select rank from ranks) or a.id in(select adventure_id from public.pack_home_assignments where scout_id=any(child_ids)and scouting_year=parent_portal_projection.scouting_year)),'[]'::jsonb),
   'advancement',coalesce((select jsonb_agg(jsonb_build_object('scout_id',a.scout_id,'adventure_id',a.adventure_id,'earned_on',a.earned_on,'badge_delivered_on',a.badge_delivered_on,'badge_form',a.badge_form))from public.pack_advancement a join children c on c.id=a.scout_id where a.scouting_year=scouting_year),'[]'::jsonb),
   'progress',coalesce((select jsonb_agg(jsonb_build_object('scout_id',p.scout_id,'adventure_id',p.adventure_id,'requirement_code',p.requirement_code,'completed_on',p.completed_on,'completion_source',p.completion_source))from public.pack_requirement_progress p join children c on c.id=p.scout_id where p.scouting_year=scouting_year),'[]'::jsonb),
   'registrations',coalesce((select jsonb_agg(jsonb_build_object('scout_id',r.scout_id,'platform',r.platform,'status',r.status,'occurred_on',r.occurred_on))from public.pack_registrations r join children c on c.id=r.scout_id where r.scouting_year=scouting_year),'[]'::jsonb)
 ) into result;
 return result || private.family_work_data(child_ids,scouting_year);
end;
$$;
revoke all on function private.parent_portal_projection(uuid[],text) from public,anon,authenticated;
