import {payrollJson,requirePayrollActor} from "@/lib/payroll/server";
import {supabaseServer} from "@/lib/supabase/server";
import {loadMealAllowanceEligibilityDuringMonth} from "@/lib/payroll/meal-allowance-eligibility-server";
export const dynamic="force-dynamic";
const validId=(value:string)=>{const id=Number(value);return Number.isSafeInteger(id)&&id>0?id:null};
export async function GET(_request:Request,{params}:{params:Promise<{runId:string}>}){const auth=await requirePayrollActor();if(auth.response)return auth.response;const runId=validId((await params).runId);if(!runId)return payrollJson({ok:false,code:"INVALID_RUN_ID"},400);const[{data:run,error},{data:employees,error:employeeError},{data:audit,error:auditError}]=await Promise.all([supabaseServer.from("payroll_payment_batches").select("*").eq("id",runId).maybeSingle(),supabaseServer.from("payroll_employee_payments").select("*,paid_actor:users!payroll_employee_payments_paid_by_fkey(name,full_name,username)").eq("payroll_batch_id",runId).order("employee_name"),supabaseServer.from("payroll_payment_audit_logs").select("*").eq("payroll_batch_id",runId).order("created_at",{ascending:false})]);if(error||employeeError||auditError)return payrollJson({ok:false,code:"PAYROLL_RUN_READ_FAILED"},500);if(!run)return payrollJson({ok:false,code:"RUN_NOT_FOUND"},404);
  // 🍚 배지 표시 전용 — 이 run의 급여 대상 월(payroll_month) 기준으로 판정한다. "오늘" 날짜는
  // 쓰지 않는다: 과거 급여장부를 나중에 다시 열어봤을 때, 그 사이 등록된 eligibility 변경
  // 때문에 배지가 바뀌면 안 되기 때문이다. payroll_employee_payments의 확정 지급 금액/
  // 스냅샷과는 완전히 별개이며, 응답 최상위에만 붙인다.
  const mealAllowanceEligibility=await loadMealAllowanceEligibilityDuringMonth((employees??[]).map(employee=>Number(employee.user_id)),String(run.payroll_month).slice(0,7));
  const mealAllowanceEligibleUserIds=[...mealAllowanceEligibility.entries()].filter(([,eligible])=>eligible).map(([userId])=>userId);
  return payrollJson({ok:true,run,employees:employees??[],audit:audit??[],mealAllowanceEligibleUserIds})}
