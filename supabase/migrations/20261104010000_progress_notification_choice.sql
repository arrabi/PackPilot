-- Optional immediate parent notifications. Scheduled reminders remain data-driven.
create table private.pack_notification_choices (
 channel text not null check(channel in('pack','family')), request_id uuid not null,
 actor_id uuid not null, scout_id uuid not null references public.scouts(id)on delete cascade,
 command jsonb not null, result jsonb not null,
 recorded_at timestamptz not null default now(), primary key(channel,request_id)
);
alter table private.pack_notification_choices enable row level security;
revoke all on private.pack_notification_choices from public,anon,authenticated;
alter table private.pack_email_outbox add column notification_request_id uuid;
alter table private.pack_email_outbox add column notification_channel text;
create index pack_email_notification_request on private.pack_email_outbox(notification_channel,notification_request_id);

-- Guard only immediate progress notifications, never messages or reminder batches.
create function private.apply_progress_notification_choice()returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if nullif(current_setting('pack99.notification_request',true),'')is not null
 and split_part(new.dedupe_key,':',1)in('homework','earned','badge')then
  if current_setting('pack99.notify_parents',true)='false'then return null;end if;
  if not private.parent_email_still_allowed(new)then return null;end if;
  new.notification_request_id:=current_setting('pack99.notification_request')::uuid;
  new.notification_channel:=current_setting('pack99.notification_channel');
 end if;
 return new;
end;$$;
revoke all on function private.apply_progress_notification_choice()from public,anon,authenticated;
create trigger apply_progress_notification_choice before insert on private.pack_email_outbox
 for each row execute function private.apply_progress_notification_choice();

-- Preserve the currently installed validators/router, including patches from later migrations.
-- Copy rather than rename public OIDs, so existing batch callers keep the wrapper.
do $$
declare source text;name text;
begin
 foreach name in array array['pack','family']loop
  source:=pg_get_functiondef(('public.record_'||name||'_operation(uuid,jsonb)')::regprocedure);
  source:=replace(source,'FUNCTION public.record_'||name||'_operation(', 'FUNCTION private.record_'||name||'_before_notification_choice(');
  source:=replace(source,'record_'||name||'_operation.', 'record_'||name||'_before_notification_choice.');
  execute source;
  execute 'revoke all on function private.record_'||name||'_before_notification_choice(uuid,jsonb)from public,anon,authenticated';
 end loop;
end;$$;

create function private.record_with_notification_choice(channel text,request_id uuid,command jsonb)returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_variable
declare
 eligible boolean;notify boolean;normalized jsonb;answer jsonb;prior private.pack_notification_choices;
 old_request text:=current_setting('pack99.notification_request',true);
 old_channel text:=current_setting('pack99.notification_channel',true);
 old_notify text:=current_setting('pack99.notify_parents',true);
 queued integer;child uuid;key_value jsonb;table_name text;actor_name text;legacy boolean;
