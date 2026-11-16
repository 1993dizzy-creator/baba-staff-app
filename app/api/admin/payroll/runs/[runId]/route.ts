import {payrollJson,requirePayrollActor} from "@/lib/payroll/server";
import {supabaseServer} from "@/lib/supabase/server";
import {loadMealAllowanceEligibilityDuringMonth} from "@/lib/payroll/meal-allowance-eligibility-server";
export const dynamic="force-dynamic";
const validId=(value:string)=>{const id=Number(value);return Number.isSafeInteger(id)&&id>0?id:null};
// 분할 지급(allocations)·배치 잔차(residuals) 테이블이 아직 없는 환경(구 Migration 상태)에서는 빈 목록으로 본다.
const missingTable=(error:{code?:string}|null)=>error?.code==="42P01"||error?.code==="PGRST205";
export async function GET(_request:Request,{params}:{params:Promise<{runId:string}>}){const auth=await requirePayrollActor();if(auth.response)return auth.response;const runId=validId((await params).runId);if(!runId)return payrollJson({ok:false,code:"INVALID_RUN_ID"},400);const[{data:run,error},{data:employees,error:employeeError},{data:audit,error:auditError}]=await Promise.all([supabaseServer.from("payroll_payment_batches").select("*").eq("id",runId).maybeSingle(),supabaseServer.from("payroll_employee_payments").select("*,paid_actor:users!payroll_employee_payments_paid_by_fkey(name,full_name,username)").eq("payroll_batch_id",runId).order("employee_name"),supabaseServer.from("payroll_payment_audit_logs").select("*").eq("payroll_batch_id",runId).order("created_at",{ascending:false}).order("id",{ascending:false})]);if(error||employeeError||auditError)return payrollJson({ok:false,code:"PAYROLL_RUN_READ_FAILED"},500);if(!run)return payrollJson({ok:false,code:"RUN_NOT_FOUND"},404);
  // 지급일·계좌별 출금 표시 전용(읽기 전용): 저장된 분할 지급·배치 잔차·출금계좌 이름만 읽는다.
  const[{data:allocations,error:allocationError},{data:residuals,error:residualError},{data:fundAccounts,error:fundAccountError}]=await Promise.all([
    supabaseServer.from("payroll_employee_payment_allocations").select("id,employee_payment_id,user_id,payment_date,fund_account_id,amount,allocation_kind,note,status").eq("payroll_batch_id",runId).order("id"),
    supabaseServer.from("payroll_payment_group_residuals").select("id,payment_date,fund_account_id,amount,reason").eq("payroll_batch_id",runId).order("id"),
    supabaseServer.from("ledger_fund_accounts").select("id,code,display_name").order("id"),
  ]);
  if((allocationError&&!missingTable(allocationError))||(residualError&&!missingTable(residualError))||fundAccountError)return payrollJson({ok:false,code:"PAYROLL_RUN_READ_FAILED"},500);
  // 🍚 배지 표시 전용 — 이 run의 급여 대상 월(payroll_month) 기준으로 판정한다. "오늘" 날짜는
  // 쓰지 않는다: 과거 급여장부를 나중에 다시 열어봤을 때, 그 사이 등록된 eligibility 변경
  // 때문에 배지가 바뀌면 안 되기 때문이다. payroll_employee_payments의 확정 지급 금액/
  // 스냅샷과는 완전히 별개이며, 응답 최상위에만 붙인다.
  const mealAllowanceEligibility=await loadMealAllowanceEligibilityDuringMonth((employees??[]).map(employee=>Number(employee.user_id)),String(run.payroll_month).slice(0,7));
  const mealAllowanceEligibleUserIds=[...mealAllowanceEligibility.entries()].filter(([,eligible])=>eligible).map(([userId])=>userId);
  return payrollJson({ok:true,run,employees:employees??[],audit:audit??[],allocations:allocationError?[]:allocations??[],residuals:residualError?[]:residuals??[],fundAccounts:fundAccounts??[],mealAllowanceEligibleUserIds})}
