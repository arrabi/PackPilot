-- Address-specific notification preferences are controlled by pack administrators.
-- They do not affect requested authentication emails or remove family access.
create table private.pack_email_preferences (
 email text primary key check(email=lower(btrim(email))),
 suppressed boolean not null,
 changed_by uuid not null references auth.users(id), changed_at timestamptz not null default now()
);
create table private.pack_email_preference_changes (
 request_id uuid primary key, email text not null,
 previous_suppressed boolean not null, suppressed boolean not null,
 changed_by uuid not null references auth.users(id), changed_at timestamptz not null default now()
);
alter table private.pack_email_preferences enable row level security;
alter table private.pack_email_preference_changes enable row level security;
revoke all on private.pack_email_preferences,private.pack_email_preference_changes from public,anon,authenticated;

create function private.is_pack_admin() returns boolean
language sql stable security definer set search_path='' as $$
 select private.is_approved_leader() and exists(
 select 1 from public.leader_access l join auth.users u on private.canonical_leader_email(u.email)=private.canonical_leader_email(l.email)
 where u.id=auth.uid() and l.active and l.role='admin');
$$;
revoke all on function private.is_pack_admin()from public,anon,authenticated;
create function public.read_pack_email_preferences() returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('is_admin',private.is_pack_admin(),'addresses',case when private.is_pack_admin() then
 (select coalesce(jsonb_agg(jsonb_build_object('email',email,'suppressed',suppressed,'changed_at',changed_at)order by email),'[]')from private.pack_email_preferences)else '[]'::jsonb end);
$$;
create function public.set_pack_email_preference(request_id uuid,mailbox text,suppressed boolean) returns void
language plpgsql security definer set search_path='' as $$
#variable_conflict use_variable
declare address text:=lower(btrim(mailbox)); prior boolean; prior_command private.pack_email_preference_changes;
begin
 if not private.is_pack_admin()then raise exception 'Pack administrator access required' using errcode='42501';end if;
 if request_id is null or suppressed is null or address is null or length(address)>254 or address !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'then raise exception 'Provide a valid email address and notification setting';end if;
 perform pg_advisory_xact_lock(hashtext(request_id::text));
 select * into prior_command from private.pack_email_preference_changes c where c.request_id=request_id;
 if found then
  if prior_command.email<>address or prior_command.suppressed<>suppressed or prior_command.changed_by<>auth.uid()then raise exception 'Request ID already used';end if;
  return;
 end if;
 perform pg_advisory_xact_lock(hashtext('email:'||address));
 select p.suppressed into prior from private.pack_email_preferences p where email=address;
 insert into private.pack_email_preference_changes values(request_id,address,coalesce(prior,false),suppressed,auth.uid(),now());
 insert into private.pack_email_preferences values(address,suppressed,auth.uid(),now())on conflict(email)do update set suppressed=excluded.suppressed,changed_by=excluded.changed_by,changed_at=excluded.changed_at;
 if suppressed then update private.pack_email_outbox set status='cancelled'where recipient=address and status in('pending','sending');end if;
end;$$;
revoke all on function public.read_pack_email_preferences(),public.set_pack_email_preference(uuid,text,boolean)from public,anon;
grant execute on function public.read_pack_email_preferences(),public.set_pack_email_preference(uuid,text,boolean)to authenticated;

create function private.suppress_parent_email()returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from private.pack_email_preferences p where p.email=lower(btrim(new.recipient))and p.suppressed)then new.status:='cancelled';end if;
 return new;
end;$$;
revoke all on function private.suppress_parent_email()from public,anon,authenticated;
create trigger suppress_parent_email before insert on private.pack_email_outbox for each row execute function private.suppress_parent_email();

-- Claiming, retrying and the final pre-send check all respect current preferences.
create or replace function public.claim_parent_emails() returns jsonb
language plpgsql security definer set search_path='' as $$
declare claimed_emails jsonb;
begin
 update private.pack_email_outbox q set status='cancelled'where q.status in('pending','sending')and exists(select 1 from private.pack_email_preferences p where p.email=q.recipient and p.suppressed);
 -- Recheck revocation before dispatch, including weekly mailbox access.
 update private.pack_email_outbox q set status='cancelled'where status in('pending','sending')and not exists(select 1 from public.parent_scout_links l join public.scouts s on s.id=l.scout_id where l.active and lower(btrim(l.parent_email))=q.recipient and(q.scout_id is null or q.scout_id=l.scout_id)and coalesce(s.den,'') !~* '^\s*\(withdraw\)');
 update private.pack_email_outbox q set status='cancelled'where q.status in('pending','sending')and q.child_ids is not null and exists(select 1 from unnest(q.child_ids)child where not exists(select 1 from public.parent_scout_links l join public.scouts s on s.id=l.scout_id where l.scout_id=child and l.active and lower(btrim(l.parent_email))=q.recipient and coalesce(s.den,'') !~* '^\s*\(withdraw\)'));
 with selected as(select id from private.pack_email_outbox where(status='pending'and available_at<=now())or(status='sending'and claimed_at<now()-interval '15 minutes')order by available_at limit 40 for update skip locked), claimed as(update private.pack_email_outbox q set status='sending',claimed_at=now(),attempts=attempts+1 from selected s where s.id=q.id returning q.*)select coalesce(jsonb_agg(to_jsonb(c)),'[]')into claimed_emails from claimed c;
 return claimed_emails;
end;$$;
create function public.can_send_parent_email(email_id uuid)returns boolean
language plpgsql security definer set search_path='' as $$
declare allowed boolean;
begin
 select q.status='sending'
 and not exists(select 1 from private.pack_email_preferences p where p.email=q.recipient and p.suppressed)
 and exists(select 1 from public.parent_scout_links l join public.scouts s on s.id=l.scout_id where l.active and lower(btrim(l.parent_email))=q.recipient and(q.scout_id is null or q.scout_id=l.scout_id)and coalesce(s.den,'')!~* '^\s*\(withdraw\)')
 and not exists(select 1 from unnest(q.child_ids)child where not exists(select 1 from public.parent_scout_links l join public.scouts s on s.id=l.scout_id where l.scout_id=child and l.active and lower(btrim(l.parent_email))=q.recipient and coalesce(s.den,'')!~* '^\s*\(withdraw\)'))
 into allowed from private.pack_email_outbox q where q.id=email_id;
 if not coalesce(allowed,false)then update private.pack_email_outbox set status='cancelled'where id=email_id and status in('pending','sending');end if;
 return coalesce(allowed,false);
end;$$;
revoke all on function public.can_send_parent_email(uuid)from public,anon,authenticated;
grant execute on function public.can_send_parent_email(uuid)to service_role;
