-- All destructive work is an explicit, confirmed administrator operation.
alter table public.roster_snapshots drop constraint roster_snapshots_expected_rows_check;
alter table public.roster_snapshots add constraint roster_snapshots_expected_rows_check check(expected_rows between 0 and 10000);
create table private.pack_year_ends(scouting_year text primary key,ends_on date not null);
insert into private.pack_year_ends values('2025-26','2026-06-30'),('2026-27','2027-06-30');
create table private.pack_retention (
 scout_id uuid primary key references public.scouts(id),final_registered_year text not null,year_end date not null,
 deletion_due date,transferred boolean not null default false,parent_copy boolean not null default false,
 basis text not null default 'Administrator review required',recorded_at timestamptz not null default now(),recorded_by uuid,
 check(deletion_due is null or deletion_due between year_end+30 and year_end+360)
);
insert into private.pack_retention(scout_id,final_registered_year,year_end,basis)
 select id,'2026-27','2027-06-30','Imported 2026–27 roster; confirm final registered year'from public.scouts;
create table private.pack_deletion_requests(
 id uuid primary key,scout_id uuid references public.scouts(id)on delete set null,requester_email text not null,
 received_on date not null,scope text not null check(scope in('extras','all','parent_access')),verified boolean not null default false,
 status text not null default 'open'check(status in('open','app_removed','completed','cancelled')),
 due_on date generated always as(received_on+30)stored,
 provider_cleanup boolean not null default false,backup_cleanup boolean not null default false,source_cleanup boolean not null default false,
 identity_cleanup boolean not null default false,notes text not null default '' check(length(notes)<=2000),
 recorded_at timestamptz not null default now(),recorded_by uuid not null,completed_at timestamptz
);
create table private.pack_admin_commands(request_id uuid primary key,command jsonb not null,result jsonb not null,fingerprint text not null,recorded_by uuid not null,recorded_at timestamptz not null default now());
create table private.pack_export_runs(
 id uuid primary key,requested_by uuid not null,scout_ids uuid[]not null,kind text not null check(kind in('family','scoutbook')),
 created_at timestamptz not null default now(),expires_at timestamptz not null default now()+interval '10 minutes',
 status text not null default 'generated'check(status in('generated','download_started','failed')),record_count integer not null default 0
);
create table private.pack_scoutbook_mappings(
 adventure_id uuid primary key references public.pack_adventures(id),advancement_type text not null check(advancement_type in('adventure','rank','award','meritbadge')),
 official_id text not null check(official_id~'^[0-9]+$'),version text not null default '',verified_source text not null check(length(verified_source)between 5 and 1000),
 recorded_by uuid not null,recorded_at timestamptz not null default now()
);
create table private.pack_scoutbook_names(
 scout_id uuid primary key references public.scouts(id),first_name text not null,middle_name text not null default '',last_name text not null,
 recorded_by uuid not null,recorded_at timestamptz not null default now()
);
create table private.pack_portal_visits(user_id uuid not null,visit_date date not null,first_visit timestamptz not null default now(),last_visit timestamptz not null default now(),primary key(user_id,visit_date));
do $$declare t text;begin foreach t in array array['pack_year_ends','pack_retention','pack_deletion_requests','pack_admin_commands','pack_export_runs','pack_scoutbook_mappings','pack_scoutbook_names','pack_portal_visits']loop
 execute format('alter table private.%I enable row level security',t);execute format('revoke all on private.%I from public,anon,authenticated',t);
end loop;end;$$;

create function private.roll_forward_retention()returns trigger language plpgsql security definer set search_path='' as $$
declare ending date;
begin
 if new.status<>'confirmed'then return new;end if;
 select ends_on into ending from private.pack_year_ends where scouting_year=new.scouting_year;
 ending:=coalesce(ending,make_date(left(new.scouting_year,4)::int+1,6,30));
 insert into private.pack_retention(scout_id,final_registered_year,year_end,basis,recorded_by)values(new.scout_id,new.scouting_year,ending,'Confirmed registration',auth.uid())
 on conflict(scout_id)do update set final_registered_year=excluded.final_registered_year,year_end=excluded.year_end,deletion_due=null,basis=excluded.basis,recorded_at=now(),recorded_by=auth.uid()
 where excluded.final_registered_year>pack_retention.final_registered_year;
 return new;
