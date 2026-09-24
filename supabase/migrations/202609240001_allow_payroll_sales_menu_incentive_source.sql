alter table public.payroll_monthly_adjustments
  drop constraint if exists payroll_monthly_adjustments_source_type_check;

alter table public.payroll_monthly_adjustments
  add constraint payroll_monthly_adjustments_source_type_check
  check (source_type in ('manual', 'sales_menu_incentive'));

comment on column public.payroll_monthly_adjustments.source_type is
  'Adjustment origin. manual rows are operator-entered; sales_menu_incentive rows are deterministic POS menu-sales payroll adjustments.';
