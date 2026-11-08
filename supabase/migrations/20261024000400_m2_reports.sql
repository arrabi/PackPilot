create function public.read_pack_report(report text,scouting_year text,scout_id uuid default null,activity_id uuid default null,den text default null,page_offset integer default 0,page_limit integer default 50) returns jsonb
language plpgsql stable security invoker set search_path='' set statement_timeout='5s' as $$
#variable_conflict use_variable
declare rows jsonb; total integer;
begin
 if not public.is_approved_leader() then raise exception 'Access denied' using errcode='42501'; end if;
 if report is null or report not in ('scout_summary','registration_gaps','activity_attendance','badges_pending','equipment_pending') or page_limit is null or page_limit not between 1 and 100 or page_offset is null or page_offset not between 0 and 10000 then raise exception 'Invalid report'; end if;
 if scouting_year is null or scouting_year !~ '^[0-9]{4}-[0-9]{2}$' or right(scouting_year,2)<>right((left(scouting_year,4)::int+1)::text,2) then raise exception 'Invalid scouting year'; end if;
 if report='activity_attendance' and (activity_id is null or not exists(select 1 from public.pack_activities a where a.id=activity_id and a.scouting_year=scouting_year)) then raise exception 'Activity in requested year required'; end if;
 if report<>'activity_attendance' and activity_id is not null then raise exception 'Activity filter requires attendance report'; end if;
 with summary as (
  select s.id scout_id,s.scout_name,s.den,
   coalesce(a.status,'unknown') active_registration, a.occurred_on active_verified_on,
   coalesce(o.status,'unknown') scouting_registration,o.occurred_on scouting_verified_on,
   coalesce(t.status,'not_recorded') attendance_status,t.occurred_on attendance_date,
   coalesce(e.revision,0) equipment_revision,
   public.pack_shirt_eligibility(s.id,scouting_year) free_shirt_eligibility,
   (select count(*) from public.pack_advancement v where v.scout_id=s.id and v.scouting_year=scouting_year and v.earned_on is not null) earned_adventures,
   (select count(*) from public.pack_advancement v where v.scout_id=s.id and v.scouting_year=scouting_year and v.earned_on is not null and v.badge_delivered_on is null) badges_to_deliver,
   (select count(*) from public.pack_requirement_progress p where p.scout_id=s.id and p.scouting_year=scouting_year) completed_requirements,
   (select coalesce(sum(l.outstanding_quantity),0) from public.pack_loan_balances l where l.scout_id=s.id and l.scouting_year=scouting_year) outstanding_loan_items,
   (select count(*) from public.pack_loss_balances l where l.scout_id=s.id and l.scouting_year=scouting_year and l.balance_minor>0) unpaid_loss_charges,
   (select count(*) from public.pack_purchase_balances p where p.scout_id=s.id and p.scouting_year=scouting_year and p.unfulfilled_quantity>0) unfulfilled_purchase_requests
  from public.scouts s
  left join public.pack_registrations a on a.scout_id=s.id and a.scouting_year=scouting_year and a.platform='active.com'
  left join public.pack_registrations o on o.scout_id=s.id and o.scouting_year=scouting_year and o.platform='scouting.org'
  left join public.pack_attendance t on t.scout_id=s.id and t.activity_id=activity_id
  left join public.pack_equipment_state e on e.scout_id=s.id
  where (scout_id is null or s.id=scout_id) and (den is null or lower(s.den)=lower(den))
 ), matches as (
  select * from summary where report in ('scout_summary','activity_attendance')
   or (report='registration_gaps' and (active_registration<>'confirmed' or scouting_registration<>'confirmed'))
   or (report='badges_pending' and badges_to_deliver>0)
   or (report='equipment_pending' and (outstanding_loan_items>0 or unpaid_loss_charges>0 or unfulfilled_purchase_requests>0))
 ), page as(select * from matches order by scout_id limit page_limit offset page_offset)
 select (select count(*) from matches),coalesce(jsonb_agg(to_jsonb(page)),'[]'::jsonb) into total,rows from page;
 return jsonb_build_object('report',report,'scouting_year',scouting_year,'total',total,'rows',rows,'next_offset',case when page_offset+jsonb_array_length(rows)<total then page_offset+jsonb_array_length(rows) else null end,
  'unknown_rule','Missing registration is unknown; missing attendance is not_recorded. Counts describe recorded events only; no historical import is assumed. Money is never summed across currencies.');
end;
$$;
revoke all on function public.read_pack_report(text,text,uuid,uuid,text,integer,integer) from public,anon;
grant execute on function public.read_pack_report(text,text,uuid,uuid,text,integer,integer) to authenticated;