end;$$;
revoke all on function private.roll_forward_retention()from public,anon,authenticated;
create trigger registration_retention after insert or update on public.pack_registrations for each row execute function private.roll_forward_retention();
create or replace function private.can_read_pack_change(entry private.pack_change_log)returns boolean
language sql stable security definer set search_path='' as $$
 select case when entry.table_name='pack_leader_notes'then private.is_approved_leader()and(entry.owner_id=auth.uid()or private.is_pack_admin())
 when entry.table_name in('leader_access','pack_retention','pack_deletion_requests','pack_admin_commands','pack_year_ends','pack_scoutbook_mappings','pack_scoutbook_names','pack_export_runs','pack_portal_visits')then private.is_pack_admin()
 else private.is_approved_leader()or(entry.scout_id is not null and private.parent_can_read_scout(entry.scout_id)and entry.table_name not in('pack_meeting_plans','pack_leader_notes'))end;
$$;
do $$declare t text;begin foreach t in array array['pack_year_ends','pack_retention','pack_deletion_requests','pack_scoutbook_mappings','pack_scoutbook_names']loop
 execute format('create trigger pack_audit after insert or update or delete on private.%I for each row execute function private.capture_pack_change()',t);
end loop;end;$$;

create function public.record_parent_portal_visit()returns void
language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from public.scouts s where private.parent_can_read_scout(s.id))then raise exception 'Parent access required'using errcode='42501';end if;
 insert into private.pack_portal_visits(user_id,visit_date)values(auth.uid(),(now()at time zone 'America/Los_Angeles')::date)
 on conflict(user_id,visit_date)do update set last_visit=now();
end;$$;
revoke all on function public.record_parent_portal_visit()from public,anon;
grant execute on function public.record_parent_portal_visit()to authenticated;

create function public.read_pack_admin()returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 if not private.is_pack_admin()then raise exception 'Pack administrator access required'using errcode='42501';end if;
 return jsonb_build_object(
 'scouts',(select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'name',s.scout_name,'den',s.den,'bsa_member_id',s.bsa_member_id,'parent_1_email',s.parent_1_email,'parent_2_email',s.parent_2_email)order by s.scout_name),'[]')from public.scouts s),
 'retention',(select coalesce(jsonb_agg(to_jsonb(r)||jsonb_build_object('effective_due',coalesce(r.deletion_due,r.year_end+360))),'[]')from private.pack_retention r),
 'requests',(select coalesce(jsonb_agg(to_jsonb(r)order by r.due_on),'[]')from private.pack_deletion_requests r),
 'years',(select coalesce(jsonb_agg(to_jsonb(y)order by scouting_year),'[]')from private.pack_year_ends y),
 'exports',(select coalesce(jsonb_agg(to_jsonb(x)order by created_at desc),'[]')from(select * from private.pack_export_runs order by created_at desc limit 100)x),
 'mappings',(select coalesce(jsonb_agg(to_jsonb(m)),'[]')from private.pack_scoutbook_mappings m),
 'scoutbook_names',(select coalesce(jsonb_agg(to_jsonb(n)),'[]')from private.pack_scoutbook_names n),
 'adventures',(select coalesce(jsonb_agg(jsonb_build_object('id',a.id,'name',a.name,'rank',a.rank,'program_version',a.program_version)order by rank,name),'[]')from public.pack_adventures a),
 'preferences',public.read_pack_email_preferences(),
 'links',(select coalesce(jsonb_agg(jsonb_build_object('scout_id',l.scout_id,'email',lower(btrim(l.parent_email)),'active',l.active,'claimed',l.claimed_user_id is not null,'user_id',l.claimed_user_id)),'[]')from public.parent_scout_links l),
 'visits',(select coalesce(jsonb_agg(jsonb_build_object('user_id',v.user_id,'month',to_char(v.visit_date,'YYYY-MM'),'first_visit',v.first_visit,'last_visit',v.last_visit)),'[]')from private.pack_portal_visits v),
 'tracking_started',(select min(created_at)from private.pack_export_runs));
end;$$;
revoke all on function public.read_pack_admin()from public,anon;
grant execute on function public.read_pack_admin()to authenticated;

