import "server-only";

import { supabaseServer } from "@/lib/supabase/server";
import { loadPayrollMonthSnapshot, resolvePayrollOverviewPeriod } from "@/lib/payroll/monthly-run";
import { buildPayrollOverviewEmployee, buildPayrollOverviewSummary, type PayrollMonthlyAdjustment } from "@/lib/payroll/overview";
import { buildPayrollOverviewProjectedSummary } from "@/lib/payroll/overview-projection";
import { loadMonthlyAttendanceStandings } from "@/lib/attendance/monthly-standing-server";
import { loadAttendanceBonusVersions } from "@/lib/payroll/attendance-bonus-server";
import { qualifiesForAttendanceBonus, selectAttendanceBonusEligibilityAt, selectAttendanceBonusPolicyAt } from "@/lib/payroll/attendance-bonus";
import { isClosedPayrollMonth } from "@/lib/payroll/payment-period";
import { PAYROLL_RUN_ENGINE_VERSION } from "@/lib/payroll/monthly-run";

export async function loadPayrollOverview(month: string,options?:{userId?:number}) {
  const adjustmentQuery=supabaseServer.from("payroll_monthly_adjustments").select("id,user_id,kind,category,amount,business_date,reason,note,created_at").eq("payroll_month",`${month}-01`).is("cancelled_at",null);
  const adjustmentPromise=Promise.resolve(options?.userId===undefined?adjustmentQuery:adjustmentQuery.eq("user_id",options.userId));
  void adjustmentPromise.catch(()=>undefined);
  const period=await resolvePayrollOverviewPeriod(month);
  const snapshotPromise=loadPayrollMonthSnapshot(month,{calculationEndDate:period.calculationEndDate,userId:options?.userId});
  const attendanceStandingPromise=loadMonthlyAttendanceStandings(month,{period,userId:options?.userId});
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
