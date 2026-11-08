create table public.pack_inventory_items (
 id uuid primary key,
 name text not null check(length(btrim(name)) between 1 and 200),
 den text check(den in ('0-Lions','1-Tigers','2-Wolves','3-Bears','4-Webelos','5-AOL')),
 category text not null check(category in ('required_badge','elective_badge','neckerchief','slider','book','rank_insignia','other')),
 quantity_on_hand integer check(quantity_on_hand between 0 and 1000000),
 revision integer not null check(revision>0),
 last_counted_on date,
 last_recorded_on date not null,
 source_context jsonb not null default '{}'::jsonb,
 updated_at timestamptz not null default now(),
 updated_by uuid not null
);
create table public.pack_inventory_events (
 id uuid primary key,
 item_id uuid not null references public.pack_inventory_items(id),
 action text not null check(action in ('define_inventory_item','inventory_count','inventory_receive','inventory_issue')),
 quantity integer check(quantity between 0 and 1000000),
 quantity_before integer,
 quantity_after integer,
 revision integer not null,
 occurred_on date not null,
 note text not null check(length(btrim(note)) between 1 and 500),
 recorded_at timestamptz not null default now(),
 recorded_by uuid not null,
 unique(item_id,revision)
);
alter table public.pack_inventory_items enable row level security;
alter table public.pack_inventory_events enable row level security;
revoke all on public.pack_inventory_items,public.pack_inventory_events from public,anon,authenticated;
grant select on public.pack_inventory_items,public.pack_inventory_events to authenticated;
create policy approved_inventory_read on public.pack_inventory_items for select to authenticated using ((select public.is_approved_leader()));
create policy approved_inventory_history on public.pack_inventory_events for select to authenticated using ((select public.is_approved_leader()));

create function private.record_inventory_operation(request_id uuid, command jsonb) returns jsonb
language plpgsql security definer set search_path='' set statement_timeout='5s' as $$
#variable_conflict use_variable
declare
 actor uuid:=auth.uid(); previous public.pack_commands; current_item public.pack_inventory_items;
 action text:=command->>'action'; item uuid; happened date; counted date; qty integer; after_qty integer;
 new_revision integer; result jsonb; allowed text[];
begin
 if not private.can_record() then raise exception 'Recording access denied' using errcode='42501'; end if;
 if request_id is null or jsonb_typeof(command) is distinct from 'object' or octet_length(command::text)>8192 then raise exception 'Invalid command'; end if;
 perform pg_advisory_xact_lock(hashtextextended(request_id::text,0));
 select * into previous from public.pack_commands c where c.request_id=record_inventory_operation.request_id;
 if found then
  if previous.recorded_by<>actor or previous.command<>command then raise exception 'Request ID conflict'; end if;
  return previous.result;
 end if;
 allowed:=array['action','item_id','occurred_on','note','quantity'];
 if action='define_inventory_item' then allowed:=allowed||array['name','den','category','counted_on','source_context'];
 elsif action in ('inventory_count','inventory_receive','inventory_issue') then allowed:=allowed||array['expected_revision'];
 else raise exception 'Unknown inventory action'; end if;
 if exists(select 1 from jsonb_each(command) e where not e.key=any(allowed) or jsonb_typeof(e.value)='null'
  or (e.key in ('quantity','expected_revision') and (jsonb_typeof(e.value)<>'number' or e.value::text !~ '^[0-9]+$'))
  or (e.key='source_context' and (jsonb_typeof(e.value)<>'object' or octet_length(e.value::text)>4000))
  or (e.key not in ('quantity','expected_revision','source_context') and jsonb_typeof(e.value)<>'string')) then raise exception 'Invalid inventory fields'; end if;
 item:=(command->>'item_id')::uuid;
 if item is null or command->>'note' is null or length(btrim(command->>'note')) not between 1 and 500 then raise exception 'Inventory item and reason required'; end if;
 happened:=coalesce((command->>'occurred_on')::date,(now() at time zone 'America/Los_Angeles')::date);
 if command ? 'occurred_on' and (command->>'occurred_on' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or to_char(happened,'YYYY-MM-DD')<>command->>'occurred_on') then raise exception 'Invalid occurrence date'; end if;
 if happened>(now() at time zone 'America/Los_Angeles')::date then raise exception 'Occurrence cannot be in the future'; end if;
 qty:=(command->>'quantity')::integer;
 if qty is not null and qty not between 0 and 1000000 then raise exception 'Invalid inventory quantity'; end if;
 perform pg_advisory_xact_lock(hashtextextended('inventory:'||item::text,0));
 select * into current_item from public.pack_inventory_items i where i.id=item for update;
 if action='define_inventory_item' then
  if found then raise exception 'Inventory item already exists'; end if;
  if command->>'name' is null or length(btrim(command->>'name')) not between 1 and 200 or command->>'category' is null then raise exception 'Inventory name and category required'; end if;
  counted:=(command->>'counted_on')::date;
  if counted is not null and (qty is null or counted>happened or to_char(counted,'YYYY-MM-DD')<>command->>'counted_on') then raise exception 'Invalid inventory count date'; end if;
  after_qty:=qty;new_revision:=1;
  insert into public.pack_inventory_items(id,name,den,category,quantity_on_hand,revision,last_counted_on,last_recorded_on,source_context,updated_by)
  values(item,btrim(command->>'name'),command->>'den',command->>'category',after_qty,1,counted,happened,coalesce(command->'source_context','{}'::jsonb),actor);
 else
  if not found then raise exception 'Unknown inventory item'; end if;
  if command->>'expected_revision' is null or (command->>'expected_revision')::integer<>current_item.revision then raise exception 'Revision conflict; read current state'; end if;
  if happened<current_item.last_recorded_on then raise exception 'Inventory date precedes latest record'; end if;
  if qty is null or (action<>'inventory_count' and qty<1) then raise exception 'Invalid inventory quantity'; end if;
  if action<>'inventory_count' and current_item.quantity_on_hand is null then raise exception 'Inventory quantity is unknown; record a count first'; end if;
  after_qty:=case action when 'inventory_count' then qty when 'inventory_receive' then current_item.quantity_on_hand+qty else current_item.quantity_on_hand-qty end;
  if after_qty<0 then raise exception 'Insufficient inventory stock'; end if;
  if after_qty>1000000 then raise exception 'Inventory quantity limit exceeded'; end if;
  new_revision:=current_item.revision+1;
  update public.pack_inventory_items set quantity_on_hand=after_qty,revision=new_revision,
   last_counted_on=case when action='inventory_count' then happened else last_counted_on end,
   last_recorded_on=happened,updated_at=now(),updated_by=actor where id=item;
 end if;
 insert into public.pack_inventory_events(id,item_id,action,quantity,quantity_before,quantity_after,revision,occurred_on,note,recorded_by)
 values(request_id,item,action,qty,current_item.quantity_on_hand,after_qty,new_revision,happened,btrim(command->>'note'),actor);
 result:=jsonb_build_object('item_id',item,'revision',new_revision,'quantity_on_hand',after_qty,'occurred_on',happened);
 insert into public.pack_commands(request_id,command,result,recorded_by) values(request_id,command,result,actor);
 return result;
