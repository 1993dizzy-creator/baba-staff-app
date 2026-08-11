import "server-only";
import { createHash } from "node:crypto";
import type { PayrollOverviewEmployee } from "@/lib/payroll/overview";
import type { PayrollRunEmployeeInput } from "@/lib/payroll/monthly-run";

export function buildEmployeePaymentSnapshot(employee:PayrollOverviewEmployee,raw:PayrollRunEmployeeInput,sourceSnapshot:Record<string,unknown>){
  return {employee,contractSnapshot:raw.contractSnapshot,attendanceSnapshot:raw.attendanceSnapshot,insuranceSnapshot:raw.insuranceSnapshot,levelSnapshot:employee.levelInfo,adjustmentsSnapshot:employee.adjustments,automaticIncentivesSnapshot:employee.automaticIncentives??[],automaticPenaltiesSnapshot:employee.automaticPenalties,sourceSnapshot};
}
export function payrollPaymentSnapshotHash(snapshot:unknown){return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");}
