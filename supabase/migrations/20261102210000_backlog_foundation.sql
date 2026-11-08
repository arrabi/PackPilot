-- Shared internal planning is restricted to approved adult leaders on the server.
alter table public.pack_events add column event_type text not null default 'event' check(event_type in('event','pack_meeting','den_meeting','outing','pack_activity'));
alter table public.pack_events add column location text not null default '' check(length(location)<=500);
alter table public.pack_volunteer_jobs add column signup_date date;
alter table public.pack_meeting_plans add column event_id uuid references public.pack_events(id);
alter table public.pack_meeting_plans add column created_by uuid;
update public.pack_meeting_plans set created_by=recorded_by;
alter table public.pack_meeting_plans alter column created_by set not null;
drop index public.meeting_plan_scope;
-- A plan has an independent ID and author, even on the same den/date.
create index meeting_plan_den_date on public.pack_meeting_plans(den,meeting_date);

create table public.pack_leader_notes (
 id uuid primary key, den text not null check(den in('0-Lions','1-Tigers','2-Wolves','3-Bears','4-Webelos','5-AOL')),
 owner_id uuid not null references auth.users(id), body text not null check(length(body)<=20000),
 revision integer not null default 1, recorded_at timestamptz not null default now(),recorded_by uuid not null,
 unique(owner_id,den)
);
alter table public.pack_leader_notes enable row level security;
revoke all on public.pack_leader_notes from public,anon,authenticated;

alter function public.record_pack_community(uuid,jsonb) rename to record_pack_community_legacy;
alter function public.record_pack_community_legacy(uuid,jsonb) set schema private;
revoke all on function private.record_pack_community_legacy(uuid,jsonb)from public,anon,authenticated;
create function public.record_pack_community(request_id uuid,command jsonb)returns void
language plpgsql security definer set search_path='' set statement_timeout='15s' as $$
#variable_conflict use_variable
declare action text:=command->>'action'; target uuid:=(command->>'id')::uuid; prior public.pack_community_commands; e public.pack_events;
begin
 if not private.is_approved_leader()and not exists(select 1 from public.scouts s where private.parent_can_read_scout(s.id))then raise exception 'Authorized account required'using errcode='42501';end if;
 if request_id is null or target is null or jsonb_typeof(command)is distinct from 'object'then raise exception 'Invalid command';end if;
 perform pg_advisory_xact_lock(hashtextextended('community-request:'||request_id::text,0));
 select * into prior from public.pack_community_commands c where c.request_id=request_id;
 if action='note'then
  if not private.is_approved_leader()then raise exception 'Leader access required'using errcode='42501';end if;
  if prior.request_id is not null then
   if prior.recorded_by<>auth.uid()or prior.command<>(command-'body')||jsonb_build_object('body_hash',md5(coalesce(command->>'body','')))then raise exception 'Request ID conflict';end if;return;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('note:'||auth.uid()::text||':'||(command->>'den'),0));
  if exists(select 1 from public.pack_leader_notes n where n.id=target and n.owner_id<>auth.uid())then raise exception 'Only the note owner may edit it'using errcode='42501';end if;
  if coalesce((select n.revision from public.pack_leader_notes n where n.id=target),0)<>coalesce((command->>'revision')::int,0)then raise exception 'Note changed; refresh';end if;
  insert into public.pack_leader_notes(id,den,owner_id,body,recorded_by)values(target,command->>'den',auth.uid(),coalesce(command->>'body',''),auth.uid())
  on conflict(id)do update set body=excluded.body,recorded_at=now(),recorded_by=auth.uid(),revision=pack_leader_notes.revision+1;
  insert into public.pack_community_commands values(request_id,(command-'body')||jsonb_build_object('body_hash',md5(coalesce(command->>'body',''))),auth.uid(),now());return;
 end if;
 if action in('event','job','meeting')and not private.can_record()then raise exception 'Leader recording access required'using errcode='42501';end if;
 if action='event'and(coalesce(command->>'event_type','event')not in('event','pack_meeting','den_meeting','outing','pack_activity')or length(coalesce(command->>'location',''))>500)then raise exception 'Invalid event type or location';end if;
 if action='event'and command->>'event_type'='den_meeting'and nullif(command->>'den','')is null then raise exception 'Choose a den for a den meeting';end if;
 if action='meeting'and nullif(command->>'event_id','')is not null then
  select * into e from public.pack_events where id=(command->>'event_id')::uuid;
  if not found or e.cancelled or e.event_date<>(command->>'date')::date or(e.den is not null and e.den is distinct from nullif(command->>'den',''))then raise exception 'Choose a matching active meeting event';end if;
 end if;
 -- The legacy writer checks permissions, concurrency and the exact original command on retries.
 if action='meeting'and not exists(select 1 from public.pack_meeting_plans where id=target)then
  -- Its insert omits created_by; a trigger supplies the authenticated author.
  null;
 end if;
 perform private.record_pack_community_legacy(request_id,command);
 if prior.request_id is not null then return;end if;
 if action='event'then update public.pack_events set event_type=coalesce(command->>'event_type','event'),location=coalesce(command->>'location','')where id=target;
 elsif action='job'then update public.pack_volunteer_jobs set signup_date=nullif(command->>'signup_date','')::date where id=target;
 elsif action='meeting'then update public.pack_meeting_plans set event_id=nullif(command->>'event_id','')::uuid where id=target;
 end if;
