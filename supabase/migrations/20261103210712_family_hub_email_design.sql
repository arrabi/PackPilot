-- Scoped portraits for parent email; never persist image bytes in the outbox.
alter table private.pack_email_outbox add column media_token uuid not null default gen_random_uuid();
create unique index pack_email_media_token on private.pack_email_outbox(media_token);

alter function public.parent_email_context(uuid) rename to parent_email_context_before_hub;
alter function public.parent_email_context_before_hub(uuid) set schema private;
revoke all on function private.parent_email_context_before_hub(uuid) from public,anon,authenticated,service_role;

create function public.parent_email_context(email_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;q private.pack_email_outbox;kind text;selected_adventure uuid;spotlight jsonb;portraits jsonb;
begin
 -- Existing helper enforces current recipient eligibility and preserves exact deep links.
 result:=private.parent_email_context_before_hub(email_id);
 select * into strict q from private.pack_email_outbox where id=email_id;
 if q.audience<>'parent' then return result;end if;
 kind:=split_part(q.dedupe_key,':',1);
 if kind in ('earned','badge') then selected_adventure:=split_part(q.dedupe_key,':',3)::uuid;
 elsif kind='homework' then
  select h.adventure_id into selected_adventure from public.pack_home_assignments h where h.id=split_part(q.dedupe_key,':',2)::uuid and h.scout_id=q.scout_id;
 end if;
 if selected_adventure is not null then
  select jsonb_build_object('scout_name',s.scout_name,'adventure_id',a.id,'adventure',a.name,'rank',a.rank,'earned_on',v.earned_on,'badge_delivered_on',v.badge_delivered_on) into spotlight
  from public.scouts s cross join public.pack_adventures a
  left join public.pack_advancement v on v.scout_id=s.id and v.adventure_id=a.id and v.scouting_year=case when kind in('earned','badge') then split_part(q.dedupe_key,':',4) else (select h.scouting_year from public.pack_home_assignments h where h.id=split_part(q.dedupe_key,':',2)::uuid) end
  where s.id=q.scout_id and a.id=selected_adventure;
 end if;
 -- Stable ordinality means removal of one portrait cannot display a sibling's photo under the wrong name.
 select coalesce(jsonb_agg(jsonb_build_object('name',s.scout_name,'index',c.ordinality-1)order by c.ordinality),'[]') into portraits
 from unnest(coalesce(q.child_ids,array[q.scout_id]))with ordinality c(child,ordinality)
 join public.scouts s on s.id=c.child join public.pack_family_photos p on p.scout_id=c.child and p.kind='scout'
 where exists(select 1 from public.parent_scout_links l where l.scout_id=c.child and l.active and lower(btrim(l.parent_email))=q.recipient)
 and coalesce(s.den,'')!~* '^\s*\(withdraw\)';
 return result||jsonb_build_object('spotlight',spotlight,'portraits',portraits,'media_token',case when jsonb_array_length(portraits)>0 then q.media_token else null end);
end;$$;
revoke all on function public.parent_email_context(uuid) from public,anon,authenticated;
grant execute on function public.parent_email_context(uuid) to service_role;

create function public.read_parent_email_portrait(token uuid,portrait_index integer default 0) returns text
language plpgsql security definer set search_path='' as $$
declare q private.pack_email_outbox;child uuid;image text;
begin
 if portrait_index<0 or portrait_index>30 then return null;end if;
 select * into q from private.pack_email_outbox where media_token=token;
 if not found or q.audience<>'parent' or q.status not in('sending','sent') or not private.parent_email_still_allowed(q) then return null;end if;
 if q.status='sent' and (q.sent_at is null or q.sent_at<now()-interval '30 days') then return null;end if;
 if q.status='sending' and (q.claimed_at is null or q.claimed_at<now()-interval '1 hour')then return null;end if;
 child:=(coalesce(q.child_ids,array[q.scout_id]))[portrait_index+1];
 if child is null or not exists(select 1 from public.parent_scout_links l join public.scouts s on s.id=l.scout_id where l.scout_id=child and l.active and lower(btrim(l.parent_email))=q.recipient and coalesce(s.den,'')!~* '^\s*\(withdraw\)')then return null;end if;
 select p.image into image from public.pack_family_photos p where p.scout_id=child and p.kind='scout';
 return image;
end;$$;
revoke all on function public.read_parent_email_portrait(uuid,integer) from public,anon,authenticated;
grant execute on function public.read_parent_email_portrait(uuid,integer) to service_role;
