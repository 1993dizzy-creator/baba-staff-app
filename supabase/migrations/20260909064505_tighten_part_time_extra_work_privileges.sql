begin;

revoke all on table public.payroll_part_time_extra_work_decisions from public, anon, authenticated, service_role;
revoke all on sequence public.payroll_part_time_extra_work_decisions_id_seq from public, anon, authenticated, service_role;
grant select, insert, update on table public.payroll_part_time_extra_work_decisions to service_role;
grant usage, select on sequence public.payroll_part_time_extra_work_decisions_id_seq to service_role;

commit;