create function public.record_pack_admin(request_id uuid,command jsonb)returns jsonb
language plpgsql security definer set search_path='' set statement_timeout='30s' as $$
#variable_conflict use_variable
declare action text:=command->>'action'; child uuid:=nullif(command->>'scout_id','')::uuid;target uuid:=nullif(command->>'id','')::uuid;
 prior private.pack_admin_commands;result jsonb:='{}';ending date; scout public.scouts; req private.pack_deletion_requests;mailbox text;mailboxes text[];ids uuid[];actor uuid:=auth.uid(); fingerprint text:=md5(request_id::text||command::text);
begin
 if not private.is_pack_admin()then raise exception 'Pack administrator access required'using errcode='42501';end if;
 if request_id is null or jsonb_typeof(command)is distinct from 'object'or length(command::text)>30000 then raise exception 'Invalid command';end if;
 perform pg_advisory_xact_lock(hashtextextended('admin:'||request_id::text,0));
 select * into prior from private.pack_admin_commands c where c.request_id=request_id;
 if found then if prior.recorded_by<>actor or prior.fingerprint<>fingerprint then raise exception 'Request ID conflict';end if;return prior.result;end if;
 if child is not null then select * into scout from public.scouts where id=child for update;if not found then raise exception 'Scout not found';end if;end if;
 if action='retention'then
  ending:=(command->>'year_end')::date;
  if child is null or ending is null or command->>'scouting_year'!~'^[0-9]{4}-[0-9]{2}$'then raise exception 'Choose a scout, year and year end';end if;
  if exists(select 1 from public.pack_registrations r where r.scout_id=child and r.status='confirmed'and r.scouting_year>command->>'scouting_year')then raise exception 'A later registered year exists';end if;
  insert into private.pack_retention(scout_id,final_registered_year,year_end,deletion_due,transferred,parent_copy,basis,recorded_by)
  values(child,command->>'scouting_year',ending,nullif(command->>'deletion_due','')::date,coalesce((command->>'transferred')::boolean,false),coalesce((command->>'parent_copy')::boolean,false),'Administrator verified',actor)
  on conflict(scout_id)do update set final_registered_year=excluded.final_registered_year,year_end=excluded.year_end,deletion_due=excluded.deletion_due,transferred=excluded.transferred,parent_copy=excluded.parent_copy,basis=excluded.basis,recorded_by=actor,recorded_at=now();
 elsif action='year_end'then
  if command->>'scouting_year'!~'^[0-9]{4}-[0-9]{2}$'or nullif(command->>'ends_on','')is null then raise exception 'Choose a valid year and end date';end if;
  insert into private.pack_year_ends values(command->>'scouting_year',(command->>'ends_on')::date)on conflict(scouting_year)do update set ends_on=excluded.ends_on;
  update private.pack_retention set year_end=(command->>'ends_on')::date,deletion_due=null,recorded_by=actor,recorded_at=now()where final_registered_year=command->>'scouting_year';
 elsif action='deletion_request'then
  if child is null or target is null or nullif(command->>'received_on','')is null or(command->>'received_on')::date>(now()at time zone 'America/Los_Angeles')::date then raise exception 'Provide the scout and original receipt date';end if;
  mailbox:=lower(btrim(command->>'requester_email'));
  if mailbox is null or mailbox!~'^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'then raise exception 'Provide the requesting parent email';end if;
  insert into private.pack_deletion_requests(id,scout_id,requester_email,received_on,scope,verified,notes,recorded_by)
  values(target,child,mailbox,(command->>'received_on')::date,command->>'scope',coalesce((command->>'verified')::boolean,false),coalesce(command->>'notes',''),actor);
 elsif action='update_request'then
  select * into req from private.pack_deletion_requests where id=target for update;if not found then raise exception 'Request not found';end if;
  if command->>'status'='app_removed'and req.status not in('app_removed','completed')then raise exception 'Perform the confirmed removal action first';end if;
  if command->>'status'='completed'and(not coalesce((command->>'verified')::boolean,req.verified)or not coalesce((command->>'provider_cleanup')::boolean,false)or not coalesce((command->>'backup_cleanup')::boolean,false)or not coalesce((command->>'source_cleanup')::boolean,false)or not coalesce((command->>'identity_cleanup')::boolean,false)or req.status not in('app_removed','completed'))then raise exception 'Complete application removal and confirm remaining cleanup first';end if;
  if command->>'status'='completed'then
   perform set_config('pack.privacy_erasure','on',true);
   delete from private.pack_change_log where table_name='pack_deletion_requests'and record_id=target::text;
   delete from private.pack_admin_commands where command->>'id'=target::text;
  end if;
  update private.pack_deletion_requests set verified=coalesce((command->>'verified')::boolean,verified),status=coalesce(command->>'status',status),provider_cleanup=coalesce((command->>'provider_cleanup')::boolean,provider_cleanup),backup_cleanup=coalesce((command->>'backup_cleanup')::boolean,backup_cleanup),source_cleanup=coalesce((command->>'source_cleanup')::boolean,source_cleanup),identity_cleanup=coalesce((command->>'identity_cleanup')::boolean,identity_cleanup),notes=case when command->>'status'='completed'then ''else coalesce(command->>'notes',notes)end,requester_email=case when command->>'status'='completed'then 'removed'else requester_email end,completed_at=case when command->>'status'='completed'then now()else completed_at end where id=target;
  if command->>'status'='completed'then perform set_config('pack.privacy_erasure','off',true);command:=jsonb_build_object('action',action,'receipt_id',request_id);end if;
 elsif action='mapping'then
  insert into private.pack_scoutbook_mappings(adventure_id,advancement_type,official_id,version,verified_source,recorded_by)
  values((command->>'adventure_id')::uuid,command->>'advancement_type',command->>'official_id',coalesce(command->>'version',''),command->>'verified_source',actor)
  on conflict(adventure_id)do update set advancement_type=excluded.advancement_type,official_id=excluded.official_id,version=excluded.version,verified_source=excluded.verified_source,recorded_by=actor,recorded_at=now();
 elsif action='scoutbook_identity'then
  if child is null or nullif(btrim(command->>'first_name'),'')is null or nullif(btrim(command->>'last_name'),'')is null or command->>'bsa_member_id'!~'^[0-9]{4,20}$'then raise exception 'Provide the official name and member ID';end if;
  update public.scouts set bsa_member_id=command->>'bsa_member_id'where id=child;
  insert into private.pack_scoutbook_names values(child,btrim(command->>'first_name'),btrim(coalesce(command->>'middle_name','')),btrim(command->>'last_name'),actor,now())on conflict(scout_id)do update set first_name=excluded.first_name,middle_name=excluded.middle_name,last_name=excluded.last_name,recorded_by=actor,recorded_at=now();
 elsif action in('delete_extras','delete_scout','exclude_parent')then
  if child is null or command->>'confirm_name'is distinct from scout.scout_name then raise exception 'Confirm the exact scout name';end if;
  if target is not null then
   select * into req from private.pack_deletion_requests where id=target for update;
   if not found or req.scout_id is distinct from child or not req.verified then raise exception 'Verify the request and scout scope first';end if;
   if req.scope is distinct from (case action when 'delete_scout'then 'all'when 'delete_extras'then 'extras'else 'parent_access'end) or(action='exclude_parent'and lower(btrim(command->>'email'))is distinct from req.requester_email)then raise exception 'Removal action must match the verified request scope';end if;
  end if;
  -- Do not preserve the removed personal data in a deletion audit snapshot.
  perform set_config('pack.privacy_erasure','on',true);
  delete from public.pack_family_photos where scout_id=child and(action<>'exclude_parent'or kind='family');
  delete from private.pack_export_runs where child=any(scout_ids);
  if action='delete_scout'then
   select array_agg(lower(btrim(parent_email)))into mailboxes from public.parent_scout_links where scout_id=child;
   delete from private.pack_email_outbox where scout_id=child or child=any(child_ids);
   delete from public.pack_family_message_reads where message_id in(select id from public.pack_family_messages where scout_id=child);
   delete from public.pack_family_messages where scout_id=child;
   delete from public.pack_home_assignments where scout_id=child;
   delete from public.pack_event_bookings where scout_id=child;
   delete from public.pack_volunteers where scout_id=child;
   delete from public.pack_requirement_progress where scout_id=child;
   delete from public.pack_advancement where scout_id=child;
   delete from public.pack_attendance where scout_id=child;
   delete from public.pack_registrations where scout_id=child;
   update public.pack_shirt_import_history set equipment_event_id=null where scout_id=child;
   delete from public.pack_shirt_import_history where scout_id=child;
   update public.pack_equipment_events set target_id=null where scout_id=child;
   delete from public.pack_equipment_events where scout_id=child;
   delete from public.pack_equipment_state where scout_id=child;
   -- Ledger/inventory references and imported command/result copies can also identify a scout.
   delete from public.pack_inventory_events where coalesce(to_jsonb(pack_inventory_events)->>'scout_id','')=child::text;
   delete from public.pack_family_commands where command::text like '%'||child::text||'%'or result::text like '%'||child::text||'%';
   delete from public.pack_commands where command::text like '%'||child::text||'%'or result::text like '%'||child::text||'%';
   delete from public.pack_community_commands where command::text like '%'||child::text||'%';
   delete from private.pack_admin_commands where command::text like '%'||child::text||'%'or result::text like '%'||child::text||'%';
   delete from private.pack_change_log where scout_id=child or changes::text like '%'||child::text||'%'or record_key::text like '%'||child::text||'%';
   delete from private.pack_scoutbook_names where scout_id=child;
   delete from private.pack_retention where scout_id=child;
   select array_agg(claimed_user_id)into ids from public.parent_scout_links where scout_id=child;
   delete from public.parent_scout_links where scout_id=child;
   delete from private.pack_portal_visits where user_id=any(ids)and not exists(select 1 from public.parent_scout_links l where l.claimed_user_id=pack_portal_visits.user_id);
   delete from public.scouts where id=child;
   update public.roster_snapshots r set expected_rows=(select count(*)from public.scouts s where s.snapshot_id=r.id);
  elsif action='exclude_parent'then
   mailbox:=lower(btrim(command->>'email'));mailboxes:=array[mailbox];
   if not exists(select 1 from public.parent_scout_links where scout_id=child and lower(btrim(parent_email))=mailbox)then raise exception 'Choose a linked parent address';end if;
   select array_agg(claimed_user_id)into ids from public.parent_scout_links where scout_id=child and lower(btrim(parent_email))=mailbox;
   delete from public.pack_family_message_reads where message_id in(select id from public.pack_family_messages where scout_id=child and recorded_by=any(ids));
   delete from public.pack_family_messages where scout_id=child and recorded_by=any(ids);
   delete from public.pack_family_commands where recorded_by=any(ids)and command::text like '%'||child::text||'%';
   delete from private.pack_email_outbox where recipient=mailbox and(scout_id=child or child=any(child_ids));
   delete from public.parent_scout_links where scout_id=child and lower(btrim(parent_email))=mailbox;
   delete from private.pack_portal_visits where user_id=any(ids)and not exists(select 1 from public.parent_scout_links l where l.claimed_user_id=pack_portal_visits.user_id);
   delete from public.pack_family_message_reads where user_id=any(ids)and message_id in(select id from public.pack_family_messages where scout_id=child);
   delete from public.pack_commands where command::text like '%'||child::text||'%'and command::text ilike '%'||mailbox||'%';
   update public.scouts set parent_1_name=case when lower(btrim(parent_1_email))=mailbox then null else parent_1_name end,parent_1_phone=case when lower(btrim(parent_1_email))=mailbox then null else parent_1_phone end,parent_1_email=case when lower(btrim(parent_1_email))=mailbox then null else parent_1_email end,parent_2_name=case when lower(btrim(parent_2_email))=mailbox then null else parent_2_name end,parent_2_phone=case when lower(btrim(parent_2_email))=mailbox then null else parent_2_phone end,parent_2_email=case when lower(btrim(parent_2_email))=mailbox then null else parent_2_email end,source_values='{}'where id=child;
   delete from private.pack_change_log where scout_id=child;
  end if;
  foreach mailbox in array coalesce(mailboxes,array[]::text[])loop
   if not exists(select 1 from public.parent_scout_links where lower(btrim(parent_email))=mailbox)then
    delete from private.pack_email_preferences where email=mailbox;
    delete from private.pack_email_preference_changes where email=mailbox;
    delete from private.pack_change_log where table_name='pack_email_preferences'and record_id=mailbox;
   end if;
  end loop;
  update private.pack_deletion_requests set status='app_removed'where id=target;
  perform set_config('pack.privacy_erasure','off',true);
  result:=jsonb_build_object('application_removed',true,'remaining_cleanup','Review provider logs/backups, source exports and account identity before completing the request');
  -- A non-identifying completion record remains; deleted name/email are excluded.
  insert into private.pack_change_log(table_name,record_id,record_key,actor_id,actor_name,actor_kind,action,changes)
  values('privacy_removal',request_id::text,'{}',actor,'Administrator','administrator',action,jsonb_build_object('application_removed',true));
  command:=jsonb_build_object('action',action,'receipt_id',request_id);
 else raise exception 'Unknown admin action';end if;
 insert into private.pack_admin_commands values(request_id,command,result,fingerprint,actor,now());
 return result;
