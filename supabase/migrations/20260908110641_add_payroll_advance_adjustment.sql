begin;

alter table public.payroll_monthly_adjustments
  drop constraint payroll_monthly_adjustments_kind_check,
  add constraint payroll_monthly_adjustments_kind_check
    check (kind in ('incentive', 'penalty', 'advance')),
  drop constraint payroll_monthly_adjustments_category_check,
  add constraint payroll_monthly_adjustments_category_check
    check (category in ('sales','performance','service','late','early_leave','absence','damage','discipline','manual','advance','other')),
  add constraint payroll_monthly_adjustments_advance_category_check
    check ((kind = 'advance') = (category = 'advance'));

comment on table public.payroll_monthly_adjustments is
  'Append-only monthly incentive, manual penalty, and salary advance ledger. Rows are cancelled, never deleted.';

commit;
