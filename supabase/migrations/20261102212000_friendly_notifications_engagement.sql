alter table private.site_policy_versions add column engagement_enabled boolean not null default false;
alter table private.pack_email_outbox add column content jsonb;
alter table private.pack_email_outbox add column batch_id uuid;
alter table private.pack_email_outbox add column provider_message_id text;
alter table private.pack_email_outbox add column delivered_at timestamptz;
alter table private.pack_email_outbox add column tracking_token uuid not null default gen_random_uuid();
alter table private.pack_email_outbox add column tracking_enabled boolean not null default false;
create unique index pack_email_tracking_token on private.pack_email_outbox(tracking_token);
create table private.pack_reminder_batches(id uuid primary key,kind text not null check(kind in('scheduled','manual')),actor_id uuid,created_at timestamptz not null default now(),recipient_count integer not null default 0);
create table private.pack_email_engagement(id bigint generated always as identity primary key,email_id uuid not null references private.pack_email_outbox(id)on delete cascade,kind text not null check(kind in('opened','clicked')),target text not null default '',automated boolean not null default false,recorded_at timestamptz not null default now());
create index pack_engagement_email on private.pack_email_engagement(email_id,kind,recorded_at);
alter table private.pack_reminder_batches enable row level security;
alter table private.pack_email_engagement enable row level security;
revoke all on private.pack_reminder_batches,private.pack_email_engagement from public,anon,authenticated;

create function private.parent_reminder_items(mailbox text,year text)returns jsonb
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
 select '4:'||j.title||':'||j.id,jsonb_build_object('kind','volunteer','title',j.title,'instructions',j.details,'event',e.title,'date',coalesce(e.event_date,j.signup_date),'remaining',case when j.capacity is null then null else greatest(0,j.capacity-(select count(*)from public.pack_volunteers v where v.job_id=j.id))end,'url','https://legacy.packpilot.example/events?parent=1&job='||j.id)
 from public.pack_volunteer_jobs j left join public.pack_events e on e.id=j.event_id
 where not j.closed and(e.id is null or(not e.cancelled and e.event_date>=(now()at time zone 'America/Los_Angeles')::date and(e.den is null or exists(select 1 from children s where s.den=e.den))))
 and(j.signup_date is null or j.signup_date>=(now()at time zone 'America/Los_Angeles')::date)
 and(j.capacity is null or(select count(*)from public.pack_volunteers v where v.job_id=j.id)<j.capacity)
 and not exists(select 1 from public.pack_volunteers v join public.parent_scout_links l on l.claimed_user_id=v.user_id where v.job_id=j.id and l.active and lower(btrim(l.parent_email))=mailbox)
 and exists(select 1 from children)
 )select coalesce(jsonb_agg(item order by sort),'[]')from items;
$$;
revoke all on function private.parent_reminder_items(text,text)from public,anon,authenticated;
create function private.queue_parent_reminder_batch(batch uuid,year text)returns integer
language plpgsql security definer set search_path='' as $$
declare r record;items jsonb;n integer:=0;
begin
 for r in select distinct lower(btrim(l.parent_email))email from public.parent_scout_links l join public.scouts s on s.id=l.scout_id where l.active and coalesce(s.den,'')!~* '^\s*\(withdraw\)'and not exists(select 1 from private.pack_email_preferences p where p.email=lower(btrim(l.parent_email))and p.suppressed)loop
  items:=private.parent_reminder_items(r.email,year);
  if jsonb_array_length(items)>0 then
   insert into private.pack_email_outbox(dedupe_key,child_ids,recipient,subject,body,content,batch_id)
   values('reminder:'||batch||':'||r.email,(select array_agg(distinct l.scout_id)from public.parent_scout_links l join public.scouts s on s.id=l.scout_id where l.active and lower(btrim(l.parent_email))=r.email and coalesce(s.den,'')!~* '^\s*\(withdraw\)'),r.email,'PackPilot: your family follow-ups','Your family follow-ups are ready in the parent portal.',jsonb_build_object('kind','reminder','items',items),batch)on conflict do nothing;
   if found then n:=n+1;end if;
  end if;
 end loop;
 update private.pack_reminder_batches set recipient_count=n where id=batch;return n;
