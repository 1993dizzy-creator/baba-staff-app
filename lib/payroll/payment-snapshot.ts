import "server-only";
import type { PayrollOverviewEmployee } from "@/lib/payroll/overview";
import type { PayrollRunEmployeeInput } from "@/lib/payroll/monthly-run";
import { stablePayrollSourceHash } from "@/lib/payroll/source-export/stable-hash";

export function buildEmployeePaymentSnapshot(employee:PayrollOverviewEmployee,raw:PayrollRunEmployeeInput,sourceSnapshot:Record<string,unknown>){
  return {employee,contractSnapshot:raw.contractSnapshot,attendanceSnapshot:raw.attendanceSnapshot,insuranceSnapshot:raw.insuranceSnapshot,taxSnapshot:employee.tax,levelSnapshot:employee.levelInfo,adjustmentsSnapshot:employee.adjustments,automaticItemsSnapshot:raw.items,automaticReviewsSnapshot:raw.reviews,partTimeExtraWorkSnapshot:raw.partTimeExtraWork,automaticIncentivesSnapshot:employee.automaticIncentives??[],automaticPenaltiesSnapshot:employee.automaticPenalties,sourceSnapshot};
}
export function payrollPaymentSnapshotHash(snapshot:unknown){return stablePayrollSourceHash(snapshot);}
