begin;

alter table public.attendance_record_manual_overrides
  add column decision_threshold_at timestamptz null,
  add column decision_grace_minutes integer null;

alter table public.attendance_record_manual_overrides
  drop constraint attendance_record_manual_overrides_action_check;
alter table public.attendance_record_manual_overrides
  add constraint attendance_record_manual_overrides_action_check
  check (override_action in ('normalize', 'use_raw', 'use_effective'));
-- The existing active (attendance_record_id, override_metric) unique index is unchanged.

-- Date-scoped source facts, shared by review reads and the atomic decision RPC.
create function public.attendance_early_leave_context_v1(p_record public.attendance_records)
returns jsonb language plpgsql stable security invoker
set search_path = pg_catalog, public as $$
declare
  v_setting public.store_setting_versions%rowtype;
  v_end time;
  v_close time;
  v_cutoff time := '03:00';
  v_end_at timestamptz;
  v_close_at timestamptz;
  v_threshold timestamptz;
  v_grace integer := 0;
  v_raw integer := 0;
  v_selection text;
begin
  select * into v_setting from public.store_setting_versions
    where state = 'active' and effective_from_business_date <= p_record.work_date
    order by effective_from_business_date desc, id desc limit 1;
  if found then
    v_cutoff := v_setting.business_day_cutoff_time;
    select coalesce(early_leave_grace_minutes, 0) into v_grace
      from public.store_attendance_policies where setting_version_id = v_setting.id;
    v_grace := coalesce(v_grace, 0);
    select case when is_closed then null else close_time end into v_close
      from public.store_business_hours where setting_version_id = v_setting.id
        and weekday = extract(dow from p_record.work_date)::integer;
  else
    v_close := '01:00';
  end if;
  select actual_close_time into v_end from public.store_business_day_overrides
    where business_date = p_record.work_date and state = 'active';
  v_close := coalesce(v_end, v_close);
  select end_time into v_end from public.employee_work_schedule_versions
    where user_id = p_record.user_id and effective_from <= p_record.work_date
      and (effective_to is null or effective_to > p_record.work_date)
    order by effective_from desc, id desc limit 1;
  if not found then select work_end_time into v_end from public.users where id = p_record.user_id; end if;
  if v_end is not null then
    v_end_at := (p_record.work_date + case when v_end < v_cutoff then 1 else 0 end + v_end) at time zone 'Asia/Ho_Chi_Minh';
  end if;
  if v_close is not null then
    v_close_at := (p_record.work_date + case when v_close < v_cutoff then 1 else 0 end + v_close) at time zone 'Asia/Ho_Chi_Minh';
  end if;
  v_threshold := least(v_end_at, v_close_at);
  if p_record.check_out_at is not null and v_threshold is not null then
    v_raw := greatest(0, floor(extract(epoch from (v_threshold - p_record.check_out_at))/60)::integer);
  end if;
  select override_action into v_selection from public.attendance_record_manual_overrides
    where attendance_record_id = p_record.id and override_metric = 'early_leave'
      and override_action in ('use_raw', 'use_effective') and revoked_at is null
      and decision_threshold_at = v_threshold and decision_grace_minutes = v_grace;
  return jsonb_build_object('id', p_record.id, 'user_id', p_record.user_id, 'work_date', p_record.work_date,
    'rawEarlyLeaveMinutes', v_raw, 'earlyLeaveGraceMinutes', v_grace,
    'effectiveEarlyLeaveMinutes', greatest(0, v_raw-v_grace),
    'normalCheckoutThresholdAt', v_threshold, 'earlyLeaveSelection', v_selection,
    'earlyLeaveReviewRequired', p_record.work_date >= date '2026-09-01'
      and p_record.check_in_at is not null and p_record.check_out_at is not null
      and p_record.status not in ('leave', 'unauthorized_absence') and v_raw > v_grace and v_selection is null);
end $$;

create function public.attendance_early_leave_contexts_v1(p_start date, p_end date, p_user_id bigint default null)
returns jsonb language sql stable security invoker set search_path = pg_catalog, public as $$
  select coalesce(jsonb_agg(public.attendance_early_leave_context_v1(r) order by r.work_date, r.id), '[]'::jsonb)
  from public.attendance_records r
  where r.work_date >= greatest(p_start, date '2026-09-01') and r.work_date <= p_end
    and r.check_in_at is not null and r.check_out_at is not null
    and r.status not in ('leave', 'unauthorized_absence')
    and (p_user_id is null or r.user_id = p_user_id);
$$;

