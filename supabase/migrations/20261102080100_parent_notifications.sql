create table private.pack_email_outbox (
 id uuid primary key default gen_random_uuid(), dedupe_key text not null unique,
 scout_id uuid references public.scouts(id), child_ids uuid[], recipient text not null,
 subject text not null, body text not null,
 status text not null default 'pending' check(status in('pending','sending','sent','cancelled')),
 attempts integer not null default 0, available_at timestamptz not null default now(),
 claimed_at timestamptz, sent_at timestamptz, last_error text
);
alter table private.pack_email_outbox enable row level security;
revoke all on private.pack_email_outbox from public,anon,authenticated;

create function private.queue_family_email(child uuid,key text,title text,content text) returns void
language sql security definer set search_path='' as $$
 insert into private.pack_email_outbox(dedupe_key,scout_id,recipient,subject,body)
 select key||':'||lower(btrim(l.parent_email)),child,lower(btrim(l.parent_email)),title,content||E'\n\nOpen your family portal: https://legacy.packpilot.example/parents'
 from public.parent_scout_links l join public.scouts s on s.id=l.scout_id
 where l.scout_id=child and l.active and coalesce(s.den,'') !~* '^\s*\(withdraw\)'
 group by lower(btrim(l.parent_email)) on conflict(dedupe_key)do nothing;
$$;
revoke all on function private.queue_family_email(uuid,text,text,text)from public,anon,authenticated;
create function private.notify_family_change() returns trigger
language plpgsql security definer set search_path='' as $$
declare name text; adventure text;
begin
 select scout_name into name from public.scouts where id=new.scout_id;
 if tg_table_name='pack_home_assignments'then
  select a.name into adventure from public.pack_adventures a where a.id=new.adventure_id;
  perform private.queue_family_email(new.scout_id,'homework:'||new.id,'PackPilot: new home assignment for '||name,adventure||' — requirement '||new.requirement_code||E'\n'||new.instructions||case when new.due_on is not null then E'\nDue: '||new.due_on else ''end);
 elsif tg_table_name='pack_family_messages'then
  if new.sender_role='leader'then perform private.queue_family_email(new.scout_id,'message:'||new.id,'PackPilot: message about '||name,'Your den leader sent a message. Sign in to read and reply.');end if;
 else
  select a.name into adventure from public.pack_adventures a where a.id=new.adventure_id;
  if new.earned_on is not null and(tg_op='INSERT'or old.earned_on is null)then
   perform private.queue_family_email(new.scout_id,'earned:'||new.scout_id||':'||new.adventure_id||':'||new.scouting_year,'Congratulations, '||name||'!','Your scout earned '||adventure||' on '||new.earned_on||'.');
  end if;
  if new.badge_delivered_on is not null and(tg_op='INSERT'or old.badge_delivered_on is null)then
   perform private.queue_family_email(new.scout_id,'badge:'||new.scout_id||':'||new.adventure_id||':'||new.scouting_year,'PackPilot: '||name||' received a badge!','Your scout received the '||adventure||' badge on '||new.badge_delivered_on||'.');
  end if;
 end if;return new;
end;$$;
revoke all on function private.notify_family_change()from public,anon,authenticated;
create trigger notify_homework after insert on public.pack_home_assignments for each row execute function private.notify_family_change();
create trigger notify_message after insert on public.pack_family_messages for each row execute function private.notify_family_change();
create trigger notify_advancement after insert or update on public.pack_advancement for each row execute function private.notify_family_change();

create table private.pack_reminder_runs(local_date date primary key);
alter table private.pack_reminder_runs enable row level security;
revoke all on private.pack_reminder_runs from public,anon,authenticated;