begin
 eligible:=(channel='family'and command->>'action'='assign_requirement')or
  (channel='pack'and command->>'action'in('record_requirement','earn_adventure','deliver_badge'));
 if not coalesce(eligible,false)then
  if command?'notify_parents'then raise exception 'Notification choice is unavailable for this action';end if;
  if channel='pack'then return private.record_pack_before_notification_choice(request_id,command);
  else return private.record_family_before_notification_choice(request_id,command);end if;
 end if;
 if not private.is_approved_leader()or not private.can_record()then raise exception 'Leader recording access denied'using errcode='42501';end if;
 if request_id is null or jsonb_typeof(command)is distinct from 'object'or length(command::text)>20000 then raise exception 'Invalid progress command';end if;
 if command?'notify_parents'and jsonb_typeof(command->'notify_parents')is distinct from 'boolean'then raise exception 'notify_parents must be a boolean';end if;
 notify:=coalesce((command->>'notify_parents')::boolean,true);
 normalized:=command||jsonb_build_object('notify_parents',notify);
 perform pg_advisory_xact_lock(hashtextextended('notification:'||channel||':'||request_id::text,0));
 select * into prior from private.pack_notification_choices c where c.channel=channel and c.request_id=request_id;
 if found then
  if prior.actor_id<>auth.uid()or prior.command<>normalized then raise exception 'Request ID conflict';end if;
  return prior.result;
 end if;
 -- A request committed before this feature cannot acquire a different email choice on retry.
 legacy:=case when channel='family'then exists(select 1 from public.pack_family_commands c where c.request_id=request_id)
  else exists(select 1 from public.pack_commands c where c.request_id=request_id)end;
 if legacy and not notify then raise exception 'Request ID conflict';end if;
 perform set_config('pack99.notification_request',request_id::text,true);
 perform set_config('pack99.notification_channel',channel,true);
 perform set_config('pack99.notify_parents',notify::text,true);
 if channel='pack'then answer:=private.record_pack_before_notification_choice(request_id,command-'notify_parents');
 else answer:=private.record_family_before_notification_choice(request_id,command-'notify_parents');end if;
 perform set_config('pack99.notification_request',coalesce(old_request,''),true);
 perform set_config('pack99.notification_channel',coalesce(old_channel,''),true);
 perform set_config('pack99.notify_parents',coalesce(old_notify,''),true);
 select count(*)into queued from private.pack_email_outbox q where q.notification_request_id=request_id and q.notification_channel=channel;
 answer:=answer||jsonb_build_object('notify_parents',notify,'notifications_queued',queued);
 insert into private.pack_notification_choices(channel,request_id,actor_id,scout_id,command,result)values(channel,request_id,auth.uid(),(command->>'scout_id')::uuid,normalized,answer);
 if not legacy then
  child:=(command->>'scout_id')::uuid;
  table_name:=case when channel='family'then 'pack_home_assignments'when command->>'action'='record_requirement'then 'pack_requirement_progress'else 'pack_advancement'end;
  key_value:=jsonb_build_object('scout_id',child,'adventure_id',command->>'adventure_id','scouting_year',command->>'scouting_year');
  if command?'requirement_code'then key_value:=key_value||jsonb_build_object('requirement_code',command->>'requirement_code');end if;
  if channel='family'then key_value:=key_value||jsonb_build_object('id',answer->>'assignment_id');end if;
  select coalesce(nullif(to_jsonb(u)->'raw_user_meta_data'->>'full_name',''),u.email,'Den leader')into actor_name from auth.users u where u.id=auth.uid();
  insert into private.pack_change_log(table_name,record_id,record_key,scout_id,den,actor_id,actor_name,actor_kind,action,effective_on,changes)
   values(table_name,coalesce(answer->>'assignment_id',concat_ws('|',child::text,command->>'adventure_id',command->>'scouting_year',command->>'requirement_code')),key_value,child,(select s.den from public.scouts s where s.id=child),auth.uid(),actor_name,'leader','NOTIFICATION_CHOICE',coalesce(command->>'occurred_on',command->>'assigned_on'),
    jsonb_build_object('notify_parents',jsonb_build_object('before',null,'after',notify)));
 end if;
 return answer;
exception when others then
 perform set_config('pack99.notification_request',coalesce(old_request,''),true);
 perform set_config('pack99.notification_channel',coalesce(old_channel,''),true);
 perform set_config('pack99.notify_parents',coalesce(old_notify,''),true);
 raise;
end;$$;
revoke all on function private.record_with_notification_choice(text,uuid,jsonb)from public,anon,authenticated;

create or replace function public.record_pack_operation(request_id uuid,command jsonb)returns jsonb
language sql security definer set search_path='' set statement_timeout='5s' as $$
 select private.record_with_notification_choice('pack',request_id,command);
$$;
create or replace function public.record_family_operation(request_id uuid,command jsonb)returns jsonb
language sql security definer set search_path='' set statement_timeout='10s' as $$
 select private.record_with_notification_choice('family',request_id,command);
$$;
revoke all on function public.record_pack_operation(uuid,jsonb),public.record_family_operation(uuid,jsonb)from public,anon;
grant execute on function public.record_pack_operation(uuid,jsonb),public.record_family_operation(uuid,jsonb)to authenticated;

-- Contact metadata is separate from the approved login address and permissions.
-- Operational corrections are applied privately, not embedded in source control.
alter table public.leader_access add column display_name text check(length(display_name)<=100);
alter table public.leader_access add column assigned_den text check(assigned_den in('0-Lions','1-Tigers','2-Wolves','3-Bears','4-Webelos','5-AOL'));
alter table public.leader_access add column contact_emails text[] not null default '{}' check(cardinality(contact_emails)<=10);
comment on column public.leader_access.contact_emails is 'Contact aliases only. These do not authorize sign-in or recording.';