end;$$;
revoke all on function private.queue_parent_reminder_batch(uuid,text)from public,anon,authenticated;
create or replace function public.prepare_parent_reminders(at_time timestamptz default now())returns integer
language plpgsql security definer set search_path='' as $$
declare local_time timestamp:=at_time at time zone 'America/Los_Angeles';year text;batch uuid:=gen_random_uuid();
begin
 if extract(isodow from local_time)<>6 or local_time::time<time '08:00'then return 0;end if;
 insert into private.pack_reminder_runs values(local_time::date)on conflict do nothing;if not found then return 0;end if;
 year:=(case when extract(month from local_time)>=8 then extract(year from local_time)::int else extract(year from local_time)::int-1 end)::text;
 year:=year||'-'||right((left(year,4)::int+1)::text,2);
 insert into private.pack_reminder_batches(id,kind)values(batch,'scheduled');return private.queue_parent_reminder_batch(batch,year);
end;$$;
create function public.preview_parent_reminders()returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare year text;d date:=(now()at time zone 'America/Los_Angeles')::date;
begin
 if not private.is_pack_admin()then raise exception 'Administrator access required'using errcode='42501';end if;
 year:=(extract(year from d)::int-case when extract(month from d)<8 then 1 else 0 end)::text;year:=year||'-'||right((left(year,4)::int+1)::text,2);
 return jsonb_build_object('recipient_count',(select count(*)from(select distinct lower(btrim(l.parent_email))email from public.parent_scout_links l join public.scouts s on s.id=l.scout_id where l.active and coalesce(s.den,'')!~* '^\s*\(withdraw\)')r where not exists(select 1 from private.pack_email_preferences p where p.email=r.email and p.suppressed)and jsonb_array_length(private.parent_reminder_items(r.email,year))>0));
end;$$;
create function public.send_parent_reminders_now(request_id uuid)returns jsonb
language plpgsql security definer set search_path='' as $$
declare year text;d date:=(now()at time zone 'America/Los_Angeles')::date;n integer;prior private.pack_reminder_batches;http_id bigint;
begin
 if not private.is_pack_admin()then raise exception 'Administrator access required'using errcode='42501';end if;
 if request_id is null then raise exception 'Request ID required';end if;
 perform pg_advisory_xact_lock(hashtextextended('manual-reminder:'||request_id::text,0));
 select * into prior from private.pack_reminder_batches where id=request_id;
 if found then if prior.actor_id is distinct from auth.uid()or prior.kind<>'manual'then raise exception 'Request ID conflict';end if;return jsonb_build_object('batch_id',request_id,'recipient_count',prior.recipient_count);end if;
 year:=(extract(year from d)::int-case when extract(month from d)<8 then 1 else 0 end)::text;year:=year||'-'||right((left(year,4)::int+1)::text,2);
 insert into private.pack_reminder_batches(id,kind,actor_id)values(request_id,'manual',auth.uid());n:=private.queue_parent_reminder_batch(request_id,year);
 if n>0 then select private.invoke_parent_notification_dispatch()into http_id;end if;
 insert into private.pack_change_log(table_name,record_id,record_key,actor_id,actor_name,actor_kind,action,changes)
 values('manual_reminders',request_id::text,'{}',auth.uid(),coalesce((select email from auth.users where id=auth.uid()),'Administrator'),'administrator','SEND',jsonb_build_object('recipients',jsonb_build_object('before',0,'after',n)));
 return jsonb_build_object('batch_id',request_id,'recipient_count',n,'dispatch_request',http_id);
end;$$;
revoke all on function public.preview_parent_reminders(),public.send_parent_reminders_now(uuid)from public,anon;
grant execute on function public.preview_parent_reminders(),public.send_parent_reminders_now(uuid)to authenticated;

