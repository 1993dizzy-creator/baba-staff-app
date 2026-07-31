-- Read-only preflight. Run before 202608010001_add_payroll_work_policy_penalties_v6.sql.
select
  count(*) as total_runs,
  count(*) filter (where status = 'draft') as draft_runs,
  count(*) filter (
    where engine_version = 'monthly-payroll-v5'
      and status = 'draft'
  ) as v5_draft_runs
from public.payroll_runs;

select
  (select count(*) from public.payroll_runs) as payroll_run_rows,
  (select count(*) from public.payroll_run_employees) as payroll_run_employee_rows,
  (select count(*) from public.payroll_run_items) as payroll_run_item_rows,
  (select count(*) from public.payroll_run_reviews) as payroll_run_review_rows,
  (select count(*) from public.payroll_contract_versions) as payroll_contract_version_rows,
  (select count(*) from public.employee_work_schedule_versions) as work_schedule_version_rows,
  (select count(*) from public.payroll_insurance_setting_versions) as insurance_setting_version_rows;

select payroll_run_employee_id, business_date, count(*) as duplicate_count
from public.payroll_run_items
where item_type = 'automatic' and category = 'late_deduction'
group by payroll_run_employee_id, business_date
having count(*) > 1;

select payroll_run_employee_id, business_date, count(*) as duplicate_count
from public.payroll_run_items
where category = 'unauthorized_absence_deduction'
group by payroll_run_employee_id, business_date
having count(*) > 1;

select category, direction, count(*) as row_count
from public.payroll_run_items
group by category, direction
order by category, direction;
