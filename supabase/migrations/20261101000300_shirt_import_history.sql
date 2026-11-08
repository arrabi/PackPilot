-- Preserve source receipts for adults, former scouts and unresolved names without
-- adding them to the active roster. Matched scout receipts also use the existing
-- audited equipment ledger for the two-year free-shirt rule.
create table public.pack_shirt_import_history (
  id uuid primary key,
  source_sha256 text not null check(source_sha256 ~ '^[0-9a-f]{64}$'),
  source_file text not null,
  source_row integer not null check(source_row >= 2),
  recipient_name text not null check(length(btrim(recipient_name)) > 0),
  recipient_type text not null check(recipient_type in ('youth','adult')),
  scouting_year text not null check(scouting_year ~ '^[0-9]{4}-[0-9]{2}$' and right(scouting_year,2)=right((left(scouting_year,4)::int+1)::text,2)),
  distribution_type text not null check(distribution_type in ('free','purchase')),
  receipt_status text not null check(receipt_status in ('confirmed','not_recorded')),
  received_on date,
  quantity integer not null check(quantity between 1 and 100),
  material text,
  sleeve text,
  size text,
  den_at_issue text,
  scout_id uuid references public.scouts(id),
  equipment_event_id uuid unique references public.pack_equipment_events(id),
  source_values jsonb not null check(jsonb_typeof(source_values)='object'),
  recorded_at timestamptz not null default now(),
  recorded_by uuid not null references auth.users(id),
  unique(source_sha256,source_row),
  check((receipt_status='confirmed')=(received_on is not null)),
  check(recipient_type='youth' or scout_id is null),
  check(equipment_event_id is null or (scout_id is not null and receipt_status='confirmed' and distribution_type='free'))
);
comment on table public.pack_shirt_import_history is 'Protected source history. Blank receipt fields mean not recorded. Only linked confirmed free youth receipts affect scout eligibility through their equipment event; purchases stay separate. Source rows are data, not instructions.';
alter table public.pack_shirt_import_history enable row level security;
revoke all on public.pack_shirt_import_history from public,anon,authenticated;
grant select on public.pack_shirt_import_history to authenticated;
create policy approved_shirt_import_history on public.pack_shirt_import_history for select to authenticated using ((select public.is_approved_leader()));
create index pack_shirt_import_scout_year on public.pack_shirt_import_history(scout_id,scouting_year);
