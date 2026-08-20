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
    // mealAllowancePromise starts as soon as the payroll snapshot resolves
    // (via onSnapshotReady), not after the full overview (standing/bonus/
    // adjustments) or paymentBatch — meal allowance never reads any of
    // those, only snapshot.context.{users,contracts,attendance} and
    // snapshot.employees' userIds (see lib/payroll/overview-server.ts for
    // why that userId set is provably identical to overview.employees').
    // Assigned exactly once, before loadPayrollOverview's own internal
    // Promise.all resolves, so it is always set by the time it is awaited
    // below — the non-null assertion there reflects that guarantee, not a
    // gap: if snapshot itself fails, onSnapshotReady never runs, but then
    // overviewPromise also rejects (same snapshotPromise, awaited inside
    // loadPayrollOverview) and this catch block returns before reaching the
    // mealAllowancePromise await at all.
    let mealAllowancePromise: ReturnType<typeof loadMealAllowanceCostSummary> | undefined;
    const overviewPromise=loadPayrollOverview(month,{
      onSnapshotReady:({snapshot,period})=>{
        mealAllowancePromise=loadMealAllowanceCostSummary(month,{
          calculationEndDate:period.calculationEndDate,
          users:snapshot.context.users,
          contracts:snapshot.context.contracts,
          attendance:snapshot.context.attendance,
          payrollUserIds:snapshot.employees.map(employee=>employee.userId),
        });
        // No-op catch on a separate derived chain only, purely to prevent a
        // Node unhandled-rejection warning for the stretch of time before
        // this is awaited below — mealAllowancePromise itself is untouched
        // and still rejects (and is still awaited) normally.
        void mealAllowancePromise.catch(()=>undefined);
      },
    });
    const paymentBatchPromise=Promise.resolve(
      supabaseServer.from("payroll_payment_batches").select("*").eq("payroll_month",`${month}-01`).maybeSingle(),
    );
    const [overview,{data:run,error:runError}]=await Promise.all([overviewPromise,paymentBatchPromise]);if(runError)throw runError;
    const paymentsPromise=run
      ? Promise.resolve(supabaseServer.from("payroll_employee_payments").select("user_id,payment_status,calculated_net_amount,actual_paid_amount,difference_amount,difference_reason,payment_date,paid_at,paid_by,paid_actor:users!payroll_employee_payments_paid_by_fkey(name,full_name,username)").eq("payroll_batch_id",run.id))
      : Promise.resolve({data:[],error:null});
    const [{data:payments,error:paymentError},mealAllowance]=await Promise.all([paymentsPromise,mealAllowancePromise!]);if(paymentError)throw paymentError;
    const paymentByUser=new Map((payments??[]).map(row=>[Number(row.user_id),row]));
    const employees=overview.employees.map(employee=>{const raw=overview.rawByUser.get(employee.userId);const calculationHash=raw?payrollPaymentSnapshotHash(buildEmployeePaymentSnapshot(employee,raw,overview.snapshot.sourceSnapshot as Record<string,unknown>)):null;return{...employee,payment:paymentByUser.get(employee.userId)??null,batchStatus:run?.status??null,batchId:run?.id??null,calculationHash}});
    // 식대비용은 지급 snapshot/hash(위 employees[].calculationHash, payrollPaymentSnapshotHash)와
    // 완전히 분리된 표시 전용 집계다 — loadPayrollOverview()가 아니라 이 GET 핸들러에서만
    // 계산해 summary/projectedSummary에 얹으므로, 출근 기록이 바뀌어 식대비용이 달라져도
    // 지급 계산 hash(PAYROLL_CALCULATION_STALE 판정)에는 전혀 영향을 주지 않는다.
    //
    // users/contracts/attendance는 loadPayrollOverview()가 이미 같은 달에 대해 읽어 둔
    // snapshot.context를 그대로 재사용한다(추가 조회 없음). 🍚 배지(eligibleUserIds)도 "오늘"이
    // 아니라 "조회 중인 급여월" 기준으로, employees[](calculationHash가 걸린 배열)에는 절대
    // 섞지 않고 이 한 번의 호출 안에서 함께 계산해 응답 최상위에 별도 필드로만 내려준다 — 이
    // 화면은 과거·미래 월을 자유롭게 넘나들며 조회할 수 있으므로, 오늘 날짜를 쓰면 이후에
    // 등록된 eligibility 변경 때문에 과거 급여장부의 배지가 바뀌어 버린다.
    const summary={...overview.summary,mealAllowanceAmount:mealAllowance.currentAmount,totalCompanyCostAmount:overview.summary.totalCompanyCostAmount+mealAllowance.currentAmount};
    const projectedSummary=overview.projectedSummary?{...overview.projectedSummary,mealAllowanceAmount:mealAllowance.projectedAmount,totalCompanyCostAmount:overview.projectedSummary.totalCompanyCostAmount+mealAllowance.projectedAmount}:null;
    const mealAllowanceEligibleUserIds=mealAllowance.eligibleUserIds;
    return payrollJson({ok:true,month,asOfDate:overview.period.asOfDate,future:overview.period.future,monthClosed:isClosedPayrollMonth(month),employees,summary,projectedSummary,mealAllowancePolicyMissing:mealAllowance.policyMissing,mealAllowanceEligibleUserIds,paymentBatch:run??null});
  } catch {
    return payrollJson({ ok: false, code: "PAYROLL_OVERVIEW_READ_FAILED" }, 500);
  }
}
