import "server-only";
import { createHash } from "node:crypto";
import type { PayrollOverviewEmployee } from "@/lib/payroll/overview";
import type { PayrollRunEmployeeInput } from "@/lib/payroll/monthly-run";

export function buildEmployeePaymentSnapshot(employee:PayrollOverviewEmployee,raw:PayrollRunEmployeeInput,sourceSnapshot:Record<string,unknown>){
  return {employee,contractSnapshot:raw.contractSnapshot,attendanceSnapshot:raw.attendanceSnapshot,insuranceSnapshot:raw.insuranceSnapshot,taxSnapshot:employee.tax,levelSnapshot:employee.levelInfo,adjustmentsSnapshot:employee.adjustments,automaticItemsSnapshot:raw.items,automaticReviewsSnapshot:raw.reviews,partTimeExtraWorkSnapshot:raw.partTimeExtraWork,automaticIncentivesSnapshot:employee.automaticIncentives??[],automaticPenaltiesSnapshot:employee.automaticPenalties,sourceSnapshot};
}
export function payrollPaymentSnapshotHash(snapshot:unknown){return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");}
