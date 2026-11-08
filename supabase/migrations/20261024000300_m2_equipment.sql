-- Append-only equipment ledger; all state changes use the shared audit/retry path.
create table public.pack_equipment_state (
  scout_id uuid primary key references public.scouts(id),
  revision integer not null check(revision>0)
);
create table public.pack_equipment_events (
  id uuid primary key,
  scout_id uuid not null references public.scouts(id),
  revision integer not null,
  action text not null check(action in ('review_shirt_history','record_historical_shirt','give_free_item','issue_loan','return_loan','report_loan_loss','pay_loan_loss','request_purchase','set_purchase_price','pay_purchase','deliver_purchase','void_equipment_event')),
  scouting_year text not null,
  occurred_on date not null,
  item text check(item in ('tshirt','neckerchief','slider','lion_book','tiger_book','first_aid_kit')),
  quantity integer check(quantity between 1 and 100),
  size text check(length(size) between 1 and 40),
  target_id uuid references public.pack_equipment_events(id),
  amount_minor bigint check(amount_minor between 0 and 100000000),
  currency text check(currency ~ '^[A-Z]{3}$'),
  note text check(length(note)<=500),
  recorded_at timestamptz not null default now(),
  recorded_by uuid not null,
  unique(scout_id,revision)
);
create index pack_equipment_target on public.pack_equipment_events(target_id);
create index pack_equipment_scout_year on public.pack_equipment_events(scout_id,scouting_year);
alter table public.pack_equipment_state enable row level security;
alter table public.pack_equipment_events enable row level security;
revoke all on public.pack_equipment_state,public.pack_equipment_events from public,anon,authenticated;
grant select on public.pack_equipment_state,public.pack_equipment_events to authenticated;
create policy approved_equipment_state on public.pack_equipment_state for select to authenticated using ((select public.is_approved_leader()));
create policy approved_equipment_events on public.pack_equipment_events for select to authenticated using ((select public.is_approved_leader()));
create view public.pack_active_equipment with (security_invoker=true) as
  select e.* from public.pack_equipment_events e where e.action<>'void_equipment_event'
    and not exists(select 1 from public.pack_equipment_events v where v.action='void_equipment_event' and v.target_id=e.id);
grant select on public.pack_active_equipment to authenticated;

create function public.pack_shirt_eligibility(scout_id uuid, scouting_year text) returns text
language plpgsql stable security invoker set search_path='' as $$
#variable_conflict use_variable
declare year integer;
begin
  if not public.is_approved_leader() then raise exception 'Access denied' using errcode='42501'; end if;
  if scouting_year is null or scouting_year !~ '^[0-9]{4}-[0-9]{2}$' or right(scouting_year,2)<>right((left(scouting_year,4)::int+1)::text,2) then raise exception 'Invalid scouting year'; end if;
  year:=left(scouting_year,4)::integer;
  if exists(select 1 from public.pack_active_equipment e where e.scout_id=scout_id and e.item='tshirt'
    and e.action in ('give_free_item','record_historical_shirt') and left(e.scouting_year,4)::int between year-1 and year) then return 'ineligible'; end if;
  if not exists(select 1 from public.pack_active_equipment e where e.scout_id=scout_id and e.action='review_shirt_history' and e.scouting_year=scouting_year) then return 'unknown'; end if;
  return 'eligible';
end;
$$;
revoke all on function public.pack_shirt_eligibility(uuid,text) from public,anon;
grant execute on function public.pack_shirt_eligibility(uuid,text) to authenticated;

alter function public.record_pack_operation(uuid,jsonb) rename to record_m2_operation;
alter function public.record_m2_operation(uuid,jsonb) set schema private;
revoke all on function private.record_m2_operation(uuid,jsonb) from public,anon,authenticated;
create function private.record_equipment_operation(request_id uuid,command jsonb) returns jsonb
language plpgsql security definer set search_path='' set statement_timeout='5s' as $$
#variable_conflict use_variable
declare
  previous public.pack_commands;
  actor uuid:=auth.uid();
  action text:=command->>'action';
  scout uuid;
  expected integer;
  current_revision integer;
  year text;
  happened date;
  target public.pack_equipment_events;
  root public.pack_equipment_events;
  quote public.pack_equipment_events;
  qty integer;
  amount bigint;
  money text;
  product text;
  balance bigint;
  used_qty integer;
  allowed text[];
  result jsonb;