create function public.attendance_admin_resolve_early_leave_v1(
  p_attendance_record_id bigint, p_actor_user_id bigint, p_selection text,
  p_expected_updated_at timestamptz, p_expected_check_in_at timestamptz,
  p_expected_check_out_at timestamptz, p_expected_threshold_at timestamptz,
  p_expected_grace_minutes integer
) returns jsonb language plpgsql security invoker set search_path = pg_catalog, public as $$
declare
  v_record public.attendance_records%rowtype;
  v_after public.attendance_records%rowtype;
  v_context jsonb;
  v_minutes integer;
  v_role text;
begin
  select lower(role) into v_role from public.users where id = p_actor_user_id and is_active = true;
  if coalesce(v_role, '') not in ('owner','master') then return jsonb_build_object('status','forbidden'); end if;
  if p_selection is null or p_selection not in ('use_raw','use_effective') then return jsonb_build_object('status','invalid_selection'); end if;
  select * into v_record from public.attendance_records where id = p_attendance_record_id;
  if not found then return jsonb_build_object('status','record_changed'); end if;
  -- Same lock order as payroll_pay_employee_v1, before locking the record.
  perform pg_advisory_xact_lock(82118, extract(year from v_record.work_date)::integer*100+extract(month from v_record.work_date)::integer);
  perform pg_advisory_xact_lock(82119, v_record.user_id::integer);
  select * into v_record from public.attendance_records where id = p_attendance_record_id for update;
  if not found or v_record.updated_at is distinct from p_expected_updated_at
    or v_record.check_in_at is distinct from p_expected_check_in_at
    or v_record.check_out_at is distinct from p_expected_check_out_at then
    return jsonb_build_object('status','record_changed');
  end if;
  if exists(select 1 from public.payroll_employee_payments e join public.payroll_payment_batches b on b.id=e.payroll_batch_id
    where e.user_id=v_record.user_id and b.payroll_month=date_trunc('month',v_record.work_date)::date and e.payment_status='paid') then
    return jsonb_build_object('status','payroll_paid_locked');
  end if;
  v_context := public.attendance_early_leave_context_v1(v_record);
  if (v_context->>'normalCheckoutThresholdAt')::timestamptz is distinct from p_expected_threshold_at
    or (v_context->>'earlyLeaveGraceMinutes')::integer is distinct from p_expected_grace_minutes then
    return jsonb_build_object('status','policy_changed');
  end if;
  if not (v_context->>'earlyLeaveReviewRequired')::boolean then return jsonb_build_object('status','review_not_required'); end if;
  v_minutes := (v_context->>case when p_selection='use_raw' then 'rawEarlyLeaveMinutes' else 'effectiveEarlyLeaveMinutes' end)::integer;
  -- A stale decision still occupies the active unique index until re-confirmation.
  -- Revoke and replace it atomically with the attendance update and audit entry.
  update public.attendance_record_manual_overrides set revoked_at=now(),
    revoked_by=p_actor_user_id, revoke_reason='policy_source_changed'
    where attendance_record_id=v_record.id and override_metric='early_leave' and revoked_at is null
      and override_action in ('use_raw','use_effective')
      and (decision_threshold_at is distinct from (v_context->>'normalCheckoutThresholdAt')::timestamptz
        or decision_grace_minutes is distinct from (v_context->>'earlyLeaveGraceMinutes')::integer);
  insert into public.attendance_record_manual_overrides(attendance_record_id,override_metric,override_action,actor_user_id,
    decision_threshold_at,decision_grace_minutes)
    values(v_record.id,'early_leave',p_selection,p_actor_user_id,
      (v_context->>'normalCheckoutThresholdAt')::timestamptz,(v_context->>'earlyLeaveGraceMinutes')::integer);
  update public.attendance_records set early_leave_minutes=v_minutes,
    status=case when v_minutes>0 then 'early_leave' when coalesce(late_minutes,0)>0 then 'late' else 'done' end,
    updated_at=now() where id=v_record.id returning * into v_after;
  insert into public.attendance_record_audit_logs(attendance_record_id,source_attendance_record_id,target_user_id,work_date,action,actor_user_id,before_snapshot,after_snapshot,reason)
    values(v_record.id,v_record.id,v_record.user_id,v_record.work_date,'normalize_early_leave',p_actor_user_id,
      to_jsonb(v_record),to_jsonb(v_after)||jsonb_build_object('earlyLeaveSelection',p_selection,'earlyLeaveContext',v_context),p_selection);
  return jsonb_build_object('status','ok','record',to_jsonb(v_after));
end $$;

