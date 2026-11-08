create table public.pack_den_plans (
 den text not null check(den in ('0-Lions','1-Tigers','2-Wolves','3-Bears','4-Webelos','5-AOL')),
 scouting_year text not null check(scouting_year ~ '^[0-9]{4}-[0-9]{2}$'),
 adventure_ids uuid[] not null check(cardinality(adventure_ids)=2),
 revision integer not null check(revision>0),
 recorded_at timestamptz not null default now(), recorded_by uuid not null,
 primary key(den,scouting_year)
);
alter table public.pack_den_plans enable row level security;
revoke all on public.pack_den_plans from public,anon,authenticated;
grant select on public.pack_den_plans to authenticated;
create policy approved_den_plans on public.pack_den_plans for select to authenticated using ((select public.is_approved_leader()));

create function public.read_pack_den_plans(scouting_year text) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
#variable_conflict use_variable
begin
 if not public.is_approved_leader() then raise exception 'Access denied' using errcode='42501'; end if;
 if scouting_year is null or scouting_year !~ '^[0-9]{4}-[0-9]{2}$' or right(scouting_year,2)<>right((left(scouting_year,4)::int+1)::text,2) then raise exception 'Invalid scouting year'; end if;
 return (select coalesce(jsonb_agg(to_jsonb(p) order by p.den),'[]'::jsonb) from public.pack_den_plans p where p.scouting_year=read_pack_den_plans.scouting_year);
end;
$$;
revoke all on function public.read_pack_den_plans(text) from public,anon;
grant execute on function public.read_pack_den_plans(text) to authenticated;

create function private.record_den_priorities(request_id uuid,command jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_variable
declare previous public.pack_commands; d text:=command->>'den'; y text:=command->>'scouting_year'; ids uuid[]; rank_name text; current_revision integer; result jsonb;
begin
 if not private.can_record() then raise exception 'Recording access denied' using errcode='42501'; end if;
 if request_id is null or jsonb_typeof(command) is distinct from 'object' or octet_length(command::text)>8192 then raise exception 'Invalid command'; end if;
 perform pg_advisory_xact_lock(hashtextextended(request_id::text,0));
 select * into previous from public.pack_commands c where c.request_id=record_den_priorities.request_id;
 if found then
  if previous.recorded_by<>auth.uid() or previous.command<>command then raise exception 'Request ID conflict'; end if;
  return previous.result;
 end if;
 if exists(select 1 from jsonb_each(command) e where not e.key=any(array['action','den','scouting_year','adventure_ids','expected_revision']) or jsonb_typeof(e.value)='null') then raise exception 'Invalid den plan fields'; end if;
 if jsonb_typeof(command->'adventure_ids') is distinct from 'array' or jsonb_array_length(command->'adventure_ids')<>2 or jsonb_typeof(command->'expected_revision') is distinct from 'number' or command->>'expected_revision' !~ '^[0-9]+$' then raise exception 'Choose exactly two elective adventures'; end if;
 if y is null or y !~ '^[0-9]{4}-[0-9]{2}$' or right(y,2)<>right((left(y,4)::int+1)::text,2) then raise exception 'Invalid scouting year'; end if;
 rank_name:=case d when '0-Lions' then 'lion' when '1-Tigers' then 'tiger' when '2-Wolves' then 'wolf' when '3-Bears' then 'bear' when '4-Webelos' then 'webelos' when '5-AOL' then 'arrow_of_light' end;
 if rank_name is null then raise exception 'Choose a den'; end if;
 select array_agg(value::uuid) into ids from jsonb_array_elements_text(command->'adventure_ids');
 if ids[1]=ids[2] or (select count(*) from public.pack_adventures a where a.id=any(ids) and a.rank=rank_name and a.catalog_context->>'adventure_type'='Elective')<>2 then raise exception 'Choose two distinct electives for this den'; end if;
 perform pg_advisory_xact_lock(hashtextextended('den-plan:'||d||':'||y,0));
 select p.revision into current_revision from public.pack_den_plans p where p.den=d and p.scouting_year=y for update;
 if coalesce(current_revision,0)<>(command->>'expected_revision')::integer then raise exception 'Revision conflict; read current state'; end if;
 insert into public.pack_den_plans(den,scouting_year,adventure_ids,revision,recorded_by)
 values(d,y,ids,coalesce(current_revision,0)+1,auth.uid())
 on conflict(den,scouting_year) do update set adventure_ids=excluded.adventure_ids,revision=excluded.revision,recorded_at=now(),recorded_by=auth.uid();
 result:=jsonb_build_object('den',d,'revision',coalesce(current_revision,0)+1,'adventure_ids',ids);
 insert into public.pack_commands(request_id,command,result,recorded_by) values(request_id,command,result,auth.uid());
 return result;
end;
$$;
revoke all on function private.record_den_priorities(uuid,jsonb) from public,anon,authenticated;

create or replace function public.record_pack_operation(request_id uuid,command jsonb) returns jsonb
language plpgsql security definer set search_path='' set statement_timeout='5s' as $$
begin
 if not private.can_record() then raise exception 'Recording access denied' using errcode='42501'; end if;
 if command->>'action'='set_den_priorities' then return private.record_den_priorities(request_id,command);
 elsif command->>'action' in ('define_inventory_item','inventory_count','inventory_receive','inventory_issue') then return private.record_inventory_operation(request_id,command);
 elsif command->>'action' in ('review_shirt_history','record_historical_shirt','give_free_item','issue_loan','return_loan','report_loan_loss','pay_loan_loss','request_purchase','set_purchase_price','pay_purchase','deliver_purchase','void_equipment_event') then return private.record_equipment_operation(request_id,command);
 end if;
 return private.record_m2_operation(request_id,command);
end;
$$;
