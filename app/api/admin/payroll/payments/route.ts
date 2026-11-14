import { supabaseServer } from "@/lib/supabase/server";
import { validPayrollMonth } from "@/lib/payroll/monthly-run";
import { loadPayrollOverview } from "@/lib/payroll/overview-server";
import { buildEmployeePaymentSnapshot, payrollPaymentSnapshotHash } from "@/lib/payroll/payment-snapshot";
import { payrollJson, requirePayrollActor } from "@/lib/payroll/server";
import { isClosedPayrollMonth } from "@/lib/payroll/payment-period";
import { paymentFailureCodes, validPaymentTargetIds } from "@/lib/payroll/payment-preflight";

export const dynamic="force-dynamic";
const validId=(value:unknown)=>{const id=Number(value);return Number.isSafeInteger(id)&&id>0?id:null};
const validFundAccountId=(value:unknown)=>typeof value==="number"&&Number.isSafeInteger(value)&&value>0?value:null;
const validDate=(value:unknown)=>typeof value==="string"&&/^\d{4}-\d{2}-\d{2}$/.test(value)?value:null;
function fail(message:string){
  if(message.includes("PAYROLL_BATCH_TARGET_MISMATCH"))return payrollJson({ok:false,code:"PAYROLL_BATCH_TARGET_MISMATCH"},409);
  if(message.includes("PAYROLL_INVALID_PAYMENT_REQUEST"))return payrollJson({ok:false,code:"INVALID_PAYMENT"},400);
  if(message.includes("FIRST_MONTH_POLICY_REVIEW_REQUIRED"))return payrollJson({ok:false,code:"FIRST_MONTH_POLICY_REVIEW_REQUIRED"},409);
  if(message.includes("PAYROLL_FUND_ACCOUNT_INVALID"))return payrollJson({ok:false,code:"PAYROLL_FUND_ACCOUNT_INVALID",message:"지급 계좌를 다시 선택해주세요.",messageVi:"Vui lòng chọn lại tài khoản chi trả."},400);
  if(message.includes("PAYROLL_LEDGER_PROJECTION_FAILED")){
    const closed=message.toLowerCase().includes("month_closed");
    return payrollJson({ok:false,code:"PAYROLL_LEDGER_PROJECTION_FAILED",message:closed?"지급일의 장부 월이 이미 마감됐습니다. 지급일을 확인해주세요.":"급여 지급 장부 반영에 실패했습니다.",messageVi:closed?"Tháng sổ cái của ngày chi trả đã được khóa. Vui lòng kiểm tra ngày chi trả.":"Không thể ghi nhận khoản chi trả vào sổ cái."},closed?409:500);
  }
  if(message.includes("PAYROLL_COMPANY_COST_SYNC_FAILED")){console.error("[PAYROLL_COMPANY_COST_SYNC_FAILED]",message);return payrollJson({ok:false,code:"PAYROLL_PAYMENT_FAILED"},500)}
  if(message.includes("ALREADY_PAID"))return payrollJson({ok:false,code:"PAYROLL_EMPLOYEE_ALREADY_PAID"},409);
  if(message.includes("BATCH_COMPLETED"))return payrollJson({ok:false,code:"PAYROLL_BATCH_COMPLETED"},409);
  if(message.includes("REASON_REQUIRED"))return payrollJson({ok:false,code:"PAYROLL_PAYMENT_REASON_REQUIRED"},400);
  if(message.includes("NOT_IN_BATCH"))return payrollJson({ok:false,code:"PAYROLL_EMPLOYEE_NOT_IN_BATCH"},409);
  if(message.includes("MONTH_NOT_CLOSED"))return payrollJson({ok:false,code:"PAYROLL_MONTH_NOT_CLOSED",message:"급여 대상 월이 아직 종료되지 않았습니다.",messageVi:"Tháng lương vẫn chưa kết thúc."},409);
  if(message.includes("BATCH_PREFLIGHT_FAILED"))return payrollJson({ok:false,code:"PAYROLL_BATCH_PREFLIGHT_FAILED"},409);
  return payrollJson({ok:false,code:"PAYROLL_PAYMENT_FAILED"},500);
}


