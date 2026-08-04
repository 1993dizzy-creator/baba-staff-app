import "server-only";

import { supabaseServer } from "@/lib/supabase/server";
import { loadPayrollMonthSnapshot, resolvePayrollOverviewPeriod } from "@/lib/payroll/monthly-run";
import { buildPayrollOverviewEmployee, buildPayrollOverviewSummary, type PayrollMonthlyAdjustment } from "@/lib/payroll/overview";
import { buildPayrollOverviewProjectedSummary } from "@/lib/payroll/overview-projection";

export async function loadPayrollOverview(month: string) {
  const period=await resolvePayrollOverviewPeriod(month);
  const [snapshot,adjustmentResult]=await Promise.all([
    loadPayrollMonthSnapshot(month,{calculationEndDate:period.calculationEndDate}),
    supabaseServer.from("payroll_monthly_adjustments").select("id,user_id,kind,category,amount,business_date,reason,note,created_at").eq("payroll_month",`${month}-01`).is("cancelled_at",null),
  ]);
  if(adjustmentResult.error)throw new Error("PAYROLL_ADJUSTMENT_READ_FAILED");
  const adjustmentsByUser=new Map<number,PayrollMonthlyAdjustment[]>();
  for(const row of adjustmentResult.data??[]){const list=adjustmentsByUser.get(Number(row.user_id))??[];list.push({id:Number(row.id),kind:row.kind as "incentive"|"penalty",category:String(row.category),amount:Number(row.amount),businessDate:String(row.business_date),reason:String(row.reason),note:row.note?String(row.note):null,createdAt:String(row.created_at)});adjustmentsByUser.set(Number(row.user_id),list);}
  const userById=new Map(snapshot.context.users.map(user=>[user.id,user]));
  const contractsByUser=new Map<number,typeof snapshot.context.contracts>();
  for(const contract of snapshot.context.contracts){const list=contractsByUser.get(contract.userId)??[];list.push(contract);contractsByUser.set(contract.userId,list);}
  const rawByUser=new Map(snapshot.employees.map(employee=>[employee.userId,employee]));
  const employees=snapshot.employees.flatMap(employee=>{const user=userById.get(employee.userId);return user?[buildPayrollOverviewEmployee({employee,user,contracts:contractsByUser.get(employee.userId)??[],adjustments:adjustmentsByUser.get(employee.userId)??[],period})]:[];});
  const directorInsuranceAmount=Number(((snapshot.sourceSnapshot.insuranceSettings as {director?:{calculatedAmount?:number}}|undefined)?.director?.calculatedAmount)??0);
  return {period,snapshot,employees,rawByUser,directorInsuranceAmount,summary:buildPayrollOverviewSummary(employees,directorInsuranceAmount),projectedSummary:buildPayrollOverviewProjectedSummary(employees,directorInsuranceAmount)};
}
