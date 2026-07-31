begin;

do $$
begin
  raise notice 'PAYROLL_V6_PREFLIGHT runs=%, employees=%, items=%, reviews=%, contracts=%, schedules=%, insurance_versions=%',
    (select count(*) from public.payroll_runs),
    (select count(*) from public.payroll_run_employees),
    (select count(*) from public.payroll_run_items),
    (select count(*) from public.payroll_run_reviews),
    (select count(*) from public.payroll_contract_versions),
    (select count(*) from public.employee_work_schedule_versions),
    (select count(*) from public.payroll_insurance_setting_versions);
  if exists(select 1 from public.payroll_run_items where item_type='automatic' and category='late_deduction' group by payroll_run_employee_id,business_date having count(*)>1) then
    raise exception 'PAYROLL_LATE_ITEM_DUPLICATES_FOUND';
  end if;
  if exists(select 1 from public.payroll_run_items where category='unauthorized_absence_deduction' group by payroll_run_employee_id,business_date having count(*)>1) then
    raise exception 'PAYROLL_ABSENCE_ITEM_DUPLICATES_FOUND';
  end if;
end $$;

alter table public.payroll_settings
  add column late_major_threshold_minutes integer not null default 20,
  add column late_minor_penalty_minutes integer not null default 60,
  add column late_major_penalty_rate_bp integer not null default 5000,
  add column unauthorized_absence_penalty_days integer not null default 3,
  add constraint payroll_settings_late_major_threshold_check check (late_major_threshold_minutes between 1 and 1440),
  add constraint payroll_settings_late_minor_penalty_check check (late_minor_penalty_minutes between 1 and 1440),
  add constraint payroll_settings_late_major_rate_check check (late_major_penalty_rate_bp between 0 and 10000),
  add constraint payroll_settings_unauthorized_absence_days_check check (unauthorized_absence_penalty_days between 1 and 31);

alter table public.payroll_runs
  add column penalty_settings_snapshot jsonb not null default '{}'::jsonb;

alter table public.payroll_run_items drop constraint payroll_run_items_category_check;
alter table public.payroll_run_items add constraint payroll_run_items_category_check check (
  category in ('base_work','paid_leave','overtime','late_deduction','early_leave_deduction','unauthorized_absence_deduction','insurance_employee_deduction','incentive','meal','transport','housing','insurance_tax','advance','penalty','other_addition','other_deduction')
);
alter table public.payroll_run_items drop constraint payroll_run_item_category_direction_check;
alter table public.payroll_run_items add constraint payroll_run_item_category_direction_check check (
  (category in ('base_work','paid_leave','overtime','incentive','meal','transport','housing','other_addition') and direction='addition') or
  (category in ('late_deduction','early_leave_deduction','unauthorized_absence_deduction','insurance_employee_deduction','insurance_tax','advance','penalty','other_deduction') and direction='deduction')
);

create unique index payroll_run_item_automatic_late_unique
  on public.payroll_run_items(payroll_run_employee_id,business_date)
  where item_type='automatic' and category='late_deduction';
create unique index payroll_run_item_unauthorized_absence_unique
  on public.payroll_run_items(payroll_run_employee_id,business_date)
  where category='unauthorized_absence_deduction';

create function public.payroll_refresh_totals_v4(p_run_id bigint) returns void
language plpgsql security definer set search_path=public as $$
begin
  perform public.payroll_refresh_totals_v3(p_run_id);
end $$;

create function public.payroll_insert_payload_v4(p_run_id bigint,p_employees jsonb,p_actor_user_id bigint,p_copy_manual_from_run_id bigint default null) returns void
language plpgsql security definer set search_path=public as $$
begin
  perform public.payroll_insert_payload_v3(p_run_id,p_employees,p_actor_user_id,p_copy_manual_from_run_id);
end $$;

