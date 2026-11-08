alter table public.pack_volunteers add column note text not null default ''check(length(note)<=1000);
create table public.pack_volunteer_waitlist(id uuid not null unique default gen_random_uuid(),job_id uuid not null references public.pack_volunteer_jobs(id),user_id uuid not null references auth.users(id),scout_id uuid not null references public.scouts(id)on delete cascade,note text not null default ''check(length(note)<=1000),status text not null default 'waiting'check(status in('waiting','promoted','cancelled','expired')),requested_at timestamptz not null default now(),updated_at timestamptz not null default now(),primary key(job_id,user_id));
alter table public.pack_volunteer_waitlist enable row level security;
revoke all on public.pack_volunteer_waitlist from public,anon,authenticated;
create trigger pack_audit after insert or update or delete on public.pack_volunteer_waitlist for each row execute function private.capture_pack_change();
create function private.volunteer_is_eligible(person uuid,child uuid,job uuid)returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.parent_scout_links l join auth.users u on u.id=l.claimed_user_id join public.scouts s on s.id=l.scout_id join public.pack_volunteer_jobs j on j.id=job join public.pack_volunteer_signups g on g.id=j.signup_id left join public.pack_events e on e.id=j.event_id where u.id=person and s.id=child and l.active and u.email_confirmed_at is not null and l.email_canonical=private.canonical_leader_email(u.email)and coalesce(s.den,'')!~*'^\s*\(withdraw\)'and not j.closed and not g.closed and(j.signup_date is null or j.signup_date>=(now()at time zone 'America/Los_Angeles')::date)and(e.id is null or not e.cancelled and coalesce(e.end_date,e.event_date)>=(now()at time zone 'America/Los_Angeles')::date and(e.den is null or e.den=s.den)));
$$;
revoke all on function private.volunteer_is_eligible(uuid,uuid,uuid)from public,anon,authenticated;
create function private.promote_volunteer_waitlist(job uuid)returns integer language plpgsql security definer set search_path='' as $$
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
  perform private.queue_family_email(w.scout_id,'volunteer-promoted:'||w.id||':'||w.requested_at,'PackPilot: a volunteer place opened for your family','A place opened on the waitlist you joined. Your family is now signed up for '||title||E'.\nReview the commitment or release your place: https://legacy.packpilot.example/events?parent=1&job='||job);
  n:=n+1;
 end loop;
 perform set_config('pack.audit_source',old_source,true);return n;
end;$$;
revoke all on function private.promote_volunteer_waitlist(uuid)from public,anon,authenticated;

alter function public.record_pack_community(uuid,jsonb)rename to record_community_before_waitlists;
alter function public.record_community_before_waitlists(uuid,jsonb)set schema private;
revoke all on function private.record_community_before_waitlists(uuid,jsonb)from public,anon,authenticated;
create function public.record_pack_community(request_id uuid,command jsonb)returns void language plpgsql security definer set search_path='' set statement_timeout='20s' as $$
#variable_conflict use_variable
declare action text:=command->>'action';target uuid:=(command->>'id')::uuid;prior public.pack_community_commands;j public.pack_volunteer_jobs;child uuid;item jsonb;note text:=coalesce(command->>'note','');joining boolean:=coalesce((command->>'join')::boolean,false);
begin
 if action is null or action not in('volunteer','volunteer_note','waitlist','signup')then perform private.record_community_before_waitlists(request_id,command);return;end if;
 if not private.is_approved_leader()and not exists(select 1 from public.scouts s where private.parent_can_read_scout(s.id))then raise exception 'Authorized account required'using errcode='42501';end if;
 if request_id is null or target is null or length(command::text)>100000 or length(note)>1000 then raise exception 'Invalid volunteer request or note';end if;
 perform pg_advisory_xact_lock(hashtextextended('community-request:'||request_id::text,0));select * into prior from public.pack_community_commands c where c.request_id=request_id;
 if found then if prior.recorded_by<>auth.uid()or prior.command<>command then raise exception 'Request ID conflict';end if;return;end if;
 if action='signup'then
  for item in select * from jsonb_array_elements(command->'items')loop
   if exists(select 1 from public.pack_volunteer_waitlist w join public.pack_volunteer_jobs ji on ji.id=w.job_id join public.pack_volunteer_signups g on g.id=ji.signup_id where w.status='waiting'and ji.id=(item->>'id')::uuid and(ji.capacity_unit is distinct from coalesce(item->>'capacity_unit','family')or g.event_id is distinct from nullif(command->>'event_id','')::uuid or g.signup_date is distinct from nullif(command->>'signup_date','')::date))then raise exception 'A waitlisted item cannot change units, event or date';end if;
  end loop;
  perform private.record_community_before_waitlists(request_id,command);return;
 end if;
 perform pg_advisory_xact_lock(hashtextextended('job:'||target::text,0));select * into j from public.pack_volunteer_jobs where id=target for update;if not found then raise exception 'Volunteer item unavailable';end if;
 if action='volunteer'then
  if joining and exists(select 1 from public.pack_volunteer_waitlist where job_id=target and status='waiting')and not exists(select 1 from public.pack_volunteers v where v.job_id=target and private.parent_can_read_scout(v.scout_id)and(v.user_id=auth.uid()or j.capacity_unit='family'))then raise exception 'This item has a waitlist; join the queue for the next place';end if;
  perform private.record_community_before_waitlists(request_id,command);
  if joining and command?'note'then update public.pack_volunteers v set note=note where v.job_id=target and private.parent_can_read_scout(v.scout_id)and(v.user_id=auth.uid()or j.capacity_unit='family');end if;
  if not joining then perform private.promote_volunteer_waitlist(target);end if;return;
 elsif action='volunteer_note'then
  update public.pack_volunteers v set note=note where v.job_id=target and v.note=coalesce(command->>'expected_note','')and private.parent_can_read_scout(v.scout_id)and(v.user_id=auth.uid()or j.capacity_unit='family');
  if not found then raise exception 'Commitment changed or unavailable; refresh and review';end if;
 elsif action='waitlist'then
  if joining then
   child:=(command->>'scout_id')::uuid;
   if not private.parent_can_read_scout(child)or not private.volunteer_is_eligible(auth.uid(),child,target)then raise exception 'Choose an open volunteer item for your family'using errcode='42501';end if;
   if not coalesce((command->>'accept_promotion')::boolean,false)then raise exception 'Confirm automatic signup if a place opens';end if;
   if j.capacity is null or(select count(*)from public.pack_volunteers where job_id=target)<j.capacity then raise exception 'A place is available; sign up directly';end if;
   if not exists(select 1 from public.pack_volunteer_waitlist w where w.job_id=target and w.status='waiting'and(w.user_id=auth.uid()or j.capacity_unit='family'and private.volunteer_family_key(w.scout_id)=private.volunteer_family_key(child)))then
    insert into public.pack_volunteer_waitlist(job_id,user_id,scout_id,note)values(target,auth.uid(),child,note)on conflict(job_id,user_id)do update set status='waiting',note=excluded.note,scout_id=excluded.scout_id,requested_at=now(),updated_at=now();
   end if;
  else update public.pack_volunteer_waitlist w set status='cancelled',updated_at=now()where w.job_id=target and w.status='waiting'and(w.user_id=auth.uid()or j.capacity_unit='family'and exists(select 1 from public.scouts s where private.parent_can_read_scout(s.id)and private.volunteer_family_key(s.id)=private.volunteer_family_key(w.scout_id)));end if;
 end if;
 insert into public.pack_community_commands values(request_id,command,auth.uid(),now());
