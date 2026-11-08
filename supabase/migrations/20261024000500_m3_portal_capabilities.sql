-- UI hints only. Existing RPCs remain the authority for every read/write.
create function public.get_pack_capabilities() returns jsonb
language sql stable security invoker set search_path='' as $$
 select jsonb_build_object('approved',public.is_approved_leader(),'can_record',private.can_record());
$$;
revoke all on function public.get_pack_capabilities() from public,anon;
grant execute on function public.get_pack_capabilities() to authenticated;
