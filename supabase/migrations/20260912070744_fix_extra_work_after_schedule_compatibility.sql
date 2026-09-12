begin;

-- Preserve historical before+after decision rows without rewriting audit data.
-- The application computes and matches payable candidates using after only;
-- this compatibility constraint is not a payroll eligibility calculation.
alter table public.payroll_part_time_extra_work_decisions
  drop constraint payroll_part_time_extra_work_minutes_check;

alter table public.payroll_part_time_extra_work_decisions
  add constraint payroll_part_time_extra_work_minutes_check check (
    candidate_minutes = after_schedule_minutes
    or candidate_minutes = before_schedule_minutes + after_schedule_minutes
  );

commit;