-- Service-only dispatcher, running every five minutes. Local calendar handles DST.
create function public.prepare_parent_reminders(at_time timestamptz default now()) returns integer
language plpgsql security definer set search_path='' as $$
declare local_time timestamp:=at_time at time zone 'America/Los_Angeles'; y text; r record; lines text; count_added integer;
begin
 if extract(isodow from local_time)<>6 or local_time::time<time '08:00'then return 0;end if;
 insert into private.pack_reminder_runs values(local_time::date)on conflict do nothing;
 if not found then return 0;end if;
 y:=case when extract(month from local_time)>=8 then extract(year from local_time)::int else extract(year from local_time)::int-1 end::text;
 y:=y||'-'||right((y::int+1)::text,2);
 for r in select distinct lower(btrim(l.parent_email))email from public.parent_scout_links l join public.scouts s on s.id=l.scout_id where l.active and coalesce(s.den,'') !~* '^\s*\(withdraw\)'loop
  select string_agg(x.line,E'\n'order by x.line)into lines from (
   select distinct s.scout_name||': homework — '||d.name||', requirement '||a.requirement_code as line
   from public.parent_scout_links l join public.scouts s on s.id=l.scout_id join public.pack_home_assignments a on a.scout_id=s.id join public.pack_adventures d on d.id=a.adventure_id
   where l.active and lower(btrim(l.parent_email))=r.email and a.scouting_year=y and a.status in('todo','returned')and coalesce(s.den,'') !~* '^\s*\(withdraw\)'
   and not exists(select 1 from public.pack_requirement_progress p where p.scout_id=a.scout_id and p.adventure_id=a.adventure_id and p.scouting_year=y and p.requirement_code=a.requirement_code)
   and not exists(select 1 from public.pack_advancement v where v.scout_id=a.scout_id and v.adventure_id=a.adventure_id and v.scouting_year=y and v.earned_on is not null)
   union
   select s.scout_name||': unread family message ('||m.recorded_at::date||')'
   from public.parent_scout_links l join public.scouts s on s.id=l.scout_id join public.pack_family_messages m on m.scout_id=s.id
   where l.active and lower(btrim(l.parent_email))=r.email and m.recorded_by is distinct from l.claimed_user_id and m.scouting_year=y and coalesce(s.den,'') !~* '^\s*\(withdraw\)'and not exists(select 1 from public.pack_family_message_reads rd where rd.user_id=l.claimed_user_id and rd.message_id=m.id)
   union
   select s.scout_name||': registration needs follow-up — '||ps.platform
   from public.parent_scout_links l join public.scouts s on s.id=l.scout_id cross join unnest(array['active.com','scouting.org'])ps(platform)
   where l.active and lower(btrim(l.parent_email))=r.email and coalesce(s.den,'') !~* '^\s*\(withdraw\)'and not exists(select 1 from public.pack_registrations rg where rg.scout_id=s.id and rg.scouting_year=y and rg.platform=ps.platform and rg.status='confirmed')
  )x;
  if lines is not null then
   insert into private.pack_email_outbox(dedupe_key,child_ids,recipient,subject,body)values('weekly:'||local_time::date||':'||r.email,(select array_agg(l.scout_id)from public.parent_scout_links l where l.active and lower(btrim(l.parent_email))=r.email),r.email,'PackPilot: your family follow-ups',lines||E'\n\nOpen your family portal: https://legacy.packpilot.example/parents')on conflict do nothing;
  end if;
 end loop;
 get diagnostics count_added=row_count;return count_added;
end;$$;

create function public.claim_parent_emails() returns jsonb
language plpgsql security definer set search_path='' as $$
declare claimed_emails jsonb;
begin
 -- Recheck revocation before dispatch, including weekly mailbox access.
 update private.pack_email_outbox q set status='cancelled'where status in('pending','sending')and not exists(select 1 from public.parent_scout_links l join public.scouts s on s.id=l.scout_id where l.active and lower(btrim(l.parent_email))=q.recipient and(q.scout_id is null or q.scout_id=l.scout_id)and coalesce(s.den,'') !~* '^\s*\(withdraw\)');
 update private.pack_email_outbox q set status='cancelled'where q.status in('pending','sending')and q.child_ids is not null and exists(select 1 from unnest(q.child_ids)child where not exists(select 1 from public.parent_scout_links l join public.scouts s on s.id=l.scout_id where l.scout_id=child and l.active and lower(btrim(l.parent_email))=q.recipient and coalesce(s.den,'') !~* '^\s*\(withdraw\)'));
 with selected as(select id from private.pack_email_outbox where(status='pending'and available_at<=now())or(status='sending'and claimed_at<now()-interval '15 minutes')order by available_at limit 40 for update skip locked), claimed as(update private.pack_email_outbox q set status='sending',claimed_at=now(),attempts=attempts+1 from selected s where s.id=q.id returning q.*)select coalesce(jsonb_agg(to_jsonb(c)),'[]')into claimed_emails from claimed c;
 return claimed_emails;
end;$$;
create function public.finish_parent_email(email_id uuid,success boolean,error_text text default '')returns void
language sql security definer set search_path='' as $$
 update private.pack_email_outbox set status=case when success then 'sent'else 'pending'end,sent_at=case when success then now()else null end,available_at=now()+interval '15 minutes',last_error=left(error_text,500)where id=email_id and status='sending';
$$;
revoke all on function public.prepare_parent_reminders(timestamptz),public.claim_parent_emails(),public.finish_parent_email(uuid,boolean,text)from public,anon,authenticated;
grant execute on function public.prepare_parent_reminders(timestamptz),public.claim_parent_emails(),public.finish_parent_email(uuid,boolean,text)to service_role;