create function public.payroll_create_run_v4(p_month date,p_calculated_at timestamptz,p_engine_version text,p_source_snapshot jsonb,p_employees jsonb,p_actor_user_id bigint) returns bigint
language plpgsql security definer set search_path=public as $$
declare v_run_id bigint;v_revision bigint;v_payment_day integer;v_payment_offset integer;v_payment_due_date date;v_schedule_snapshot jsonb;v_insurance_snapshot jsonb;v_penalty_snapshot jsonb;
begin
  perform public.payroll_assert_actor_v2(p_actor_user_id);
  if p_engine_version<>'monthly-payroll-v6' then raise exception 'PAYROLL_ENGINE_VERSION_MISMATCH' using errcode='22023';end if;
  if p_month<date '2026-07-01' or p_month<>date_trunc('month',p_month)::date then raise exception 'PAYROLL_MONTH_NOT_SUPPORTED' using errcode='22023';end if;
  select payment_day,payment_month_offset into v_payment_day,v_payment_offset from public.payroll_settings where id=1;
  if not found then raise exception 'PAYROLL_SETTINGS_NOT_FOUND';end if;
  v_payment_due_date:=(date_trunc('month',p_month)+(v_payment_offset||' month')::interval+(v_payment_day-1||' day')::interval)::date;
  v_schedule_snapshot:=jsonb_build_object('paymentDay',v_payment_day,'paymentMonthOffset',v_payment_offset);
  v_insurance_snapshot:=coalesce(p_source_snapshot->'insuranceSettings','{}'::jsonb);
  v_penalty_snapshot:=coalesce(p_source_snapshot->'penaltySettings','{}'::jsonb);
  if not (v_penalty_snapshot ?& array['lateMajorThresholdMinutes','lateMinorPenaltyMinutes','lateMajorPenaltyRateBp','unauthorizedAbsencePenaltyDays','capturedAt']) then raise exception 'PAYROLL_PENALTY_SNAPSHOT_INVALID' using errcode='22023';end if;
  perform pg_advisory_xact_lock(82117,(extract(year from p_month)::integer*100+extract(month from p_month)::integer));
  if exists(select 1 from public.payroll_runs where payroll_month=p_month and status in('draft','finalized','paid')) then raise exception 'PAYROLL_ACTIVE_RUN_EXISTS' using errcode='23505';end if;
  select coalesce(max(revision),0)+1 into v_revision from public.payroll_runs where payroll_month=p_month;
  insert into public.payroll_runs(payroll_month,revision,status,calculated_at,engine_version,source_snapshot,created_by,payment_due_date,payment_schedule_snapshot,insurance_settings_snapshot,penalty_settings_snapshot)
  values(p_month,v_revision,'draft',p_calculated_at,p_engine_version,p_source_snapshot||jsonb_build_object('paymentSchedule',v_schedule_snapshot),p_actor_user_id,v_payment_due_date,v_schedule_snapshot,v_insurance_snapshot,v_penalty_snapshot) returning id into v_run_id;
  perform public.payroll_insert_payload_v4(v_run_id,p_employees,p_actor_user_id,null);
  insert into public.payroll_run_audit_logs(payroll_run_id,action,actor_user_id,after_snapshot) select id,'run_created',p_actor_user_id,to_jsonb(r) from public.payroll_runs r where id=v_run_id;
  return v_run_id;
end $$;

