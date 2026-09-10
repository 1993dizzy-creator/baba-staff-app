import type { PayrollRunEmployeeInput } from "../monthly-run";
import type { PayrollOverviewEmployee, PayrollMonthlyAdjustment } from "../overview";
import type { PayrollAttendanceSourceFact } from "../source-facts/attendance";
// @ts-expect-error Node's strip-types test runner requires the explicit extension.
import { payrollSourceReadiness } from "./readiness.ts";
// @ts-expect-error Node's strip-types test runner requires the explicit extension.
import { stablePayrollSourceHash } from "./stable-hash.ts";
// @ts-expect-error Node's strip-types test runner requires the explicit extension.
import { PAYROLL_SOURCE_EXPORT_SCHEMA_VERSION } from "./types.ts";
import type { PayrollSourceAdjustment, PayrollSourceAttendanceItem, PayrollSourceContract, PayrollSourceEmployee, PayrollSourceExport, PayrollSourceExtraWorkItem } from "./types.ts";

type ExportOverview = {
  period: { asOfDate: string };
  employees: PayrollOverviewEmployee[];
  rawByUser: Map<number, PayrollRunEmployeeInput>;
  adjustmentLedgerByUser: Map<number, PayrollMonthlyAdjustment[]>;
  snapshot: {
    context: {
      attendance: Array<{id:number;user_id:number;status:string;work_date:string;check_in_at:string|null;check_out_at:string|null;late_minutes:number|null;early_leave_minutes:number|null;work_minutes:number|null;note?:string|null;approval_status:string|null;updated_at:string|null}>;
    };
    sourceSnapshot: Record<string, unknown>;
  };
};

type MealReference = {
  currentByUser: Array<{ userId: number; eligibleDays: number; referenceAmount: number }>;
};

function fallbackAttendanceFacts(overview: ExportOverview, userId: number): PayrollSourceAttendanceItem[] {
  return overview.snapshot.context.attendance.filter(row=>Number(row.user_id)===userId).map(row=>{
    const classification:PayrollSourceAttendanceItem["classification"] = row.status === "leave" ? "leave"
      : row.status === "unauthorized_absence" ? "unauthorized_absence"
      : row.check_in_at && row.check_out_at ? "completed_work"
      : row.check_in_at ? "working" : "unresolved";
    return {businessDate:row.work_date,attendanceRecordId:Number(row.id),classification,checkInAt:row.check_in_at,checkOutAt:row.check_out_at,sourceUpdatedAt:row.updated_at,actualMinutes:row.work_minutes==null?null:Number(row.work_minutes),lateMinutes:Number(row.late_minutes??0),rawLateMinutes:Number(row.late_minutes??0),effectiveLateMinutes:Number(row.late_minutes??0),earlyLeaveMinutes:Number(row.early_leave_minutes??0),manualLateNormalized:false,approvalStatus:row.approval_status,reason:row.note??null,schedule:null,storePolicyRevision:null,warningCodes:[]};
  }).sort((left,right)=>left.businessDate.localeCompare(right.businessDate)||Number(left.attendanceRecordId)-Number(right.attendanceRecordId));
}

function attendanceFacts(overview: ExportOverview, employee: PayrollOverviewEmployee, raw: PayrollRunEmployeeInput) {
  const recordById=new Map(overview.snapshot.context.attendance.map(row=>[Number(row.id),row]));
  const days=(raw.attendanceSnapshot.days??[]) as Array<{sourceFact?:PayrollAttendanceSourceFact}>;
  const mapped=days.flatMap(day=>{
    if(!day.sourceFact)return [];
    const fact=day.sourceFact;const record=fact.attendanceRecordId===null?null:recordById.get(fact.attendanceRecordId)??null;
    return [{businessDate:fact.businessDate,attendanceRecordId:fact.attendanceRecordId,classification:fact.classification,checkInAt:fact.checkInAt,checkOutAt:fact.checkOutAt,sourceUpdatedAt:fact.sourceUpdatedAt,actualMinutes:fact.actualMinutes,lateMinutes:fact.lateMinutes,rawLateMinutes:fact.rawLateMinutes,effectiveLateMinutes:fact.effectiveLateMinutes,earlyLeaveMinutes:fact.earlyLeaveMinutes,manualLateNormalized:fact.manualLateNormalized,approvalStatus:fact.approvalStatus,reason:record?.note??null,schedule:fact.schedule,storePolicyRevision:fact.storePolicyRevision,warningCodes:[...fact.warningCodes]} satisfies PayrollSourceAttendanceItem];
  });
  const rows=(mapped.length>0?mapped:fallbackAttendanceFacts(overview,employee.userId)).sort((left,right)=>left.businessDate.localeCompare(right.businessDate)||Number(left.attendanceRecordId??0)-Number(right.attendanceRecordId??0));
  const completed=rows.filter(row=>row.classification==="completed_work");
  return {recognizedAttendanceDays:new Set(completed.map(row=>row.businessDate)).size,completedWorkDates:[...new Set(completed.map(row=>row.businessDate))].sort(),completed,leave:rows.filter(row=>row.classification==="leave"),late:rows.filter(row=>row.lateMinutes>0),earlyLeave:rows.filter(row=>row.earlyLeaveMinutes>0),unauthorizedAbsence:rows.filter(row=>row.classification==="unauthorized_absence"),unresolved:rows.filter(row=>["working","unresolved","no_record"].includes(row.classification))};
}

