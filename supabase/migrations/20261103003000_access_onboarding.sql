-- Account administration is separate from ordinary leader recording and parent self-service.
create function private.pack_access_token(child uuid)returns text language sql stable security definer set search_path='' as $$
 select md5(jsonb_build_object('contacts',(select jsonb_build_array(parent_1_name,parent_1_email,parent_2_name,parent_2_email)from public.scouts where id=child),'links',(select coalesce(jsonb_agg(jsonb_build_array(l.id,l.parent_email,l.active,l.claimed_user_id)order by l.id),'[]')from public.parent_scout_links l where l.scout_id=child))::text);
$$;
revoke all on function private.pack_access_token(uuid)from public,anon,authenticated;
create function public.manage_pack_access(request_id uuid,command jsonb)returns jsonb language plpgsql security definer set search_path='' as $$
#variable_conflict use_variable
declare prior private.pack_admin_commands;fingerprint text:=md5(request_id::text||command::text);email text:=lower(btrim(command->>'email'));canon text;old_email text;target uuid;slot integer;enabled boolean:=coalesce((command->>'enabled')::boolean,true);result jsonb;existing public.leader_access;
begin
 if not private.is_pack_admin()then raise exception 'Administrator access required'using errcode='42501';end if;
 if request_id is null or jsonb_typeof(command)is distinct from 'object'or length(command::text)>10000 or coalesce((command->>'verified')::boolean,false)is not true then raise exception 'Verify the person, email and intended access first';end if;
 if email is null or length(email)>254 or email!~'^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'then raise exception 'Provide a valid email address';end if;
 canon:=private.canonical_leader_email(email);
 perform pg_advisory_xact_lock(hashtextextended('admin:'||request_id::text,0));
 select * into prior from private.pack_admin_commands c where c.request_id=request_id;
 if found then if prior.recorded_by<>auth.uid()or prior.fingerprint<>fingerprint then raise exception 'Request ID conflict';end if;return prior.result;end if;
 if command->>'action'='leader_access'then
  perform pg_advisory_xact_lock(hashtextextended('manage-leader-access',0));
  select * into existing from public.leader_access l where private.canonical_leader_email(l.email)=canon order by(l.email=email)desc limit 1 for update;
  if command->>'role'not in('leader','admin')then raise exception 'Choose leader or administrator';end if;
  if existing.role='admin'and existing.active and(not enabled or command->>'role'<>'admin')and(select count(*)from public.leader_access where role='admin'and active)<=1 then raise exception 'Keep at least one active administrator';end if;
  if existing.email is not null then
   if command->>'expected_state'is distinct from md5(to_jsonb(existing)::text)then raise exception 'Access changed; refresh and review';end if;
   update public.leader_access set active=enabled,role=command->>'role',can_record=case when command->>'role'='admin'then true else coalesce((command->>'can_record')::boolean,false)end,default_den=nullif(command->>'den','')where leader_access.email=existing.email;
  else
   if nullif(command->>'expected_state','')is not null then raise exception 'Access changed; refresh';end if;
   insert into public.leader_access(email,role,active,can_record,default_den)values(email,command->>'role',enabled,case when command->>'role'='admin'then true else coalesce((command->>'can_record')::boolean,false)end,nullif(command->>'den',''));
  end if;
  result:=jsonb_build_object('saved',true,'invitation_url','https://legacy.packpilot.example/?welcome=leader');
 elsif command->>'action'='family_link'then
  target:=(command->>'scout_id')::uuid;slot:=(command->>'slot')::int;
  if slot not in(1,2)or target is null then raise exception 'Choose a scout and parent slot';end if;
  perform 1 from public.scouts where id=target for update;if not found then raise exception 'Scout unavailable';end if;
  if command->>'expected_state'is distinct from private.pack_access_token(target)then raise exception 'Family links changed; refresh and review';end if;
  select case slot when 1 then parent_1_email else parent_2_email end into old_email from public.scouts where id=target;
  if enabled then
   if old_email is not null and private.canonical_leader_email(old_email)<>canon and not exists(select 1 from public.scouts s where s.id=target and private.canonical_leader_email(case slot when 1 then s.parent_2_email else s.parent_1_email end)=private.canonical_leader_email(old_email))then update public.parent_scout_links set active=false where scout_id=target and email_canonical=private.canonical_leader_email(old_email);end if;
   insert into public.parent_scout_links(scout_id,parent_email,created_by,source_context)values(target,email,auth.uid(),'{"approval":"verified admin repair"}')on conflict(scout_id,email_canonical)do update set active=true,parent_email=excluded.parent_email;
   if slot=1 then update public.scouts set parent_1_email=email,parent_1_name=nullif(btrim(command->>'name'),'')where id=target;else update public.scouts set parent_2_email=email,parent_2_name=nullif(btrim(command->>'name'),'')where id=target;end if;
  else update public.parent_scout_links set active=false where scout_id=target and email_canonical=canon;if not found then raise exception 'No approved family link exists for that email';end if;end if;
  update private.pack_email_outbox q set status='cancelled'where q.status in('pending','sending')and q.audience='parent'and(q.scout_id=target or target=any(q.child_ids))and not private.parent_email_still_allowed(q);
  result:=jsonb_build_object('saved',true,'scout_id',target);
 else raise exception 'Unknown access action';end if;
 insert into private.pack_admin_commands values(request_id,command,result,fingerprint,auth.uid(),now());return result;
end;$$;
revoke all on function public.manage_pack_access(uuid,jsonb)from public,anon;
grant execute on function public.manage_pack_access(uuid,jsonb)to authenticated;
-- Include a CAS token without exposing authentication credentials.
create or replace function public.read_pack_access()returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if not private.is_pack_admin()then raise exception 'Administrator access required'using errcode='42501';end if;
 return jsonb_build_object('leaders',(select coalesce(jsonb_agg(to_jsonb(l)||jsonb_build_object('expected_state',md5(to_jsonb(l)::text),'has_account',exists(select 1 from auth.users u where private.canonical_leader_email(u.email)=private.canonical_leader_email(l.email)))order by l.email),'[]')from public.leader_access l),'scouts',(select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'name',s.scout_name,'den',s.den,'parent_1_name',s.parent_1_name,'parent_1_email',s.parent_1_email,'parent_2_name',s.parent_2_name,'parent_2_email',s.parent_2_email,'access_token',private.pack_access_token(s.id))order by s.scout_name),'[]')from public.scouts s),'links',(select coalesce(jsonb_agg(jsonb_build_object('id',l.id,'scout_id',l.scout_id,'email',l.parent_email,'active',l.active,'claimed',l.claimed_user_id is not null)),'[]')from public.parent_scout_links l));
end;$$;

revoke all on function public.read_pack_access()from public,anon;
grant execute on function public.read_pack_access()to authenticated;