create function public.payroll_recalculate_run_v4(p_run_id bigint,p_calculated_at timestamptz,p_engine_version text,p_source_snapshot jsonb,p_employees jsonb,p_actor_user_id bigint) returns bigint
language plpgsql security definer set search_path=public as $$
declare v_old public.payroll_runs%rowtype;v_new_id bigint;v_revision bigint;v_insurance_snapshot jsonb;v_penalty_snapshot jsonb;
begin
  perform public.payroll_assert_actor_v2(p_actor_user_id);
  if p_engine_version<>'monthly-payroll-v6' then raise exception 'PAYROLL_ENGINE_VERSION_MISMATCH' using errcode='22023';end if;
  select * into v_old from public.payroll_runs where id=p_run_id for update;
  if not found then raise exception 'PAYROLL_RUN_NOT_FOUND';end if;
  if v_old.status<>'draft' then raise exception 'PAYROLL_RUN_LOCKED' using errcode='55000';end if;
  perform pg_advisory_xact_lock(82117,(extract(year from v_old.payroll_month)::integer*100+extract(month from v_old.payroll_month)::integer));
  select coalesce(max(revision),0)+1 into v_revision from public.payroll_runs where payroll_month=v_old.payroll_month;
  v_insurance_snapshot:=coalesce(p_source_snapshot->'insuranceSettings','{}'::jsonb);
  v_penalty_snapshot:=coalesce(p_source_snapshot->'penaltySettings','{}'::jsonb);
  if not (v_penalty_snapshot ?& array['lateMajorThresholdMinutes','lateMinorPenaltyMinutes','lateMajorPenaltyRateBp','unauthorizedAbsencePenaltyDays','capturedAt']) then raise exception 'PAYROLL_PENALTY_SNAPSHOT_INVALID' using errcode='22023';end if;
  insert into public.payroll_runs(payroll_month,revision,status,calculated_at,engine_version,source_snapshot,created_by,payment_due_date,payment_schedule_snapshot,insurance_settings_snapshot,penalty_settings_snapshot)
  values(v_old.payroll_month,v_revision,'cancelled',p_calculated_at,p_engine_version,p_source_snapshot||jsonb_build_object('paymentSchedule',v_old.payment_schedule_snapshot),p_actor_user_id,v_old.payment_due_date,v_old.payment_schedule_snapshot,v_insurance_snapshot,v_penalty_snapshot) returning id into v_new_id;
  perform public.payroll_insert_payload_v4(v_new_id,p_employees,p_actor_user_id,v_old.id);
  insert into public.payroll_run_audit_logs(payroll_run_id,action,actor_user_id,before_snapshot,after_snapshot) values(v_old.id,'run_recalculated',p_actor_user_id,to_jsonb(v_old),jsonb_build_object('replacementRunId',v_new_id,'replacementRevision',v_revision));
  update public.payroll_runs set status='cancelled',cancelled_by=p_actor_user_id,cancelled_at=now(),cancel_reason='Recalculated',updated_at=now() where id=v_old.id;
  update public.payroll_runs set status='draft',updated_at=now() where id=v_new_id;
  insert into public.payroll_run_audit_logs(payroll_run_id,action,actor_user_id,after_snapshot) select id,'run_created',p_actor_user_id,to_jsonb(r) from public.payroll_runs r where id=v_new_id;
  return v_new_id;
end $$;

create function public.payroll_mutate_item_v4(p_run_id bigint,p_run_employee_id bigint,p_item_id bigint,p_operation text,p_category text,p_direction text,p_amount bigint,p_description text,p_reason text,p_actor_user_id bigint) returns bigint
language plpgsql security definer set search_path=public as $$
declare v_item_id bigint;
begin
  v_item_id:=public.payroll_mutate_item_v3(p_run_id,p_run_employee_id,p_item_id,p_operation,p_category,p_direction,p_amount,p_description,p_reason,p_actor_user_id);
  perform public.payroll_refresh_totals_v4(p_run_id);
  return v_item_id;
end $$;