begin
  if not private.can_record() then raise exception 'Recording access denied' using errcode='42501'; end if;
  if request_id is null or jsonb_typeof(command) is distinct from 'object' or octet_length(command::text)>8192 then raise exception 'Invalid command'; end if;
  perform pg_advisory_xact_lock(hashtextextended(request_id::text,0));
  select * into previous from public.pack_commands c where c.request_id=record_equipment_operation.request_id;
  if found then
    if previous.recorded_by<>actor or previous.command<>command then raise exception 'Request ID conflict'; end if;
    return previous.result;
  end if;
  allowed:=array['action','scout_id','scouting_year','expected_revision','occurred_on','note'];
  if action='review_shirt_history' then null;
  elsif action='record_historical_shirt' then null;
  elsif action='give_free_item' then allowed:=allowed||array['item','quantity','size','rank_at_issue'];
  elsif action='issue_loan' then allowed:=allowed||array['item','quantity'];
  elsif action='request_purchase' then allowed:=allowed||array['item','quantity','size','amount_minor','currency'];
  elsif action in ('return_loan','deliver_purchase') then allowed:=allowed||array['target_id','quantity'];
  elsif action='report_loan_loss' then allowed:=allowed||array['target_id','quantity','amount_minor','currency'];
  elsif action in ('pay_loan_loss','pay_purchase','set_purchase_price') then allowed:=allowed||array['target_id','amount_minor','currency'];
  elsif action='void_equipment_event' then allowed:=allowed||array['target_id'];
  else raise exception 'Unknown equipment action'; end if;
  if exists(select 1 from jsonb_each(command) e where not e.key=any(allowed) or jsonb_typeof(e.value)='null'
    or (e.key in ('quantity','amount_minor','expected_revision') and (jsonb_typeof(e.value)<>'number' or e.value::text !~ '^[0-9]+$'))
    or (e.key not in ('quantity','amount_minor','expected_revision') and jsonb_typeof(e.value)<>'string')) then raise exception 'Invalid command fields'; end if;
  scout:=(command->>'scout_id')::uuid; expected:=(command->>'expected_revision')::int; year:=command->>'scouting_year';
  if scout is null or expected is null or expected not between 0 and 2147483646 then raise exception 'Scout and expected revision required'; end if;
  if year is null or year !~ '^[0-9]{4}-[0-9]{2}$' or right(year,2)<>right((left(year,4)::int+1)::text,2) then raise exception 'Invalid scouting year'; end if;
  happened:=coalesce((command->>'occurred_on')::date,(now() at time zone 'America/Los_Angeles')::date);
  if command ? 'occurred_on' and (command->>'occurred_on' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or to_char(happened,'YYYY-MM-DD')<>command->>'occurred_on') then raise exception 'Invalid occurrence date'; end if;
  if happened>(now() at time zone 'America/Los_Angeles')::date then raise exception 'Occurrence cannot be in the future'; end if;
  perform 1 from public.scouts where id=scout for update;
  if not found then raise exception 'Unknown scout'; end if;
  select revision into current_revision from public.pack_equipment_state where scout_id=scout;
  if coalesce(current_revision,0)<>expected then raise exception 'Revision conflict; read current state'; end if;
  qty:=(command->>'quantity')::int; amount:=(command->>'amount_minor')::bigint; money:=command->>'currency'; product:=command->>'item';
  if qty is not null and qty not between 1 and 100 then raise exception 'Invalid quantity'; end if;
  if (amount is null)<>(money is null) or (amount is not null and (amount not between 0 and 100000000 or money !~ '^[A-Z]{3}$')) then raise exception 'Amount and currency required together'; end if;
  if command ? 'target_id' then
    select * into target from public.pack_active_equipment where id=(command->>'target_id')::uuid;
    if not found or target.scout_id<>scout then raise exception 'Unknown active target for this scout'; end if;
    if target.scouting_year<>year then raise exception 'Use the target scouting year'; end if;
    if happened<target.occurred_on then raise exception 'Event date precedes target'; end if;
    product:=target.item;
  end if;
  if action in ('review_shirt_history','record_historical_shirt','void_equipment_event') and (command->>'note' is null or length(btrim(command->>'note')) not between 1 and 500) then raise exception 'Review or correction note required'; end if;
  if action='record_historical_shirt' then product:='tshirt'; qty:=1; end if;
  if action in ('give_free_item','record_historical_shirt') then
    if qty is null then raise exception 'Quantity required'; end if;
    if product is null or product not in ('tshirt','first_aid_kit','lion_book','tiger_book') then raise exception 'Item is not a free distribution'; end if;
    if product='tshirt' then
      if qty<>1 then raise exception 'One free shirt per eligible period'; end if;
      if exists(select 1 from public.pack_active_equipment e where e.scout_id=scout and e.item='tshirt' and e.action in ('give_free_item','record_historical_shirt')
        and abs(left(e.scouting_year,4)::int-left(year,4)::int)<=1) then raise exception 'Free shirt already issued within two-year interval'; end if;
      if action='give_free_item' and public.pack_shirt_eligibility(scout,year)<>'eligible' then raise exception 'Shirt history must be reviewed before free issue'; end if;
    end if;
    if product in ('lion_book','tiger_book') and (qty<>1 or command->>'rank_at_issue' is distinct from split_part(product,'_',1)) then raise exception 'Free book requires matching Lion or Tiger rank at issue'; end if;
  elsif action='issue_loan' then
    if qty is null or product is null or product not in ('neckerchief','slider') then raise exception 'Only neckerchiefs and sliders can be loaned'; end if;
  elsif action='request_purchase' then
    if qty is null or product is null or product not in ('tshirt','neckerchief','slider','lion_book','tiger_book') then raise exception 'Invalid purchase request'; end if;
  elsif action in ('return_loan','report_loan_loss') then
    if target.id is null or target.action<>'issue_loan' or qty is null then raise exception 'Loan and quantity required'; end if;
    select coalesce(sum(e.quantity),0) into used_qty from public.pack_active_equipment e where e.target_id=target.id and e.action in ('return_loan','report_loan_loss');
    if used_qty+qty>target.quantity then raise exception 'Quantity exceeds outstanding loan'; end if;
    if action='report_loan_loss' and amount is null then raise exception 'Loss charge and currency required'; end if;
  elsif action='pay_loan_loss' then
    if target.id is null or target.action<>'report_loan_loss' or amount is null or amount<=0 or money<>target.currency then raise exception 'Lost-item charge and matching payment currency required'; end if;
    select coalesce(sum(e.amount_minor),0) into balance from public.pack_active_equipment e where e.target_id=target.id and e.action='pay_loan_loss';
    if balance+amount>target.amount_minor then raise exception 'Payment exceeds outstanding charge'; end if;
  elsif action in ('pay_purchase','set_purchase_price','deliver_purchase') then
    if target.id is null or target.action<>'request_purchase' then raise exception 'Purchase request required'; end if;
    if action='deliver_purchase' then
      select coalesce(sum(e.quantity),0) into used_qty from public.pack_active_equipment e where e.target_id=target.id and e.action='deliver_purchase';
      if qty is null or used_qty+qty>target.quantity then raise exception 'Quantity exceeds unfulfilled purchase'; end if;
    else
      select * into quote from public.pack_active_equipment e where e.target_id=target.id and e.action='set_purchase_price' order by revision desc limit 1;
      if not found then quote:=target; end if;
      select coalesce(sum(e.amount_minor),0) into balance from public.pack_active_equipment e where e.target_id=target.id and e.action='pay_purchase';
      if amount is null then raise exception 'Amount and currency required'; end if;
      if action='pay_purchase' then
        if quote.amount_minor is null or money<>quote.currency or amount<=0 then raise exception 'Known purchase price and matching payment currency required'; end if;
        if happened<quote.occurred_on then raise exception 'Payment date precedes price'; end if;
        if balance+amount>quote.amount_minor then raise exception 'Payment exceeds purchase balance'; end if;
      elsif balance>0 and (money<>quote.currency or amount<balance) then raise exception 'Price cannot invalidate recorded payments'; end if;
    end if;
  elsif action='void_equipment_event' then
    if target.id is null then raise exception 'Active event required'; end if;
    if exists(select 1 from public.pack_active_equipment e where e.target_id=target.id) then raise exception 'Void dependent events first'; end if;
    if target.action='set_purchase_price' and exists(select 1 from public.pack_active_equipment e where e.target_id=target.target_id and e.action='pay_purchase') then raise exception 'Void payments before correcting price'; end if;
    if target.action='review_shirt_history' and exists(select 1 from public.pack_active_equipment e where e.scout_id=scout and e.scouting_year=year and e.action='give_free_item' and e.item='tshirt') then raise exception 'Void dependent shirt issue first'; end if;
  end if;
  insert into public.pack_equipment_state(scout_id,revision) values(scout,expected+1)
    on conflict on constraint pack_equipment_state_pkey do update set revision=excluded.revision;
  insert into public.pack_equipment_events(id,scout_id,revision,action,scouting_year,occurred_on,item,quantity,size,target_id,amount_minor,currency,note,recorded_by)
  values(request_id,scout,expected+1,action,year,happened,product,qty,command->>'size',target.id,amount,money,command->>'note',actor);
  result:=jsonb_build_object('event_id',request_id,'scout_id',scout,'revision',expected+1,'occurred_on',happened);
  insert into public.pack_commands(request_id,command,result,recorded_by) values(request_id,command,result,actor);
  return result;