end;$$;
revoke all on function public.record_pack_admin(uuid,jsonb)from public,anon;
grant execute on function public.record_pack_admin(uuid,jsonb)to authenticated;

alter table private.pack_email_outbox add column audience text not null default 'parent'check(audience in('parent','admin'));
create function private.queue_pack_admin_email(key text,title text,content text)returns void
language sql security definer set search_path='' as $$
 insert into private.pack_email_outbox(dedupe_key,recipient,subject,body,audience)
 values(key,'contact@example.test',title,content||E'\n\nOpen the Admin page: https://legacy.packpilot.example/admin','admin')on conflict(dedupe_key)do nothing;
$$;
revoke all on function private.queue_pack_admin_email(text,text,text)from public,anon,authenticated;
create function public.prepare_pack_export(request_id uuid,children uuid[]default null,export_kind text default 'family')returns jsonb
language plpgsql security definer set search_path='' set statement_timeout='30s' as $$
#variable_conflict use_variable
declare ids uuid[];prior private.pack_export_runs;result jsonb;
begin
 if request_id is null or export_kind not in('family','scoutbook')then raise exception 'Invalid export request';end if;
 if export_kind='scoutbook'and not private.is_pack_admin()then raise exception 'Administrator access required'using errcode='42501';end if;
 if not private.is_pack_admin()and not exists(select 1 from public.scouts s where private.parent_can_read_scout(s.id))then raise exception 'Family access required'using errcode='42501';end if;
 select array_agg(distinct s.id order by s.id)into ids from public.scouts s where(children is null or s.id=any(children))and(private.is_pack_admin()or private.parent_can_read_scout(s.id));
 if ids is null or cardinality(ids)=0 or(children is not null and exists(select 1 from unnest(children)c where not c=any(ids)))then raise exception 'Export scope denied'using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended('export:'||request_id::text,0));
 select * into prior from private.pack_export_runs where id=request_id;
 if found then
  if prior.requested_by<>auth.uid()or prior.scout_ids<>ids or prior.kind<>export_kind then raise exception 'Request ID conflict';end if;
  if prior.expires_at<now()then raise exception 'Export expired; request a fresh copy';end if;
 else
  insert into private.pack_export_runs(id,requested_by,scout_ids,kind,record_count)values(request_id,auth.uid(),ids,export_kind,cardinality(ids));
  if not private.is_pack_admin()then
   perform private.queue_pack_admin_email('parent-export:'||request_id,'PackPilot: parent data export generated','A parent generated a private export.'||E'\nRequesting account: '||(select u.email from auth.users u where u.id=auth.uid())||E'\nScouts: '||(select string_agg(s.scout_name,', 'order by s.scout_name)from public.scouts s where s.id=any(ids))||E'\nGenerated: '||now()||E'\nExport reference: '||request_id||E'\nThe export contents are not attached. Sign in to review the export log.');
  end if;
 end if;
 result:=jsonb_build_object('run_id',request_id,'generated_at',now(),'expires_at',(select expires_at from private.pack_export_runs where id=request_id),
 'scouts',(select jsonb_agg(case when private.is_pack_admin()then to_jsonb(s)else jsonb_build_object('id',s.id,'scout_name',s.scout_name,'den',s.den,'birth_date',s.birth_date,'grade',s.grade,'bsa_member_id',s.bsa_member_id)end order by s.scout_name)from public.scouts s where s.id=any(ids)),
 'advancement',(select coalesce(jsonb_agg(to_jsonb(v)),'[]')from public.pack_advancement v where v.scout_id=any(ids)),
 'progress',(select coalesce(jsonb_agg(to_jsonb(p)),'[]')from public.pack_requirement_progress p where p.scout_id=any(ids)),
 'adventures',(select coalesce(jsonb_agg(to_jsonb(a)),'[]')from public.pack_adventures a where exists(select 1 from public.pack_advancement v where v.scout_id=any(ids)and v.adventure_id=a.id)or exists(select 1 from public.pack_home_assignments h where h.scout_id=any(ids)and h.adventure_id=a.id)),
 'registrations',(select coalesce(jsonb_agg(to_jsonb(r)),'[]')from public.pack_registrations r where r.scout_id=any(ids)),
 'attendance',(select coalesce(jsonb_agg(to_jsonb(a)||jsonb_build_object('activity_title',ac.title,'activity_kind',ac.kind)),'[]')from public.pack_attendance a join public.pack_activities ac on ac.id=a.activity_id where a.scout_id=any(ids)),
 'homework',(select coalesce(jsonb_agg(to_jsonb(h)),'[]')from public.pack_home_assignments h where h.scout_id=any(ids)),
 'messages',(select coalesce(jsonb_agg(to_jsonb(m)),'[]')from public.pack_family_messages m where m.scout_id=any(ids)),
 'photos',(select coalesce(jsonb_agg(to_jsonb(p)),'[]')from public.pack_family_photos p where p.scout_id=any(ids)),
 'bookings',(select coalesce(jsonb_agg(to_jsonb(b)||jsonb_build_object('event_title',e.title,'event_date',e.event_date)),'[]')from public.pack_event_bookings b join public.pack_events e on e.id=b.event_id where b.scout_id=any(ids)),
 'equipment',(select coalesce(jsonb_agg(to_jsonb(e)),'[]')from public.pack_equipment_state e where e.scout_id=any(ids)),
 'equipment_events',(select coalesce(jsonb_agg(to_jsonb(e)),'[]')from public.pack_equipment_events e where e.scout_id=any(ids)),
 'volunteering',(select coalesce(jsonb_agg(to_jsonb(v)||jsonb_build_object('role_title',j.title,'details',j.details,'signup_date',j.signup_date,'event_id',j.event_id)),'[]')from public.pack_volunteers v join public.pack_volunteer_jobs j on j.id=v.job_id where v.scout_id=any(ids)),
 'mappings',case when export_kind='scoutbook'then(select coalesce(jsonb_agg(to_jsonb(m)),'[]')from private.pack_scoutbook_mappings m)else '[]'::jsonb end,
 'official_names',case when export_kind='scoutbook'then(select coalesce(jsonb_agg(to_jsonb(n)),'[]')from private.pack_scoutbook_names n where n.scout_id=any(ids))else '[]'::jsonb end);
 return result;
