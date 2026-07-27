import type { PayrollContract, WorkScheduleVersion } from "./types";

export function mapContract(row: Record<string, unknown>): PayrollContract {
  return {
    id: Number(row.id), userId: Number(row.user_id),
    payType: row.pay_type as PayrollContract["payType"],
    calculationBasis: row.calculation_basis as PayrollContract["calculationBasis"],
    baseSalary: Number(row.base_salary),
    standardWorkdays: row.standard_workdays === null ? null : Number(row.standard_workdays),
    standardMinutesPerDay: Number(row.standard_minutes_per_day),
    timeBlockMinutes: Number(row.time_block_minutes),
    roundingMode: row.rounding_mode as PayrollContract["roundingMode"],
    lateAdjustmentMode: row.late_adjustment_mode as PayrollContract["lateAdjustmentMode"],
    earlyLeaveAdjustmentMode: row.early_leave_adjustment_mode as PayrollContract["earlyLeaveAdjustmentMode"],
    overtimeMode: row.overtime_mode as PayrollContract["overtimeMode"],
    paidLeaveMode: row.paid_leave_mode as PayrollContract["paidLeaveMode"],
    effectiveFrom: String(row.effective_from),
    effectiveTo: row.effective_to ? String(row.effective_to) : null,
    revision: Number(row.revision),
  };
}

export function mapSchedule(row: Record<string, unknown>): WorkScheduleVersion {
  return { id: Number(row.id), userId: Number(row.user_id), startTime: String(row.start_time).slice(0,5), endTime: String(row.end_time).slice(0,5), unpaidBreakMinutes: Number(row.unpaid_break_minutes || 0), effectiveFrom: String(row.effective_from), effectiveTo: row.effective_to ? String(row.effective_to) : null, revision: Number(row.revision), changeReason: row.change_reason ? String(row.change_reason) : null };
}