end;
$$;
revoke all on function private.record_equipment_operation(uuid,jsonb) from public,anon,authenticated;
create function public.record_pack_operation(request_id uuid,command jsonb) returns jsonb
language plpgsql security definer set search_path='' set statement_timeout='5s' as $$
begin
  if not private.can_record() then raise exception 'Recording access denied' using errcode='42501'; end if;
  if command->>'action' in ('review_shirt_history','record_historical_shirt','give_free_item','issue_loan','return_loan','report_loan_loss','pay_loan_loss','request_purchase','set_purchase_price','pay_purchase','deliver_purchase','void_equipment_event') then
    return private.record_equipment_operation(request_id,command);
  end if;
  return private.record_m2_operation(request_id,command);
end;
$$;
revoke all on function public.record_pack_operation(uuid,jsonb) from public,anon;
grant execute on function public.record_pack_operation(uuid,jsonb) to authenticated;

create view public.pack_loan_balances with (security_invoker=true) as
 select l.*, coalesce(r.quantity,0)::int returned_quantity,coalesce(x.quantity,0)::int lost_quantity,
  (l.quantity-coalesce(r.quantity,0)-coalesce(x.quantity,0))::int outstanding_quantity
 from public.pack_active_equipment l
 left join lateral(select sum(e.quantity) quantity from public.pack_active_equipment e where e.target_id=l.id and e.action='return_loan') r on true
 left join lateral(select sum(e.quantity) quantity from public.pack_active_equipment e where e.target_id=l.id and e.action='report_loan_loss') x on true
 where l.action='issue_loan';
