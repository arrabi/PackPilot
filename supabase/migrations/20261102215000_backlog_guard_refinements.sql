-- Forward refinements to foundation guards, audit identity and disclosed visit measurement.
create or replace function public.record_pack_community(request_id uuid,command jsonb)returns void
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
 if prior.request_id is null and action='finish_meeting'and not exists(select 1 from public.pack_activities a join public.pack_meeting_plans m on m.id=target where a.id=(command->>'activity_id')::uuid and a.scouting_year=command->>'year'and a.occurred_on=m.meeting_date and m.meeting_date>=make_date(left(command->>'year',4)::int,7,1)and m.meeting_date<=coalesce((select ends_on from private.pack_year_ends where scouting_year=command->>'year'),make_date(left(command->>'year',4)::int+1,6,30)))then raise exception 'Choose matching attendance and scouting year';end if;
 if prior.request_id is null and action='volunteer'and coalesce((command->>'join')::boolean,false)then
  if exists(select 1 from public.pack_volunteer_jobs j where j.id=target and j.event_id is null and j.signup_date<(now()at time zone 'America/Los_Angeles')::date)then raise exception 'Signup closed';end if;
  if exists(select 1 from public.pack_volunteer_jobs j join public.pack_events e on e.id=j.event_id join public.scouts s on s.id=(command->>'scout_id')::uuid where j.id=target and e.den is not null and e.den is distinct from s.den)then raise exception 'Choose a scout in the event den';end if;
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
create or replace function private.capture_pack_change()returns trigger
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
 select coalesce(jsonb_object_agg(e.key,e.value),'{}')into key_value from jsonb_each(row_value)e where e.key in('id','request_id','scout_id','adventure_id','scouting_year','requirement_code','platform','activity_id','item_id','owner_id','user_id','event_id','job_id','message_id','email','kind','den');
 record:=coalesce(row_value->>'id',row_value->>'request_id',row_value->>'email',nullif(concat_ws('|',row_value->>'scout_id',row_value->>'adventure_id',row_value->>'scouting_year',row_value->>'requirement_code',row_value->>'platform',row_value->>'activity_id',row_value->>'item_id',row_value->>'owner_id',row_value->>'user_id',row_value->>'event_id',row_value->>'job_id',row_value->>'message_id',row_value->>'kind',case when not row_value?'scout_id'then row_value->>'den'end),''),tg_table_name);
 child:=case when tg_table_name='scouts'then(row_value->>'id')::uuid else coalesce(row_value->>'scout_id',row_value->'command'->>'scout_id')::uuid end;
 if tg_table_name='pack_family_message_reads'then select scout_id into child from public.pack_family_messages where id=(row_value->>'message_id')::uuid;end if;
 select coalesce(to_jsonb(u)->'raw_user_meta_data'->>'full_name',u.email)into label from auth.users u where u.id=auth.uid();
 kind:=case when auth.uid()is null then coalesce(nullif(current_setting('pack.audit_source',true),''),'import or automation')when private.is_pack_admin()then 'administrator'when private.is_approved_leader()then 'den leader'else 'parent'end;
 insert into private.pack_change_log(table_name,record_id,record_key,scout_id,den,owner_id,actor_id,actor_name,actor_kind,action,effective_on,changes)
 values(tg_table_name,record,key_value,child,coalesce(row_value->>'den',(select s.den from public.scouts s where s.id=child)),case when tg_table_name='pack_leader_notes'then(row_value->>'owner_id')::uuid end,auth.uid(),coalesce(label,kind),kind,tg_op,coalesce(row_value->>'occurred_on',row_value->>'completed_on',row_value->>'earned_on',row_value->>'assigned_on',row_value->>'meeting_date',row_value->>'event_date'),diff);
 return coalesce(new,old);
end;$$;
create or replace function public.record_parent_portal_visit()returns void
language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from public.scouts s where private.parent_can_read_scout(s.id))then raise exception 'Parent access required'using errcode='42501';end if;
 if not exists(select 1 from private.site_policy_versions where current and engagement_enabled)then return;end if;
 insert into private.pack_portal_visits(user_id,visit_date)values(auth.uid(),(now()at time zone 'America/Los_Angeles')::date)
 on conflict(user_id,visit_date)do update set last_visit=now();
end;$$;

-- Address preferences use the same field history and explicit actor display as other admin data.
create trigger pack_audit after insert or update or delete on private.pack_email_preferences for each row execute function private.capture_pack_change();
create or replace function public.read_pack_email_preferences()returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('is_admin',private.is_pack_admin(),'addresses',case when private.is_pack_admin()then
 (select coalesce(jsonb_agg(jsonb_build_object('email',p.email,'suppressed',p.suppressed,'changed_at',p.changed_at,'changed_by',p.changed_by,'changed_by_name',coalesce(to_jsonb(u)->'raw_user_meta_data'->>'full_name',u.email))order by p.email),'[]')from private.pack_email_preferences p left join auth.users u on u.id=p.changed_by)else '[]'::jsonb end);
$$;