end;$$;
create function public.record_pack_export_download(request_id uuid,failed boolean default false)returns void
language plpgsql security definer set search_path='' as $$
begin
 update private.pack_export_runs set status=case when failed then 'failed'else 'download_started'end where id=request_id and requested_by=auth.uid()and expires_at>now()
 and not exists(select 1 from unnest(scout_ids)child where not private.is_pack_admin()and not private.parent_can_read_scout(child));
 if not found then raise exception 'Export unavailable'using errcode='42501';end if;
end;$$;
revoke all on function public.prepare_pack_export(uuid,uuid[],text),public.record_pack_export_download(uuid,boolean)from public,anon;
grant execute on function public.prepare_pack_export(uuid,uuid[],text),public.record_pack_export_download(uuid,boolean)to authenticated;

create function public.prepare_admin_followups()returns integer
language plpgsql security definer set search_path='' as $$
declare requests integer;retention integer;d date:=(now()at time zone 'America/Los_Angeles')::date;
begin
 if(now()at time zone 'America/Los_Angeles')::time<time '08:00'then return 0;end if;
 select count(*)into requests from private.pack_deletion_requests where status in('open','app_removed')and due_on<=d+30;
 select count(*)into retention from private.pack_retention where coalesce(deletion_due,year_end+360)<=d+30;
 if requests+retention=0 then return 0;end if;
 perform private.queue_pack_admin_email('admin-deadlines:'||d,'PackPilot: data removal deadlines need attention',requests||' parent deletion request(s) and '||retention||' retention deadline(s) are due within 30 days or overdue. Please review and complete the required admin actions. Nothing is deleted automatically.');return requests+retention;
end;$$;
revoke all on function public.prepare_admin_followups()from public,anon,authenticated;
grant execute on function public.prepare_admin_followups()to service_role;