create view public.pack_loss_balances with (security_invoker=true) as
 select l.*,coalesce(p.amount,0)::bigint paid_minor,(l.amount_minor-coalesce(p.amount,0))::bigint balance_minor
 from public.pack_active_equipment l
 left join lateral(select sum(e.amount_minor) amount from public.pack_active_equipment e where e.target_id=l.id and e.action='pay_loan_loss') p on true
 where l.action='report_loan_loss';
create view public.pack_purchase_balances with (security_invoker=true) as
 select l.*,coalesce(q.amount_minor,l.amount_minor) price_minor,coalesce(q.currency,l.currency) price_currency,
  coalesce(p.amount,0)::bigint paid_minor,(coalesce(q.amount_minor,l.amount_minor)-coalesce(p.amount,0))::bigint balance_minor,
  coalesce(d.quantity,0)::int delivered_quantity,(l.quantity-coalesce(d.quantity,0))::int unfulfilled_quantity
 from public.pack_active_equipment l
 left join lateral(select e.amount_minor,e.currency from public.pack_active_equipment e where e.target_id=l.id and e.action='set_purchase_price' order by revision desc limit 1) q on true
 left join lateral(select sum(e.amount_minor) amount from public.pack_active_equipment e where e.target_id=l.id and e.action='pay_purchase') p on true
 left join lateral(select sum(e.quantity) quantity from public.pack_active_equipment e where e.target_id=l.id and e.action='deliver_purchase') d on true
 where l.action='request_purchase';
grant select on public.pack_loan_balances,public.pack_loss_balances,public.pack_purchase_balances to authenticated;