-- Covers every checkout edit/cancellation path, including the existing cancellation RPC.
create function public.attendance_revoke_early_leave_decision_v1()
returns trigger language plpgsql security invoker set search_path = pg_catalog, public as $$
begin
  if (old.work_date >= date '2026-09-01' or new.work_date >= date '2026-09-01')
    and (old.check_out_at is distinct from new.check_out_at or old.check_in_at is distinct from new.check_in_at
      or old.work_date is distinct from new.work_date or old.user_id is distinct from new.user_id) then
    update public.attendance_record_manual_overrides set revoked_at=now(),
      revoke_reason='attendance_source_changed'
      where attendance_record_id=old.id and override_metric='early_leave' and revoked_at is null;
  end if;
  return new;
end $$;
create trigger attendance_records_revoke_early_leave_decision
  after update on public.attendance_records for each row execute function public.attendance_revoke_early_leave_decision_v1();

-- Paid attendance is immutable even through legacy update/cancellation paths.
create function public.attendance_lock_paid_early_leave_source_v1()
returns trigger language plpgsql security invoker set search_path = pg_catalog, public as $$
declare v_record public.attendance_records%rowtype;
begin
  if tg_op='INSERT' then v_record:=new; else v_record:=old; end if;
  if v_record.work_date >= date '2026-09-01' then
    perform pg_advisory_xact_lock(82118, extract(year from v_record.work_date)::integer*100+extract(month from v_record.work_date)::integer);
    perform pg_advisory_xact_lock(82119, v_record.user_id::integer);
    if exists(select 1 from public.payroll_employee_payments e join public.payroll_payment_batches b on b.id=e.payroll_batch_id
      where e.user_id=v_record.user_id and b.payroll_month=date_trunc('month',v_record.work_date)::date and e.payment_status='paid') then
      raise exception 'PAYROLL_ATTENDANCE_LOCKED_FOR_PAID_EMPLOYEE' using errcode='55000';
    end if;
  end if;
  if tg_op='UPDATE' and (new.work_date is distinct from old.work_date or new.user_id is distinct from old.user_id) then
    perform pg_advisory_xact_lock(82118, extract(year from new.work_date)::integer*100+extract(month from new.work_date)::integer);
    perform pg_advisory_xact_lock(82119, new.user_id::integer);
    if exists(select 1 from public.payroll_employee_payments e join public.payroll_payment_batches b on b.id=e.payroll_batch_id
      where e.user_id=new.user_id and b.payroll_month=date_trunc('month',new.work_date)::date and e.payment_status='paid') then
      raise exception 'PAYROLL_ATTENDANCE_LOCKED_FOR_PAID_EMPLOYEE' using errcode='55000';
    end if;
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
create trigger attendance_records_paid_early_leave_source_lock
  before insert or update or delete on public.attendance_records
  for each row execute function public.attendance_lock_paid_early_leave_source_v1();

revoke all on function public.attendance_early_leave_context_v1(public.attendance_records) from public,anon,authenticated;
revoke all on function public.attendance_early_leave_contexts_v1(date,date,bigint) from public,anon,authenticated;
revoke all on function public.attendance_admin_resolve_early_leave_v1(bigint,bigint,text,timestamptz,timestamptz,timestamptz,timestamptz,integer) from public,anon,authenticated;
revoke all on function public.attendance_revoke_early_leave_decision_v1() from public,anon,authenticated;
revoke all on function public.attendance_lock_paid_early_leave_source_v1() from public,anon,authenticated;
grant execute on function public.attendance_early_leave_context_v1(public.attendance_records) to service_role;
grant execute on function public.attendance_early_leave_contexts_v1(date,date,bigint) to service_role;
grant execute on function public.attendance_admin_resolve_early_leave_v1(bigint,bigint,text,timestamptz,timestamptz,timestamptz,timestamptz,integer) to service_role;

-- Reject a stale payment even if an attendance source changed after application preflight.
create function public.payroll_block_pending_early_leave_v1()
returns trigger language plpgsql security invoker set search_path = pg_catalog, public as $$
declare v_month date;
begin
  if new.payment_status='paid' then
    select payroll_month into v_month from public.payroll_payment_batches where id=new.payroll_batch_id;
    if exists(select 1 from jsonb_array_elements(public.attendance_early_leave_contexts_v1(v_month,(v_month+interval '1 month'-interval '1 day')::date,new.user_id)) c
      where (c->>'earlyLeaveReviewRequired')::boolean) then
      raise exception 'EARLY_LEAVE_REVIEW_REQUIRED' using errcode='55000';
    end if;
  end if;
  return new;
end $$;
create trigger payroll_employee_payments_early_leave_review_lock
  before insert or update of payment_status on public.payroll_employee_payments
  for each row execute function public.payroll_block_pending_early_leave_v1();
revoke all on function public.payroll_block_pending_early_leave_v1() from public,anon,authenticated;

commit;