end;
$$;
revoke all on function private.record_inventory_operation(uuid,jsonb) from public,anon,authenticated;

create or replace function public.record_pack_operation(request_id uuid,command jsonb) returns jsonb
language plpgsql security definer set search_path='' set statement_timeout='5s' as $$
begin
 if not private.can_record() then raise exception 'Recording access denied' using errcode='42501'; end if;
 if command->>'action' in ('define_inventory_item','inventory_count','inventory_receive','inventory_issue') then
  return private.record_inventory_operation(request_id,command);
 elsif command->>'action' in ('review_shirt_history','record_historical_shirt','give_free_item','issue_loan','return_loan','report_loan_loss','pay_loan_loss','request_purchase','set_purchase_price','pay_purchase','deliver_purchase','void_equipment_event') then
  return private.record_equipment_operation(request_id,command);
 end if;
 return private.record_m2_operation(request_id,command);
end;
$$;

create function public.read_pack_inventory(entity text, item_id uuid default null, page_offset integer default 0, page_limit integer default 50) returns jsonb
language plpgsql stable security invoker set search_path='' set statement_timeout='5s' as $$
#variable_conflict use_variable
declare rows jsonb; total integer;
begin
 if not public.is_approved_leader() then raise exception 'Access denied' using errcode='42501'; end if;
 if entity is null or entity not in ('items','events') or page_offset is null or page_offset not between 0 and 10000 or page_limit is null or page_limit not between 1 and 100 then raise exception 'Invalid inventory query'; end if;
 with records as (
  select to_jsonb(i) record,i.id::text sort_key from public.pack_inventory_items i where entity='items' and (item_id is null or i.id=item_id)
  union all
  select to_jsonb(e),e.item_id::text||':'||lpad(e.revision::text,10,'0') from public.pack_inventory_events e where entity='events' and (item_id is null or e.item_id=item_id)
 ), page as (select * from records order by sort_key offset page_offset limit page_limit)
 select (select count(*) from records),coalesce(jsonb_agg(page.record order by page.sort_key),'[]'::jsonb) into total,rows from page;
 return jsonb_build_object('total',total,'rows',rows,'next_offset',case when page_offset+jsonb_array_length(rows)<total then page_offset+jsonb_array_length(rows) else null end);
end;
$$;
revoke all on function public.read_pack_inventory(text,uuid,integer,integer) from public,anon;
grant execute on function public.read_pack_inventory(text,uuid,integer,integer) to authenticated;
