import "server-only";

import { supabaseServer } from "@/lib/supabase/server";
import { loadPayrollMonthSnapshot, resolvePayrollOverviewPeriod, type AttendanceRow } from "@/lib/payroll/monthly-run";
import { buildPayrollOverviewEmployee, buildPayrollOverviewSummary, type PayrollMonthlyAdjustment } from "@/lib/payroll/overview";
import { buildPayrollOverviewProjectedSummary } from "@/lib/payroll/overview-projection";
import { loadMonthlyAttendanceStandings } from "@/lib/attendance/monthly-standing-server";
import { loadAttendanceBonusVersions } from "@/lib/payroll/attendance-bonus-server";
import { qualifiesForAttendanceBonus, selectAttendanceBonusEligibilityAt, selectAttendanceBonusPolicyAt } from "@/lib/payroll/attendance-bonus";
import { isClosedPayrollMonth } from "@/lib/payroll/payment-period";
import { PAYROLL_RUN_ENGINE_VERSION } from "@/lib/payroll/monthly-run";
import type { PayrollOverviewPeriod } from "@/lib/payroll/overview-period";

export type PayrollMonthSnapshot = Awaited<ReturnType<typeof loadPayrollMonthSnapshot>>;

export async function loadPayrollOverview(month: string,options?:{userId?:number;onSnapshotReady?:(input:{snapshot:PayrollMonthSnapshot;period:PayrollOverviewPeriod})=>void}) {
  const adjustmentQuery=supabaseServer.from("payroll_monthly_adjustments").select("id,user_id,kind,category,amount,business_date,reason,note,created_at").eq("payroll_month",`${month}-01`).is("cancelled_at",null);
  const adjustmentPromise=Promise.resolve(options?.userId===undefined?adjustmentQuery:adjustmentQuery.eq("user_id",options.userId));
  void adjustmentPromise.catch(()=>undefined);
  const period=await resolvePayrollOverviewPeriod(month);
  // Shared attendance_records read for snapshot+standing — ONLY when
  // calculationEndDate is non-null (current/completed period). In that case
  // both loaders' own query construction reduces to the exact same
  // gte(monthStart).lte(calculationEndDate) with the same columns/userId
  // filter (proved in the Phase 2 audit), so one read safely serves both.
  // Started here, right after period resolves — same moment snapshot/standing
  // would otherwise each start their own — and handed to both as an
  // unresolved promise so neither loader waits on the other; each still
  // awaits it alongside its own other queries in its own Promise.all.
  //
  // For calculationEndDate === null (future month), attendancePromise stays
  // undefined on purpose: snapshot and standing fall back to their existing,
  // independently-shaped queries exactly as before this change. Their future-
  // month query shapes are NOT identical (see monthly-run.ts / monthly-
  // standing-server.ts), so they must not be unified here.
  const attendancePromise=period.calculationEndDate?Promise.resolve((()=>{
    const query=supabaseServer.from("attendance_records").select("id,user_id,status,work_date,check_in_at,check_out_at,late_minutes,early_leave_minutes,work_minutes,approval_status,updated_at").gte("work_date",`${month}-01`).lte("work_date",period.calculationEndDate as string);
    return options?.userId===undefined?query:query.eq("user_id",options.userId);
  })()):undefined;
  if(attendancePromise)void attendancePromise.catch(()=>undefined);
  const snapshotPromise=loadPayrollMonthSnapshot(month,{calculationEndDate:period.calculationEndDate,userId:options?.userId,attendancePromise});
  // Fires as soon as snapshot resolves successfully — before standing/bonus/
  // adjustments are awaited below — so a caller (the overview route) can
  // start snapshot-only work (meal allowance) without waiting for the rest
  // of this function. Never fires on a snapshot failure: the .then() has no
  // onRejected branch, so a rejected snapshotPromise skips straight past it
  // and is still surfaced normally by the Promise.all await below. The
  // derived .then() chain gets its own no-op .catch() purely to avoid an
  // unhandled-rejection warning on that (separate, unused) chain — the
  // original snapshotPromise's rejection is untouched and still propagates.
  const onSnapshotReady=options?.onSnapshotReady;
  if(onSnapshotReady){void snapshotPromise.then(snapshot=>{onSnapshotReady({snapshot,period});}).catch(()=>undefined);}
  const attendanceStandingPromise=loadMonthlyAttendanceStandings(month,{period,userId:options?.userId,attendancePromise});
  const bonusVersionsPromise=snapshotPromise.then(snapshot=>
    loadAttendanceBonusVersions(month,snapshot.employees.map(employee=>employee.userId)),
  );
  const [snapshot,adjustmentResult,attendanceStanding,bonusVersions]=await Promise.all([
    snapshotPromise,
    adjustmentPromise,
    attendanceStandingPromise,
    bonusVersionsPromise,
  ]);
  if(adjustmentResult.error)throw new Error("PAYROLL_ADJUSTMENT_READ_FAILED");
  const adjustmentsByUser=new Map<number,PayrollMonthlyAdjustment[]>();
  for(const row of adjustmentResult.data??[]){const list=adjustmentsByUser.get(Number(row.user_id))??[];list.push({id:Number(row.id),kind:row.kind as "incentive"|"penalty",category:String(row.category),amount:Number(row.amount),businessDate:String(row.business_date),reason:String(row.reason),note:row.note?String(row.note):null,createdAt:String(row.created_at)});adjustmentsByUser.set(Number(row.user_id),list);}
  const userById=new Map(snapshot.context.users.map(user=>[user.id,user]));
  const contractsByUser=new Map<number,typeof snapshot.context.contracts>();
  for(const contract of snapshot.context.contracts){const list=contractsByUser.get(contract.userId)??[];list.push(contract);contractsByUser.set(contract.userId,list);}
  const rawByUser=new Map(snapshot.employees.map(employee=>[employee.userId,employee]));
  const attendanceUsersById=new Map(attendanceStanding.users.map(user=>[Number(user.id),user]));
  const bonusPolicy=selectAttendanceBonusPolicyAt(bonusVersions.policies,month);
  for(const employee of snapshot.employees){
    const standing=attendanceStanding.standings.get(employee.userId);
    const attendanceUser=attendanceUsersById.get(employee.userId);
    const eligibility=selectAttendanceBonusEligibilityAt(bonusVersions.eligibilityByUser.get(employee.userId)??[],month);
    if(standing&&bonusPolicy&&qualifiesForAttendanceBonus({monthClosed:isClosedPayrollMonth(month),attendanceTrackingEnabled:attendanceUser?.attendance_tracking_enabled===true,policy:bonusPolicy,eligibility,standing})){
      employee.items.push({itemType:"automatic",category:"attendance_bonus",direction:"addition",amount:bonusPolicy.bonusAmount,originalAmount:bonusPolicy.bonusAmount,businessDate:null,description:"개근 보너스",sourceSnapshot:{policyVersionId:bonusPolicy.id,policyRevision:bonusPolicy.revision,eligibilityVersionId:eligibility?.id??null,eligibilityRevision:eligibility?.revision??null,payrollMonth:month,policyEffectiveMonth:bonusPolicy.effectiveMonth,eligibilityEffectiveMonth:eligibility?.effectiveMonth??null,minimumActualWorkdays:bonusPolicy.minimumActualWorkdays,allowedLateCount:bonusPolicy.allowedLateCount,allowedEarlyLeaveCount:bonusPolicy.allowedEarlyLeaveCount,bonusAmount:bonusPolicy.bonusAmount,actualWorkDays:standing.actualWorkDays,lateCount:standing.lateCount,earlyLeaveCount:standing.earlyLeaveCount,unauthorizedAbsenceCount:standing.unauthorizedAbsenceCount,blockingCount:standing.blockingCount,engineVersion:PAYROLL_RUN_ENGINE_VERSION}});
    }
  }
  const employees=snapshot.employees.flatMap(employee=>{const user=userById.get(employee.userId);return user?[buildPayrollOverviewEmployee({employee,user,contracts:contractsByUser.get(employee.userId)??[],adjustments:adjustmentsByUser.get(employee.userId)??[],period})]:[];});
  for(const employee of employees){employee.attendanceStanding=attendanceStanding.standings.get(employee.userId)??null;}
  const directorInsuranceAmount=Number(((snapshot.sourceSnapshot.insuranceSettings as {director?:{calculatedAmount?:number}}|undefined)?.director?.calculatedAmount)??0);
  return {period,snapshot,employees,rawByUser,directorInsuranceAmount,summary:buildPayrollOverviewSummary(employees,directorInsuranceAmount),projectedSummary:buildPayrollOverviewProjectedSummary(employees,directorInsuranceAmount)};
}