end;$$;
revoke all on function public.record_pack_community(uuid,jsonb)from public,anon;
grant execute on function public.record_pack_community(uuid,jsonb)to authenticated;
create function private.meeting_author()returns trigger language plpgsql set search_path='' as $$begin new.created_by:=coalesce(new.created_by,auth.uid(),new.recorded_by);return new;end;$$;
revoke all on function private.meeting_author()from public,anon,authenticated;
create trigger meeting_author before insert on public.pack_meeting_plans for each row execute function private.meeting_author();

create function public.read_leader_notes()returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if not private.is_approved_leader()then raise exception 'Leader access required'using errcode='42501';end if;
 return(select coalesce(jsonb_agg(to_jsonb(n)order by n.den,n.recorded_at),'[]')from public.pack_leader_notes n where n.owner_id=auth.uid()or private.is_pack_admin());
end;$$;
revoke all on function public.read_leader_notes()from public,anon;
grant execute on function public.read_leader_notes()to authenticated;
create or replace function public.read_pack_community(as_parent boolean default false) returns jsonb
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
 'meetings',case when leader then(select coalesce(jsonb_agg(to_jsonb(m)order by m.meeting_date,m.den nulls first),'[]')from public.pack_meeting_plans m)else '[]'::jsonb end,
 'photos',(select coalesce(jsonb_agg(to_jsonb(p)),'[]')from public.pack_family_photos p where p.scout_id=any(ids)),
 'progress',case when leader then(select coalesce(jsonb_agg(to_jsonb(p)),'[]')from public.pack_requirement_progress p)else '[]'::jsonb end,
 'advancement',case when leader then(select coalesce(jsonb_agg(to_jsonb(v)),'[]')from public.pack_advancement v)else '[]'::jsonb end,
 'priorities',case when leader then(select coalesce(jsonb_agg(to_jsonb(p)),'[]')from public.pack_den_plans p)else '[]'::jsonb end,
 'is_admin',private.is_pack_admin()and not as_parent,
 'adventures',case when leader then (select coalesce(jsonb_agg(jsonb_build_object('id',a.id,'name',a.name,'rank',a.rank,'requirements',a.requirements,'catalog_context',a.catalog_context,'source_url',a.source_url,'program_version',a.program_version,'completion_groups',a.completion_groups)),'[]')from public.pack_adventures a)else '[]'::jsonb end);
end;$$;
revoke all on function public.read_pack_community(boolean) from public,anon;
grant execute on function public.read_pack_community(boolean) to authenticated;


