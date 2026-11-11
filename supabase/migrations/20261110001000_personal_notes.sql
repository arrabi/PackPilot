-- One personal notebook per leader, alongside all existing den notes.
alter table public.pack_leader_notes drop constraint pack_leader_notes_den_check;
alter table public.pack_leader_notes add constraint pack_leader_notes_den_check
 check(den in('','0-Lions','1-Tigers','2-Wolves','3-Bears','4-Webelos','5-AOL'));

-- "Only you can see them" applies equally to administrators, history and attribution.
create or replace function public.read_leader_notes()returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 if not private.is_approved_leader()then raise exception 'Leader access required'using errcode='42501';end if;
 return(select coalesce(jsonb_agg(to_jsonb(n)order by n.den,n.recorded_at),'[]')
 from public.pack_leader_notes n where n.owner_id=auth.uid());
end;$$;
revoke all on function public.read_leader_notes()from public,anon;
grant execute on function public.read_leader_notes()to authenticated;

create or replace function private.can_read_pack_change(entry private.pack_change_log)returns boolean
language sql stable security definer set search_path='' as $$
 select case when entry.table_name='pack_leader_notes'then private.is_approved_leader()and entry.owner_id=auth.uid()
 when entry.table_name in('leader_access','pack_retention','pack_deletion_requests','pack_admin_commands','pack_year_ends','pack_scoutbook_mappings','pack_scoutbook_names','pack_export_runs','pack_portal_visits')then private.is_pack_admin()
 else private.is_approved_leader()or(entry.scout_id is not null and private.parent_can_read_scout(entry.scout_id)and entry.table_name not in('pack_meeting_plans','pack_leader_notes'))end;
$$;
revoke all on function private.can_read_pack_change(private.pack_change_log)from public,anon,authenticated;
