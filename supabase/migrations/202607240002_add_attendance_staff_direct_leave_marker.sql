alter table public.attendance_records
  add column if not exists is_staff_direct_leave boolean not null default false;

comment on column public.attendance_records.is_staff_direct_leave is
  'True only for leave records created directly from the administrator attendance staff list.';

do $$
declare
  v_null_count bigint;
  v_non_false_legacy_count bigint;
begin
  select count(*)
    into v_null_count
  from public.attendance_records
  where is_staff_direct_leave is null;

  if v_null_count <> 0 then
    raise exception
      'postflight failed: attendance_records.is_staff_direct_leave contains % null rows',
      v_null_count;
  end if;

  -- ADD COLUMN ... DEFAULT false applies false to every row that existed before
  -- this migration. No legacy leave row is inferred as a direct staff-list leave.
  select count(*)
    into v_non_false_legacy_count
  from public.attendance_records
  where is_staff_direct_leave is distinct from false;

  if v_non_false_legacy_count <> 0 then
    raise exception
      'postflight failed: % legacy attendance rows were marked as direct staff leave',
      v_non_false_legacy_count;
  end if;
end
$$;