function adjustment(row: PayrollMonthlyAdjustment): PayrollSourceAdjustment {
  return {id:row.id,businessDate:row.businessDate,amount:row.amount,category:row.category,reason:row.reason,memo:row.note,cancelled:Boolean(row.cancelledAt),cancelledAt:row.cancelledAt??null,cancelledBy:row.cancelledBy??null,cancellationReason:row.cancellationReason??null};
}

function contractVersion(contract: PayrollRunEmployeeInput["contractSnapshot"][number]): PayrollSourceContract {
  return {contractId:contract.id,revision:contract.revision,payType:contract.payType,calculationBasis:contract.calculationBasis,baseSalaryAmount:contract.baseSalary,fixedRaiseAmount:contract.fixedRaiseAmount,standardWorkdays:contract.standardWorkdays,effectiveFrom:contract.effectiveFrom,effectiveTo:contract.effectiveTo};
}

function regularExtraWork(raw: PayrollRunEmployeeInput): PayrollSourceExtraWorkItem[] {
  return raw.items.filter(item=>item.category==="overtime"&&item.direction==="addition").map(item=>({businessDate:item.businessDate??"",attendanceRecordId:Number(item.sourceSnapshot.attendanceRecordId??0),decisionId:item.sourceSnapshot.decisionId==null?null:Number(item.sourceSnapshot.decisionId),approvedMinutes:Number(item.sourceSnapshot.overtimeMinutes??item.sourceSnapshot.candidateMinutes??0),hourlyRateAmount:Number(item.sourceSnapshot.hourlyRateAmount??item.sourceSnapshot.minuteRate??0)*Number(item.sourceSnapshot.hourlyRateAmount==null?60:1),referenceAmount:item.amount,decidedBy:item.sourceSnapshot.decidedBy==null?null:Number(item.sourceSnapshot.decidedBy),decidedAt:item.sourceSnapshot.decidedAt==null?null:String(item.sourceSnapshot.decidedAt),sourceHash:String(item.sourceSnapshot.sourceHash??stablePayrollSourceHash(item.sourceSnapshot))}));
}