-- One revocation/suppression check is shared by claims and the immediate pre-send guard.
create function private.parent_email_still_allowed(q private.pack_email_outbox)returns boolean
language sql stable security definer set search_path='' as $$
 select not exists(select 1 from private.pack_email_preferences p where p.email=q.recipient and p.suppressed)and(
 (q.audience='admin'and q.recipient='contact@example.test')or(q.audience='parent'
 and exists(select 1 from public.parent_scout_links l join public.scouts s on s.id=l.scout_id where l.active and lower(btrim(l.parent_email))=q.recipient and(q.scout_id is null or q.scout_id=l.scout_id)and coalesce(s.den,'')!~* '^\s*\(withdraw\)')
 and not exists(select 1 from unnest(q.child_ids)child where not exists(select 1 from public.parent_scout_links l join public.scouts s on s.id=l.scout_id where l.scout_id=child and l.active and lower(btrim(l.parent_email))=q.recipient and coalesce(s.den,'')!~* '^\s*\(withdraw\)'))));
$$;
revoke all on function private.parent_email_still_allowed(private.pack_email_outbox)from public,anon,authenticated;
create or replace function public.claim_parent_emails()returns jsonb
language plpgsql security definer set search_path='' as $$declare result jsonb;
begin
 update private.pack_email_outbox q set status='cancelled'where q.status in('pending','sending')and not private.parent_email_still_allowed(q);
 with selected as(select id from private.pack_email_outbox where(status='pending'and available_at<=now())or(status='sending'and claimed_at<now()-interval '15 minutes')order by available_at limit 40 for update skip locked),claimed as(update private.pack_email_outbox q set status='sending',claimed_at=now(),attempts=attempts+1 from selected s where s.id=q.id returning q.id,q.recipient,q.subject,q.body,q.audience,q.content)
 select coalesce(jsonb_agg(to_jsonb(c)),'[]')into result from claimed c;return result;
end;$$;
create or replace function public.can_send_parent_email(email_id uuid)returns boolean
language plpgsql security definer set search_path='' as $$declare q private.pack_email_outbox;allowed boolean;
begin
 select * into q from private.pack_email_outbox where id=email_id;
 allowed:=found and q.status='sending'and private.parent_email_still_allowed(q);
 if not coalesce(allowed,false)then update private.pack_email_outbox set status='cancelled'where id=email_id and status in('pending','sending');end if;return coalesce(allowed,false);
end;$$;

create function public.parent_email_context(email_id uuid)returns jsonb
language plpgsql security definer set search_path='' as $$
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
 links:=jsonb_build_object('portal','https://legacy.packpilot.example/parents','national','https://example.test/national-registration','guide','https://example.test/registration-guide','active','https://example.test/pack-registration','survey','https://example.test/skills-survey');
 for item in select * from jsonb_array_elements(items)loop
  if item->>'url'like 'https://%'and item->>'url'!~'[\r\n]'then links:=links||jsonb_build_object('item-'||i,item->>'url');end if;i:=i+1;
 end loop;
 update private.pack_email_outbox set content=coalesce(content,'{}')||jsonb_build_object('kind',kind,'items',items,'links',links),tracking_enabled=enabled where id=email_id;
 return jsonb_build_object('kind',kind,'parent_name',coalesce(parent_name,'PackPilot parent'),'scout_names',names,'items',items,'links',links,'tracking_token',case when enabled then q.tracking_token else null end,'admin',q.audience='admin');
end;$$;
create function public.record_parent_email_result(email_id uuid,success boolean,error_text text default '',message_id text default null)returns void
language sql security definer set search_path='' as $$
 update private.pack_email_outbox set status=case when success then 'sent'else 'pending'end,sent_at=case when success then now()else null end,
 provider_message_id=case when success then left(message_id,300)else provider_message_id end,available_at=now()+interval '15 minutes',last_error=left(error_text,500)
 where id=email_id and status='sending';