create function public.payroll_resolve_review_v4(p_run_id bigint,p_run_employee_id bigint,p_review_id bigint,p_action text,p_custom_minutes integer,p_reason text,p_actor_user_id bigint) returns void
language plpgsql security definer set search_path=public as $$
declare v_run public.payroll_runs%rowtype;v_review public.payroll_run_reviews%rowtype;v_before jsonb;v_day_rate numeric;v_penalty_days integer;v_amount bigint;v_resolution jsonb;
begin
  perform public.payroll_assert_actor_v2(p_actor_user_id);
  select r.* into v_run from public.payroll_runs r join public.payroll_run_employees e on e.payroll_run_id=r.id where r.id=p_run_id and e.id=p_run_employee_id for update of r;
  if not found then raise exception 'PAYROLL_EMPLOYEE_RUN_MISMATCH';end if;
  if v_run.status<>'draft' then raise exception 'PAYROLL_RUN_LOCKED' using errcode='55000';end if;
  select * into v_review from public.payroll_run_reviews where id=p_review_id and payroll_run_employee_id=p_run_employee_id for update;
  if not found then raise exception 'PAYROLL_REVIEW_NOT_FOUND';end if;
  if v_review.status<>'open' then raise exception 'PAYROLL_REVIEW_ALREADY_RESOLVED';end if;
  if v_review.warning_code<>'MISSING_CHECK_IN' or p_action not in('confirm_unauthorized_absence','exclude_absence_penalty') then
    perform public.payroll_resolve_review_v3(p_run_id,p_run_employee_id,p_review_id,p_action,p_custom_minutes,p_reason,p_actor_user_id);
    return;
  end if;
  if v_run.engine_version<>'monthly-payroll-v6' then raise exception 'PAYROLL_INVALID_REVIEW_ACTION' using errcode='22023';end if;
  if nullif(btrim(p_reason),'') is null then raise exception 'PAYROLL_REASON_REQUIRED' using errcode='22023';end if;
  if coalesce((v_review.source_snapshot->>'approvedLeave')::boolean,false) then raise exception 'PAYROLL_APPROVED_LEAVE_CONFLICT' using errcode='22023';end if;
  v_before:=to_jsonb(v_review);v_day_rate:=coalesce((v_review.source_snapshot->>'dayRate')::numeric,0);v_penalty_days:=coalesce((v_run.penalty_settings_snapshot->>'unauthorizedAbsencePenaltyDays')::integer,0);
  if p_action='confirm_unauthorized_absence' then
    if v_day_rate<=0 or v_penalty_days<1 then raise exception 'PAYROLL_ABSENCE_RATE_UNAVAILABLE' using errcode='22023';end if;
    if exists(select 1 from public.payroll_run_items where payroll_run_employee_id=p_run_employee_id and business_date=v_review.business_date and category='unauthorized_absence_deduction') then raise exception 'PAYROLL_ABSENCE_ITEM_ALREADY_EXISTS' using errcode='23505';end if;
    v_amount:=round(v_day_rate*v_penalty_days)::bigint;
    v_resolution:=jsonb_build_object('reviewId',p_review_id,'businessDate',v_review.business_date,'dayRate',v_day_rate,'penaltyDays',v_penalty_days,'calculatedAmount',v_amount,'reason',btrim(p_reason),'actorUserId',p_actor_user_id,'confirmedAt',now(),'engineVersion',v_run.engine_version);
    insert into public.payroll_run_items(payroll_run_employee_id,payroll_run_review_id,item_type,category,direction,amount,original_amount,business_date,source_snapshot,description,reason,created_by)
    values(p_run_employee_id,p_review_id,'review_adjustment','unauthorized_absence_deduction','deduction',v_amount,v_amount,v_review.business_date,v_resolution,'Unauthorized absence penalty',btrim(p_reason),p_actor_user_id);
  else v_amount:=0;v_resolution:=jsonb_build_object('reviewId',p_review_id,'businessDate',v_review.business_date,'reason',btrim(p_reason),'actorUserId',p_actor_user_id,'resolvedAt',now(),'engineVersion',v_run.engine_version);end if;
  update public.payroll_run_reviews set status='resolved',resolution_action=p_action,resolution_snapshot=v_resolution,amount_delta=-v_amount,reason=btrim(p_reason),resolved_by=p_actor_user_id,resolved_at=now() where id=p_review_id;
  perform public.payroll_refresh_totals_v4(p_run_id);
  insert into public.payroll_run_audit_logs(payroll_run_id,payroll_run_employee_id,action,actor_user_id,reason,before_snapshot,after_snapshot) values(p_run_id,p_run_employee_id,'review_resolved',p_actor_user_id,btrim(p_reason),v_before,to_jsonb((select rv from public.payroll_run_reviews rv where id=p_review_id)));
