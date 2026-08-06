import { supabaseServer } from "@/lib/supabase/server";
import { validPayrollMonth } from "@/lib/payroll/monthly-run";
import { payrollJson, requirePayrollActor } from "@/lib/payroll/server";
import { loadPayrollOverview } from "@/lib/payroll/overview-server";
import { buildEmployeePaymentSnapshot, payrollPaymentSnapshotHash } from "@/lib/payroll/payment-snapshot";
import { isClosedPayrollMonth } from "@/lib/payroll/payment-period";
import { loadMealAllowanceCostSummary } from "@/lib/payroll/meal-allowance-server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await requirePayrollActor();
  if (auth.response) return auth.response;
  const month = validPayrollMonth(new URL(request.url).searchParams.get("month"));
  if (!month) return payrollJson({ ok: false, code: "INVALID_MONTH" }, 400);

  try {
    const overview=await loadPayrollOverview(month);
    const {data:run,error:runError}=await supabaseServer.from("payroll_payment_batches").select("*").eq("payroll_month",`${month}-01`).maybeSingle();if(runError)throw runError;
    const{data:payments,error:paymentError}=run?await supabaseServer.from("payroll_employee_payments").select("user_id,payment_status,calculated_net_amount,actual_paid_amount,difference_amount,difference_reason,payment_date,paid_at,paid_by,paid_actor:users!payroll_employee_payments_paid_by_fkey(name,full_name,username)").eq("payroll_batch_id",run.id):{data:[],error:null};if(paymentError)throw paymentError;
    const paymentByUser=new Map((payments??[]).map(row=>[Number(row.user_id),row]));
    const employees=overview.employees.map(employee=>{const raw=overview.rawByUser.get(employee.userId);const calculationHash=raw?payrollPaymentSnapshotHash(buildEmployeePaymentSnapshot(employee,raw,overview.snapshot.sourceSnapshot as Record<string,unknown>)):null;return{...employee,payment:paymentByUser.get(employee.userId)??null,batchStatus:run?.status??null,batchId:run?.id??null,calculationHash}});
    // 식대비용은 지급 snapshot/hash(위 employees[].calculationHash, payrollPaymentSnapshotHash)와
    // 완전히 분리된 표시 전용 집계다 — loadPayrollOverview()가 아니라 이 GET 핸들러에서만
    // 계산해 summary/projectedSummary에 얹으므로, 출근 기록이 바뀌어 식대비용이 달라져도
    // 지급 계산 hash(PAYROLL_CALCULATION_STALE 판정)에는 전혀 영향을 주지 않는다.
    const mealAllowance=await loadMealAllowanceCostSummary(month,{calculationEndDate:overview.period.calculationEndDate});
    const summary={...overview.summary,mealAllowanceAmount:mealAllowance.currentAmount,totalCompanyCostAmount:overview.summary.totalCompanyCostAmount+mealAllowance.currentAmount};
    const projectedSummary=overview.projectedSummary?{...overview.projectedSummary,mealAllowanceAmount:mealAllowance.projectedAmount,totalCompanyCostAmount:overview.projectedSummary.totalCompanyCostAmount+mealAllowance.projectedAmount}:null;
    return payrollJson({ok:true,month,asOfDate:overview.period.asOfDate,future:overview.period.future,monthClosed:isClosedPayrollMonth(month),employees,summary,projectedSummary,mealAllowancePolicyMissing:mealAllowance.policyMissing,paymentBatch:run??null});
  } catch {
    return payrollJson({ ok: false, code: "PAYROLL_OVERVIEW_READ_FAILED" }, 500);
  }
}