end;$$;
revoke all on function public.record_pack_community(uuid,jsonb)from public,anon;
grant execute on function public.record_pack_community(uuid,jsonb)to authenticated;

create function public.prepare_volunteer_followups(at_time timestamptz default now())returns integer language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare queued_job record;v record;n integer:=0;day date:=(at_time at time zone 'America/Los_Angeles')::date;
begin
 for queued_job in select distinct job_id from public.pack_volunteer_waitlist where status='waiting'loop n:=n+private.promote_volunteer_waitlist(queued_job.job_id);end loop;
 if(at_time at time zone 'America/Los_Angeles')::time<time '08:00'then return n;end if;
 for v in select v.*,j.title role,g.title signup,coalesce(e.event_date,j.signup_date)event_date,e.start_time,e.timezone,e.location from public.pack_volunteers v join public.pack_volunteer_jobs j on j.id=v.job_id join public.pack_volunteer_signups g on g.id=j.signup_id left join public.pack_events e on e.id=j.event_id where coalesce(e.event_date,j.signup_date)=day+1 and(e.id is null or not e.cancelled)and(exists(select 1 from public.parent_scout_links l join public.scouts s on s.id=l.scout_id where j.capacity_unit='family'and l.scout_id=v.scout_id and l.active and coalesce(s.den,'')!~*'^\s*\(withdraw\)')or exists(select 1 from public.parent_scout_links l join auth.users u on u.id=l.claimed_user_id join public.scouts s on s.id=l.scout_id where l.scout_id=v.scout_id and l.claimed_user_id=v.user_id and l.active and u.email_confirmed_at is not null and l.email_canonical=private.canonical_leader_email(u.email)and coalesce(s.den,'')!~*'^\s*\(withdraw\)'))loop
  perform private.queue_family_email(v.scout_id,'volunteer-reminder:'||v.job_id||':'||v.user_id||':'||v.event_date,'PackPilot: your volunteer commitment tomorrow','Your family has a volunteer commitment tomorrow: '||v.signup||' — '||v.role||E'.\nDate: '||v.event_date||coalesce(E'\nTime: '||v.start_time::text||' ('||v.timezone||')','')||coalesce(E'\nLocation: '||v.location,'')||coalesce(E'\nYour note: '||nullif(v.note,''),'')||E'\nReview or release your place: https://legacy.packpilot.example/events?parent=1&job='||v.job_id);
 end loop;return n;
end;$$;
revoke all on function public.prepare_volunteer_followups(timestamptz)from public,anon,authenticated;
grant execute on function public.prepare_volunteer_followups(timestamptz)to service_role;

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
 if current_setting('pack.audit_source',true)='automation:waitlist'then label:='Volunteer waitlist service';kind:='automation';end if;
 insert into private.pack_change_log(table_name,record_id,record_key,scout_id,den,owner_id,actor_id,actor_name,actor_kind,action,effective_on,changes)
 values(tg_table_name,record,key_value,child,coalesce(row_value->>'den',(select s.den from public.scouts s where s.id=child)),case when tg_table_name='pack_leader_notes'then(row_value->>'owner_id')::uuid end,case when current_setting('pack.audit_source',true)='automation:waitlist'then null else auth.uid()end,coalesce(label,kind),kind,tg_op,coalesce(row_value->>'occurred_on',row_value->>'completed_on',row_value->>'earned_on',row_value->>'assigned_on',row_value->>'meeting_date',row_value->>'event_date'),diff);
 return coalesce(new,old);
end;$$;