$$;
create function public.track_parent_email(token uuid,engagement_kind text,target_key text default 'portal',automated boolean default false)returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_variable
declare q private.pack_email_outbox;destination text;
begin
 select * into q from private.pack_email_outbox where tracking_token=token and status='sent';
 if not found or not q.tracking_enabled or not private.parent_email_still_allowed(q)then return jsonb_build_object('url','https://legacy.packpilot.example/parents','tracked',false);end if;
 if q.sent_at<now()-interval '360 days'then return jsonb_build_object('url','https://legacy.packpilot.example/parents','tracked',false);end if;
 destination:=coalesce(q.content->'links'->>target_key,'https://legacy.packpilot.example/parents');
 if engagement_kind not in('opened','clicked')then raise exception 'Invalid engagement event';end if;
 -- Coalesce repeated image fetches and scanners; record signals without claiming human reading.
 if not exists(select 1 from private.pack_email_engagement e where e.email_id=q.id and e.kind=engagement_kind and e.target=target_key and e.automated=automated and e.recorded_at>now()-interval '1 hour')then
  insert into private.pack_email_engagement(email_id,kind,target,automated)values(q.id,engagement_kind,target_key,automated);
 end if;
 return jsonb_build_object('url',destination,'tracked',true);
end;$$;
create function public.parent_email_delivery_pending()returns jsonb
language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'message_id',provider_message_id)),'[]')from(select id,provider_message_id from private.pack_email_outbox where status='sent'and delivered_at is null and provider_message_id is not null and sent_at>now()-interval '7 days'order by sent_at desc limit 40)x;
$$;
create function public.record_parent_email_delivery(email_id uuid,message_id text,delivered timestamptz)returns void
language sql security definer set search_path='' as $$
 update private.pack_email_outbox set delivered_at=delivered where id=email_id and provider_message_id=message_id and delivered_at is null and delivered<=now()+interval '5 minutes';
$$;
revoke all on function public.parent_email_context(uuid),public.record_parent_email_result(uuid,boolean,text,text),public.track_parent_email(uuid,text,text,boolean),public.parent_email_delivery_pending(),public.record_parent_email_delivery(uuid,text,timestamptz)from public,anon,authenticated;
grant execute on function public.parent_email_context(uuid),public.record_parent_email_result(uuid,boolean,text,text),public.track_parent_email(uuid,text,text,boolean),public.parent_email_delivery_pending(),public.record_parent_email_delivery(uuid,text,timestamptz)to service_role;

-- This view supplies the admin-only delivery and engagement dashboard.
alter function public.read_pack_admin()rename to read_pack_admin_base;
alter function public.read_pack_admin_base()set schema private;
revoke all on function private.read_pack_admin_base()from public,anon,authenticated;
create function public.read_pack_admin()returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if not private.is_pack_admin()then raise exception 'Pack administrator access required'using errcode='42501';end if;
 return private.read_pack_admin_base()||jsonb_build_object(
 'tracking_started',(select published_at from private.site_policy_versions where current and engagement_enabled),
 'emails',(select coalesce(jsonb_agg(to_jsonb(x)),'[]')from(select q.id,q.recipient,q.audience,q.status,q.attempts,q.last_error,q.sent_at,q.delivered_at,q.batch_id,q.tracking_enabled,q.available_at,split_part(q.dedupe_key,':',1)kind,
 (select count(*)from private.pack_email_engagement e where e.email_id=q.id and e.kind='opened'and not e.automated)opens,
 (select count(*)from private.pack_email_engagement e where e.email_id=q.id and e.kind='clicked'and not e.automated)clicks,
 (select max(recorded_at)from private.pack_email_engagement e where e.email_id=q.id and not e.automated)last_engaged
 from private.pack_email_outbox q order by q.available_at desc limit 2000)x),
 'reminder_runs',(select coalesce(jsonb_agg(to_jsonb(x)),'[]')from(select * from private.pack_reminder_batches order by created_at desc limit 50)x));
end;$$;
revoke all on function public.read_pack_admin()from public,anon;
grant execute on function public.read_pack_admin()to authenticated;