-- Every application mutation records changed values, independent of its UI/import path.
create table private.pack_change_log (
 id bigint generated always as identity primary key, table_name text not null,record_id text not null,record_key jsonb not null,
 scout_id uuid, den text, owner_id uuid, actor_id uuid, actor_name text not null,actor_kind text not null,
 action text not null,effective_on text, recorded_at timestamptz not null default now(),changes jsonb not null
);
create index pack_change_scout on private.pack_change_log(scout_id,id desc);
create index pack_change_record on private.pack_change_log(table_name,record_id,id desc);
alter table private.pack_change_log enable row level security;
revoke all on private.pack_change_log from public,anon,authenticated;
create function private.capture_pack_change()returns trigger
language plpgsql security definer set search_path='' as $$
declare before_value jsonb:=case when tg_op='INSERT'then '{}'::jsonb else to_jsonb(old)end;
 after_value jsonb:=case when tg_op='DELETE'then '{}'::jsonb else to_jsonb(new)end;
 row_value jsonb;diff jsonb;key_value jsonb; child uuid; label text;kind text;record text;
begin
 if current_setting('pack.privacy_erasure',true)='on'then return coalesce(new,old);end if;
 row_value:=case when tg_op='DELETE'then before_value else after_value end;
 -- Retain metadata rather than sensitive photo payloads or generated package contents.
 if tg_table_name='pack_family_photos'then
  if before_value?'image'then before_value:=(before_value-'image')||jsonb_build_object('image_hash',md5(before_value->>'image'));end if;
  if after_value?'image'then after_value:=(after_value-'image')||jsonb_build_object('image_hash',md5(after_value->>'image'));end if;
 end if;
 select coalesce(jsonb_object_agg(k,jsonb_build_object('before',before_value->k,'after',after_value->k)),'{}')into diff
 from(select jsonb_object_keys(before_value||after_value)k)x where before_value->k is distinct from after_value->k and k not in('revision','recorded_at','recorded_by','updated_at');
 if diff='{}'then return coalesce(new,old);end if;
 select coalesce(jsonb_object_agg(e.key,e.value),'{}')into key_value from jsonb_each(row_value)e where e.key in('id','request_id','scout_id','adventure_id','scouting_year','requirement_code','platform','activity_id','item_id','owner_id','user_id','event_id','job_id','kind','den');
 record:=coalesce(row_value->>'id',row_value->>'request_id',nullif(concat_ws('|',row_value->>'scout_id',row_value->>'adventure_id',row_value->>'scouting_year',row_value->>'requirement_code',row_value->>'platform',row_value->>'activity_id',row_value->>'item_id',row_value->>'owner_id',row_value->>'user_id',row_value->>'event_id',row_value->>'job_id',row_value->>'kind',case when not row_value?'scout_id'then row_value->>'den'end),''),tg_table_name);
 child:=case when tg_table_name='scouts'then(row_value->>'id')::uuid else coalesce(row_value->>'scout_id',row_value->'command'->>'scout_id')::uuid end;
 select coalesce(to_jsonb(u)->'raw_user_meta_data'->>'full_name',u.email)into label from auth.users u where u.id=auth.uid();
 kind:=case when auth.uid()is null then coalesce(nullif(current_setting('pack.audit_source',true),''),'import or automation')when private.is_pack_admin()then 'administrator'when private.is_approved_leader()then 'den leader'else 'parent'end;
 insert into private.pack_change_log(table_name,record_id,record_key,scout_id,den,owner_id,actor_id,actor_name,actor_kind,action,effective_on,changes)
 values(tg_table_name,record,key_value,child,coalesce(row_value->>'den',(select s.den from public.scouts s where s.id=child)),case when tg_table_name='pack_leader_notes'then(row_value->>'owner_id')::uuid end,auth.uid(),coalesce(label,kind),kind,tg_op,coalesce(row_value->>'occurred_on',row_value->>'completed_on',row_value->>'earned_on',row_value->>'assigned_on',row_value->>'meeting_date',row_value->>'event_date'),diff);
 return coalesce(new,old);