function buildEmployee(input:{overview:ExportOverview;employee:PayrollOverviewEmployee;raw:PayrollRunEmployeeInput;meal:MealReference["currentByUser"][number]|null}):PayrollSourceEmployee{
  const {overview,employee,raw}=input;
  const attendance=attendanceFacts(overview,employee,raw);
  const ledger=(overview.adjustmentLedgerByUser.get(employee.userId)??[]).toSorted((left,right)=>left.id-right.id);
  const partTime=raw.partTimeExtraWork.filter(row=>row.status==="approved").map(row=>({businessDate:row.businessDate,attendanceRecordId:row.attendanceRecordId,decisionId:row.decision?.id??null,approvedMinutes:row.candidateMinutes,hourlyRateAmount:row.hourlyRateAmount,referenceAmount:row.candidateAmount,decidedBy:row.decision?.decidedBy??null,decidedAt:row.decision?.decidedAt??null,sourceHash:row.sourceHash}));
  const reviewCodes:string[]=raw.reviews.map(review=>review.warningCode);
  if(attendance.unresolved.length>0)reviewCodes.push("UNRESOLVED_ATTENDANCE");
  const readiness=payrollSourceReadiness({reviewCodes,taxRequiresReview:employee.tax.status==="requires_review",insuranceSettingMissing:raw.insuranceSnapshot.settingVersionId===null});
  const levelVersions=(overview.snapshot.sourceSnapshot.levelProgramVersions??[]) as Array<{userId:number;id?:number;revision?:number}>;
  const levelVersion=levelVersions.find(row=>Number(row.userId)===employee.userId)??null;
  const bonus=employee.automaticIncentives?.filter(row=>row.category==="attendance_bonus").reduce((sum,row)=>sum+row.amount,0)??0;
  const value:Omit<PayrollSourceEmployee,"sourceHash">={employee:{employeeId:employee.userId,displayName:employee.name,accountingName:employee.tax.accountingName,part:employee.part,position:employee.position},contract:employee.contract?contractVersion(employee.contract):null,contractVersions:raw.contractSnapshot.map(contractVersion).toSorted((left,right)=>left.effectiveFrom.localeCompare(right.effectiveFrom)||left.revision-right.revision),level:{versionId:levelVersion?.id??null,revision:levelVersion?.revision??null,level:employee.levelInfo.level,appliedRaiseAmount:employee.amounts.levelRaiseAmount},attendance,extraWork:{approvedRegular:regularExtraWork(raw),approvedPartTime:partTime,pendingCount:raw.partTimeExtraWork.filter(row=>row.status==="review_required").length,staleCount:raw.partTimeExtraWork.filter(row=>row.status==="stale").length},adjustments:{incentives:ledger.filter(row=>row.kind==="incentive").map(adjustment),penalties:ledger.filter(row=>row.kind==="penalty").map(adjustment),advances:ledger.filter(row=>row.kind==="advance").map(adjustment)},attendanceBonus:{eligible:bonus>0,referenceAmount:bonus},insurance:{settingVersionId:raw.insuranceSnapshot.settingVersionId,revision:raw.insuranceSnapshot.revision,referenceEmployeeAmount:raw.insuranceSnapshot.settingVersionId===null?null:raw.insuranceSnapshot.employeeDeductionAmount,referenceEmployerAmount:raw.insuranceSnapshot.settingVersionId===null?null:raw.insuranceSnapshot.employerAmount},tax:{settingVersionId:employee.tax.taxProfileId,settingRevision:employee.tax.taxProfileRevision,policyVersionId:employee.tax.taxPolicyId,policyRevision:employee.tax.taxPolicyRevision,taxMode:employee.tax.taxMode,burdenMode:employee.tax.taxBurdenMode,referenceCalculatedAmount:employee.tax.status==="requires_review"?null:employee.tax.calculatedPitAmount,requiresReview:employee.tax.status==="requires_review"},mealAllowance:{eligibleDays:input.meal?.eligibleDays??0,referenceAmount:input.meal?.referenceAmount??0},readiness};
  return {...value,sourceHash:stablePayrollSourceHash(value)};
}

export function buildPayrollSourceExport(input:{month:string;overview:ExportOverview;mealAllowance:MealReference;generatedAt?:string}):PayrollSourceExport{
  const mealByUser=new Map(input.mealAllowance.currentByUser.map(row=>[row.userId,row]));
  const employees=input.overview.employees.flatMap(employee=>{const raw=input.overview.rawByUser.get(employee.userId);return raw?[buildEmployee({overview:input.overview,employee,raw,meal:mealByUser.get(employee.userId)??null})]:[]}).toSorted((left,right)=>left.employee.employeeId-right.employee.employeeId);
  const readiness={readyEmployeeCount:employees.filter(row=>row.readiness.readyForAccounting).length,blockedEmployeeCount:employees.filter(row=>!row.readiness.readyForAccounting).length,blockingCodes:[...new Set(employees.flatMap(row=>row.readiness.blockingCodes))].sort(),warningCodes:[...new Set(employees.flatMap(row=>row.readiness.warningCodes))].sort()};
  const value={schemaVersion:PAYROLL_SOURCE_EXPORT_SCHEMA_VERSION,payrollMonth:input.month,calculationThroughDate:input.overview.period.asOfDate,generatedAt:input.generatedAt??new Date().toISOString(),employees,readiness};
  return {...value,sourceHash:stablePayrollSourceHash(value)};
}