export async function POST(request:Request){
  const auth=await requirePayrollActor();if(auth.response||!auth.actor)return auth.response;
  const body=await request.json().catch(()=>null) as Record<string,unknown>|null;
  const month=validPayrollMonth(typeof body?.month==="string"?body.month:null);const userId=validId(body?.userId);const fundAccountId=validFundAccountId(body?.fundAccountId);const actualPaidAmount=Number(body?.actualPaidAmount);const paymentDate=validDate(body?.paymentDate);const expectedHash=String(body?.calculationHash??"");const differenceReason=String(body?.differenceReason??"").trim();
  if(!fundAccountId)return payrollJson({ok:false,code:"PAYROLL_FUND_ACCOUNT_INVALID",message:"지급 계좌를 다시 선택해주세요.",messageVi:"Vui lòng chọn lại tài khoản chi trả."},400);
  if(!month||!userId||!paymentDate||!Number.isSafeInteger(actualPaidAmount)||actualPaidAmount<1||!expectedHash)return payrollJson({ok:false,code:"INVALID_PAYMENT"},400);
  if(!isClosedPayrollMonth(month))return payrollJson({ok:false,code:"PAYROLL_MONTH_NOT_CLOSED",message:"급여 대상 월이 아직 종료되지 않았습니다.",messageVi:"Tháng lương vẫn chưa kết thúc."},409);
  try{
    const {data:existingBatch,error:batchError}=await supabaseServer.from("payroll_payment_batches").select("id,status").eq("payroll_month",`${month}-01`).maybeSingle();
    if(batchError)throw batchError;
    if(existingBatch?.status==="completed")return fail("PAYROLL_BATCH_COMPLETED");
    const {data:members,error:memberError}=existingBatch
      ?await supabaseServer.from("payroll_employee_payments").select("user_id,payment_status,employee_name,part_snapshot,position_snapshot").eq("payroll_batch_id",existingBatch.id)
      :{data:null,error:null};
    if(memberError)throw memberError;
    if(existingBatch){
      if(!validPaymentTargetIds((members??[]).map(row=>Number(row.user_id)),userId))return fail("PAYROLL_EMPLOYEE_NOT_IN_BATCH");
      if(members!.find(row=>Number(row.user_id)===userId)?.payment_status==="paid")return fail("PAYROLL_EMPLOYEE_ALREADY_PAID");
    }
    const overview=await loadPayrollOverview(month);
    if(!validPaymentTargetIds(overview.employees.map(item=>item.userId),userId))return payrollJson({ok:false,code:"INVALID_PAYMENT_TARGETS"},409);
    const assessed=overview.employees.map(item=>{
      const raw=overview.rawByUser.get(item.userId);
      const calculationDate=typeof raw?.attendanceSnapshot.calculationDate==="string"?raw.attendanceSnapshot.calculationDate:overview.period.asOfDate;
      const activeContractCount=overview.snapshot.context.contracts.filter(contract=>contract.userId===item.userId&&contract.effectiveFrom<=calculationDate&&(!contract.effectiveTo||contract.effectiveTo>calculationDate)).length;
      const failureCodes=paymentFailureCodes(item,raw,activeContractCount);
      return {userId:item.userId,employeeName:item.name,part:item.part,position:item.position,isPayable:failureCodes.length===0,failureCodes};
    });
    const selected=assessed.find(item=>item.userId===userId)!;
    if(!selected.isPayable)return payrollJson({ok:false,code:"PAYROLL_BATCH_PREFLIGHT_FAILED",unavailableEmployeeCount:1,
      employees:[{userId,employeeName:selected.employeeName,reasonCodes:selected.failureCodes}],
      message:"선택 직원의 지급 불가 사유를 먼저 해결해주세요.",messageVi:"Vui lòng xử lý lý do chưa thể chi trả của nhân viên đã chọn."},409);
    // Freeze the complete first roster. For later payments retain that roster,
    // even if a different employee disappears from the live calculation candidates.
    const targets=existingBatch?(members??[]).map(member=>assessed.find(item=>item.userId===Number(member.user_id))??{
      userId:Number(member.user_id),employeeName:member.employee_name,part:member.part_snapshot,position:member.position_snapshot,
      isPayable:false,failureCodes:["MISSING_SNAPSHOT"]}):assessed;
    const employee=overview.employees.find(item=>item.userId===userId)!;
    const raw=overview.rawByUser.get(userId)!;
    const calculationSnapshot=buildEmployeePaymentSnapshot(employee,raw,overview.snapshot.sourceSnapshot as Record<string,unknown>);const calculationHash=payrollPaymentSnapshotHash(calculationSnapshot);
    if(calculationHash!==expectedHash)return payrollJson({ok:false,code:"PAYROLL_CALCULATION_STALE",message:"급여 계산 결과가 변경되었습니다. 다시 확인해주세요.",messageVi:"Kết quả tính lương đã thay đổi. Vui lòng kiểm tra lại."},409);
    if(actualPaidAmount!==employee.amounts.netPayoutAmount&&!differenceReason)return payrollJson({ok:false,code:"PAYROLL_PAYMENT_REASON_REQUIRED"},400);
    const{data,error}=await supabaseServer.rpc("payroll_pay_employee_v3",{p_month:`${month}-01`,p_targets:targets,p_user_id:userId,p_calculation_snapshot:calculationSnapshot,p_calculation_hash:calculationHash,p_calculated_net_amount:employee.amounts.netPayoutAmount,p_actual_paid_amount:actualPaidAmount,p_difference_reason:differenceReason||null,p_payment_date:paymentDate,p_fund_account_id:fundAccountId,p_actor_user_id:auth.actor.id,p_engine_version:overview.snapshot.sourceSnapshot.engineVersion,p_common_settings_snapshot:overview.snapshot.sourceSnapshot,p_director_insurance_amount:overview.directorInsuranceAmount});
    return error?fail(error.message):payrollJson({ok:true,result:data});
  }catch(error){return fail(error instanceof Error?error.message:"PAYROLL_PAYMENT_FAILED")}
}

export async function PATCH(request:Request){
  const auth=await requirePayrollActor();if(auth.response||!auth.actor)return auth.response;
  const body=await request.json().catch(()=>null) as Record<string,unknown>|null;const runId=validId(body?.runId);const userId=validId(body?.userId);const reason=String(body?.reason??"").trim();
  if(!runId||!userId||!reason)return payrollJson({ok:false,code:"INVALID_PAYMENT_CANCELLATION"},400);
  const{data,error}=await supabaseServer.rpc("payroll_cancel_employee_payment_v3",{p_run_id:runId,p_user_id:userId,p_reason:reason,p_actor_user_id:auth.actor.id});
  return error?fail(error.message):payrollJson({ok:true,result:data});
}