end;$$;
revoke all on function private.capture_pack_change()from public,anon,authenticated;
do $$declare t text;begin
 foreach t in array array['scouts','leader_access','parent_scout_links','pack_activities','pack_attendance','pack_registrations','pack_adventures','pack_advancement','pack_requirement_progress','pack_equipment_state','pack_equipment_events','pack_inventory_items','pack_inventory_events','pack_den_plans','pack_shirt_import_history','pack_home_assignments','pack_family_messages','pack_family_message_reads','pack_events','pack_event_bookings','pack_volunteer_jobs','pack_volunteers','pack_meeting_plans','pack_family_photos','pack_leader_notes']loop
  execute format('create trigger pack_audit after insert or update or delete on public.%I for each row execute function private.capture_pack_change()',t);
 end loop;
end;$$;
create function private.can_read_pack_change(entry private.pack_change_log)returns boolean
language sql stable security definer set search_path='' as $$
 select case when entry.table_name='pack_leader_notes'then private.is_approved_leader()and(entry.owner_id=auth.uid()or private.is_pack_admin())
 when entry.table_name in('leader_access')then private.is_pack_admin()
 else private.is_approved_leader()or(entry.scout_id is not null and private.parent_can_read_scout(entry.scout_id)and entry.table_name not in('pack_meeting_plans','pack_leader_notes'))end;
$$;
revoke all on function private.can_read_pack_change(private.pack_change_log)from public,anon,authenticated;
create function public.read_pack_history(filters jsonb default '{}')returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb; skip integer:=greatest(0,coalesce((filters->>'offset')::int,0));take integer:=least(200,greatest(1,coalesce((filters->>'limit')::int,100)));
begin
 if not private.is_approved_leader()and not exists(select 1 from public.scouts s where private.parent_can_read_scout(s.id))then raise exception 'Access denied'using errcode='42501';end if;
 with matching as(select l.* from private.pack_change_log l where private.can_read_pack_change(l)
 and(nullif(filters->>'scout_id','')is null or l.scout_id=(filters->>'scout_id')::uuid)
 and(nullif(filters->>'den','')is null or l.den=filters->>'den')
 and(nullif(filters->>'table','')is null or l.table_name=filters->>'table')
 and(nullif(filters->>'record_id','')is null or l.record_id=filters->>'record_id')
 and(nullif(filters->>'field','')is null or l.changes?(filters->>'field'))
 and(nullif(filters->>'actor','')is null or l.actor_name ilike '%'||(filters->>'actor')||'%')
 and(nullif(filters->>'from','')is null or l.recorded_at>=(filters->>'from')::timestamptz)
 and(nullif(filters->>'to','')is null or l.recorded_at<(filters->>'to')::date+interval '1 day'))
 select jsonb_build_object('total',(select count(*)from matching),'rows',(select coalesce(jsonb_agg(to_jsonb(x)),'[]')from(select * from matching order by id desc limit take offset skip)x),'next_offset',case when(select count(*)from matching)>skip+take then skip+take else null end)into result;
 return result;
end;$$;
create function public.read_pack_attribution(child uuid)returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 if not private.is_approved_leader()and not private.parent_can_read_scout(child)then raise exception 'Access denied'using errcode='42501';end if;
 return(select coalesce(jsonb_agg(to_jsonb(x)),'[]')from(
 select distinct on(l.table_name,l.record_id,e.key)l.table_name,l.record_id,l.record_key,e.key field,e.value->'after'value,l.actor_name,l.actor_kind,l.recorded_at,l.effective_on,l.action
 from private.pack_change_log l cross join lateral jsonb_each(l.changes)e where l.scout_id=child and private.can_read_pack_change(l)order by l.table_name,l.record_id,e.key,l.id desc)x);
end;$$;
revoke all on function public.read_pack_history(jsonb),public.read_pack_attribution(uuid)from public,anon;
grant execute on function public.read_pack_history(jsonb),public.read_pack_attribution(uuid)to authenticated;