create function public.read_pack_equipment(entity text,scout_id uuid default null,scouting_year text default null,page_offset integer default 0,page_limit integer default 50) returns jsonb
language plpgsql stable security invoker set search_path='' set statement_timeout='5s' as $$
#variable_conflict use_variable
declare rows jsonb; total integer;
begin
 if not public.is_approved_leader() then raise exception 'Access denied' using errcode='42501'; end if;
 if entity is null or entity not in ('events','loans','losses','purchases','eligibility') or page_limit is null or page_limit not between 1 and 100 or page_offset is null or page_offset not between 0 and 10000 then raise exception 'Invalid query'; end if;
 if entity='eligibility' and scouting_year is null then raise exception 'Scouting year required for eligibility'; end if;
 with records as (
  select to_jsonb(e)||jsonb_build_object('voided',exists(select 1 from public.pack_equipment_events v where v.action='void_equipment_event' and v.target_id=e.id)) record,e.id::text key from public.pack_equipment_events e
   where entity='events' and (scout_id is null or e.scout_id=scout_id) and (scouting_year is null or e.scouting_year=scouting_year)
  union all select to_jsonb(l),l.id::text from public.pack_loan_balances l where entity='loans' and (scout_id is null or l.scout_id=scout_id) and (scouting_year is null or l.scouting_year=scouting_year)
  union all select to_jsonb(l),l.id::text from public.pack_loss_balances l where entity='losses' and (scout_id is null or l.scout_id=scout_id) and (scouting_year is null or l.scouting_year=scouting_year)
  union all select to_jsonb(p),p.id::text from public.pack_purchase_balances p where entity='purchases' and (scout_id is null or p.scout_id=scout_id) and (scouting_year is null or p.scouting_year=scouting_year)
  union all select jsonb_build_object('scout_id',s.id,'revision',coalesce(e.revision,0),'scouting_year',scouting_year,'free_shirt_eligibility',public.pack_shirt_eligibility(s.id,scouting_year)),s.id::text
   from public.scouts s left join public.pack_equipment_state e on e.scout_id=s.id where entity='eligibility' and (scout_id is null or s.id=scout_id)
 ), page as(select record from records order by key limit page_limit offset page_offset)
 select (select count(*) from records),coalesce(jsonb_agg(page.record),'[]'::jsonb) into total,rows from page;
 return jsonb_build_object('total',total,'rows',rows,'next_offset',case when page_offset+jsonb_array_length(rows)<total then page_offset+jsonb_array_length(rows) else null end);
end;
$$;
revoke all on function public.read_pack_equipment(text,uuid,text,integer,integer) from public,anon;
grant execute on function public.read_pack_equipment(text,uuid,text,integer,integer) to authenticated;

create function public.record_pack_batch(entries jsonb) returns jsonb
language plpgsql security definer set search_path='' set statement_timeout='10s' as $$
declare entry jsonb; results jsonb:='[]'::jsonb; lock_id uuid;
begin
 if not private.can_record() then raise exception 'Recording access denied' using errcode='42501'; end if;
 if jsonb_typeof(entries) is distinct from 'array' or jsonb_array_length(entries) not between 1 and 25 or octet_length(entries::text)>60000 then raise exception 'Invalid batch'; end if;
 if exists(select 1 from jsonb_array_elements(entries) e where jsonb_typeof(e) is distinct from 'object' or not(e ? 'request_id' and e ? 'command') or exists(select 1 from jsonb_object_keys(e) k where k not in ('request_id','command'))) then raise exception 'Invalid batch entry'; end if;
 -- Lock request IDs before scout IDs consistently, then apply atomically in input order.
 for lock_id in select distinct (e->>'request_id')::uuid from jsonb_array_elements(entries) e order by 1 loop
  perform pg_advisory_xact_lock(hashtextextended(lock_id::text,0));
 end loop;
 for lock_id in select distinct (e->'command'->>'scout_id')::uuid from jsonb_array_elements(entries) e where e->'command' ? 'scout_id' order by 1 loop
  perform 1 from public.scouts where id=lock_id for update;
 end loop;
 for entry in select * from jsonb_array_elements(entries) loop
  results:=results||jsonb_build_array(public.record_pack_operation((entry->>'request_id')::uuid,entry->'command'));
 end loop;
 return results;
end;
$$;
revoke all on function public.record_pack_batch(jsonb) from public,anon;
grant execute on function public.record_pack_batch(jsonb) to authenticated;
