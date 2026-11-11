-- Assistant proposals are private, owner-bound and committed by explicit approval.
create table private.pack_assistant_proposals (
 id uuid primary key default gen_random_uuid(), actor_id uuid not null references auth.users(id) on delete cascade,
 entries jsonb not null, preview jsonb not null,
 state text not null default 'pending' check(state in ('pending','saved','cancelled')),
 result jsonb, created_at timestamptz not null default now(),
 expires_at timestamptz not null default now()+interval '30 minutes'
);
create index pack_assistant_proposals_actor on private.pack_assistant_proposals(actor_id,created_at);
create table private.pack_assistant_usage (
 actor_id uuid not null references auth.users(id) on delete cascade, hour timestamptz not null, requests integer not null,
 primary key(actor_id,hour)
);
alter table private.pack_assistant_proposals enable row level security;
alter table private.pack_assistant_usage enable row level security;
revoke all on private.pack_assistant_proposals,private.pack_assistant_usage from public,anon,authenticated;

-- A deleted scout must not survive in proposal JSON, including saved receipts.
create function private.remove_scout_assistant_proposals() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 delete from private.pack_assistant_proposals where exists(
  select 1 from jsonb_array_elements(entries) e where e->'command'->>'scout_id'=old.id::text);
 return old;
end;$$;
revoke all on function private.remove_scout_assistant_proposals() from public,anon,authenticated;
create trigger remove_scout_assistant_proposals after delete on public.scouts
 for each row execute function private.remove_scout_assistant_proposals();

create function public.consume_pack_assistant_budget() returns void
language plpgsql security definer set search_path='' as $$
declare used integer;
begin
 if not public.is_approved_leader() then raise exception 'Access denied' using errcode='42501';end if;
 insert into private.pack_assistant_usage(actor_id,hour,requests) values(auth.uid(),date_trunc('hour',now()),1)
 on conflict(actor_id,hour) do update set requests=private.pack_assistant_usage.requests+1 returning requests into used;
 if used>40 then raise exception 'Assistant hourly limit reached' using errcode='P0001';end if;
 -- Short-lived drafts are not a second permanent record of scout history.
 delete from private.pack_assistant_proposals where actor_id=auth.uid() and created_at<now()-interval '7 days';
 delete from private.pack_assistant_usage where actor_id=auth.uid() and hour<now()-interval '2 days';
end;$$;

create function public.prepare_pack_assistant_change(entries jsonb,preview jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_variable
declare p private.pack_assistant_proposals;
begin
 if not private.can_record() then raise exception 'Recording access denied' using errcode='42501';end if;
 if jsonb_typeof(entries) is distinct from 'array' or jsonb_array_length(entries) not between 1 and 25
 or octet_length(entries::text)>60000 or jsonb_typeof(preview) is distinct from 'object' or octet_length(preview::text)>60000 then raise exception 'Invalid proposal';end if;
 if exists(select 1 from jsonb_array_elements(entries) e where e->'command'->>'action' is null or e->'command'->>'action' not in
 ('record_attendance','record_registration','record_requirement','earn_adventure','deliver_badge','issue_loan','return_loan')) then raise exception 'Unsupported assistant change';end if;
 perform pg_advisory_xact_lock(hashtextextended('assistant:'||auth.uid()::text,0));
 update private.pack_assistant_proposals set state='cancelled' where actor_id=auth.uid() and state='pending';
 insert into private.pack_assistant_proposals(actor_id,entries,preview) values(auth.uid(),entries,preview) returning * into p;
 return jsonb_build_object('id',p.id,'state',p.state,'expires_at',p.expires_at,'preview',p.preview,'entries',p.entries);
end;$$;

create function public.read_pack_assistant_change(proposal_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare p private.pack_assistant_proposals;
begin
 if not public.is_approved_leader() then raise exception 'Access denied' using errcode='42501';end if;
 select * into p from private.pack_assistant_proposals where id=proposal_id and actor_id=auth.uid();
 if not found then raise exception 'Proposal unavailable';end if;
 return jsonb_build_object('id',p.id,'state',case when p.state='pending' and p.expires_at<now() then 'expired' else p.state end,
 'expires_at',p.expires_at,'preview',p.preview,'entries',p.entries,'result',p.result);
end;$$;

create function public.confirm_pack_assistant_change(proposal_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare p private.pack_assistant_proposals;receipt jsonb;
begin
 if not private.can_record() then raise exception 'Recording access denied' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended('assistant:'||auth.uid()::text,0));
 select * into p from private.pack_assistant_proposals where id=proposal_id and actor_id=auth.uid() for update;
 if not found then raise exception 'Proposal unavailable';end if;
 if p.state='saved' then return p.result;end if;
 if p.state<>'pending' or p.expires_at<now() then raise exception 'Proposal expired or cancelled; review again';end if;
 -- Existing revision checks, recording capabilities, notifications and stable
 -- request IDs remain authoritative. A failed batch rolls back everything.
 receipt:=public.record_pack_batch(p.entries);
 update private.pack_assistant_proposals set state='saved',result=receipt where id=p.id;
 return receipt;
end;$$;

create function public.cancel_pack_assistant_change(proposal_id uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
 if not public.is_approved_leader() then raise exception 'Access denied' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended('assistant:'||auth.uid()::text,0));
 update private.pack_assistant_proposals set state='cancelled' where id=proposal_id and actor_id=auth.uid() and state='pending';
end;$$;
revoke all on function public.consume_pack_assistant_budget(),public.prepare_pack_assistant_change(jsonb,jsonb),public.read_pack_assistant_change(uuid),public.confirm_pack_assistant_change(uuid),public.cancel_pack_assistant_change(uuid) from public,anon;
grant execute on function public.consume_pack_assistant_budget(),public.prepare_pack_assistant_change(jsonb,jsonb),public.read_pack_assistant_change(uuid),public.confirm_pack_assistant_change(uuid),public.cancel_pack_assistant_change(uuid) to authenticated;