end $$;

create function public.payroll_transition_run_v4(p_run_id bigint,p_action text,p_reason text,p_payment_date date,p_payment_method text,p_payment_note text,p_actor_user_id bigint) returns void
language plpgsql security definer set search_path=public as $$
declare v_run public.payroll_runs%rowtype;v_settings public.payroll_settings%rowtype;
begin
  perform public.payroll_assert_actor_v2(p_actor_user_id);
  select * into v_run from public.payroll_runs where id=p_run_id for update;
  if not found then raise exception 'PAYROLL_RUN_NOT_FOUND';end if;
  if p_action in('finalize','force_finalize') and v_run.engine_version='monthly-payroll-v6' then
    select * into v_settings from public.payroll_settings where id=1;
    if not found
      or not (v_run.penalty_settings_snapshot ? 'lateMajorThresholdMinutes')
      or (v_run.penalty_settings_snapshot->>'lateMajorThresholdMinutes')::integer is distinct from v_settings.late_major_threshold_minutes
      or (v_run.penalty_settings_snapshot->>'lateMinorPenaltyMinutes')::integer is distinct from v_settings.late_minor_penalty_minutes
      or (v_run.penalty_settings_snapshot->>'lateMajorPenaltyRateBp')::integer is distinct from v_settings.late_major_penalty_rate_bp
      or (v_run.penalty_settings_snapshot->>'unauthorizedAbsencePenaltyDays')::integer is distinct from v_settings.unauthorized_absence_penalty_days
    then raise exception 'PAYROLL_PENALTY_SNAPSHOT_STALE' using errcode='55000';end if;
  end if;
  perform public.payroll_transition_run_v3(p_run_id,p_action,p_reason,p_payment_date,p_payment_method,p_payment_note,p_actor_user_id);
end $$;

revoke all on function public.payroll_refresh_totals_v4(bigint),public.payroll_insert_payload_v4(bigint,jsonb,bigint,bigint),public.payroll_create_run_v4(date,timestamptz,text,jsonb,jsonb,bigint),public.payroll_recalculate_run_v4(bigint,timestamptz,text,jsonb,jsonb,bigint),public.payroll_mutate_item_v4(bigint,bigint,bigint,text,text,text,bigint,text,text,bigint),public.payroll_resolve_review_v4(bigint,bigint,bigint,text,integer,text,bigint),public.payroll_transition_run_v4(bigint,text,text,date,text,text,bigint) from public,anon,authenticated;
grant execute on function public.payroll_create_run_v4(date,timestamptz,text,jsonb,jsonb,bigint),public.payroll_recalculate_run_v4(bigint,timestamptz,text,jsonb,jsonb,bigint),public.payroll_mutate_item_v4(bigint,bigint,bigint,text,text,text,bigint,text,text,bigint),public.payroll_resolve_review_v4(bigint,bigint,bigint,text,integer,text,bigint),public.payroll_transition_run_v4(bigint,text,text,date,text,text,bigint) to service_role;

comment on column public.payroll_settings.late_major_threshold_minutes is 'Late minutes at or above this value use the major penalty tier.';
comment on column public.payroll_settings.late_minor_penalty_minutes is 'Minutes of pay deducted for a minor late arrival.';
comment on column public.payroll_settings.late_major_penalty_rate_bp is 'Basis-point share of one day rate deducted for a major late arrival.';
comment on column public.payroll_settings.unauthorized_absence_penalty_days is 'Day-rate multiplier applied after an administrator confirms unauthorized absence.';
comment on column public.payroll_runs.penalty_settings_snapshot is 'Immutable attendance penalty settings captured for monthly-payroll-v6.';

commit;
