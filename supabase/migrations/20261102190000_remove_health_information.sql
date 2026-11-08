-- Owner-requested removal. Do not copy old health values into any audit table.
create function private.without_health_fields(value jsonb) returns jsonb
language plpgsql immutable set search_path='' as $$
declare result jsonb; item record;
begin
 if jsonb_typeof(value)='object' then
  result:='{}'::jsonb;
  for item in select * from jsonb_each(value)loop
   if item.key !~* 'allerg|medic|health|diagnos|treatment|condition|special.?needs' then result:=result||jsonb_build_object(item.key,private.without_health_fields(item.value));end if;
  end loop;
  return result;
 elsif jsonb_typeof(value)='array'then
  return coalesce((select jsonb_agg(private.without_health_fields(v)order by n)from jsonb_array_elements(value)with ordinality a(v,n)),'[]'::jsonb);
 end if;
 return value;
end;$$;
revoke all on function private.without_health_fields(jsonb)from public,anon,authenticated;
grant execute on function private.without_health_fields(jsonb)to service_role;

-- These are the operational JSON stores that may retain imported field copies.
update public.scouts set source_values=private.without_health_fields(source_values);
update public.parent_scout_links set source_context=private.without_health_fields(source_context);
update public.pack_shirt_import_history set source_values=private.without_health_fields(source_values);
update public.pack_inventory_items set source_context=private.without_health_fields(source_context);
update public.pack_commands set command=private.without_health_fields(command),result=private.without_health_fields(result);
update public.pack_family_commands set command=private.without_health_fields(command),result=private.without_health_fields(result);
alter table public.scouts drop column allergy,drop column medication;

-- Re-imports must never restore health keys through raw source JSON.
alter table public.scouts add constraint no_health_source_fields check(source_values=private.without_health_fields(source_values));
alter table public.parent_scout_links add constraint no_health_parent_source_fields check(source_context=private.without_health_fields(source_context));
alter table public.pack_shirt_import_history add constraint no_health_shirt_source_fields check(source_values=private.without_health_fields(source_values));
alter table public.pack_inventory_items add constraint no_health_inventory_source_fields check(source_context=private.without_health_fields(source_context));
