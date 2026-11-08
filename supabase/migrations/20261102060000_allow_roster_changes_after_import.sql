-- Import reconciliation belongs to the import transaction. The live roster can
-- grow or shrink afterwards without changing the original import metadata.
create or replace function public.read_roster_snapshot() returns jsonb
language plpgsql stable security invoker set search_path = ''
set statement_timeout = '5s'
as $$
declare
  result jsonb;
begin
  if not public.is_approved_leader() then
    raise exception 'Roster access denied' using errcode = '42501';
  end if;
  if not exists (select 1 from public.roster_snapshots) then
    raise exception 'Roster has not been imported' using errcode = 'P0001';
  end if;
  select coalesce(jsonb_agg(to_jsonb(s) order by s.source_row), '[]'::jsonb)
    into result from (select * from public.scouts order by source_row limit 10001) s;
  if jsonb_array_length(result) > 10000 then
    raise exception 'Roster size exceeds supported limit' using errcode = 'P0001';
  end if;
  return result;
end;
$$;
