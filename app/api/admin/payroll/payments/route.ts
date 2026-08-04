import { supabaseServer } from "@/lib/supabase/server";
import { validPayrollMonth } from "@/lib/payroll/monthly-run";
import { loadPayrollOverview } from "@/lib/payroll/overview-server";
import { buildEmployeePaymentSnapshot, payrollPaymentSnapshotHash } from "@/lib/payroll/payment-snapshot";
import { payrollJson, requirePayrollActor } from "@/lib/payroll/server";
import { isClosedPayrollMonth } from "@/lib/payroll/payment-period";

export const dynamic="force-dynamic";
const validId=(value:unknown)=>{const id=Number(value);return Number.isSafeInteger(id)&&id>0?id:null};
const validDate=(value:unknown)=>typeof value==="string"&&/^\d{4}-\d{2}-\d{2}$/.test(value)?value:null;
function fail(message:string){
  if(message.includes("ALREADY_PAID"))return payrollJson({ok:false,code:"PAYROLL_EMPLOYEE_ALREADY_PAID"},409);
  if(message.includes("BATCH_COMPLETED"))return payrollJson({ok:false,code:"PAYROLL_BATCH_COMPLETED"},409);
  if(message.includes("REASON_REQUIRED"))return payrollJson({ok:false,code:"PAYROLL_PAYMENT_REASON_REQUIRED"},400);
  if(message.includes("NOT_IN_BATCH"))return payrollJson({ok:false,code:"PAYROLL_EMPLOYEE_NOT_IN_BATCH"},409);
  if(message.includes("MONTH_NOT_CLOSED"))return payrollJson({ok:false,code:"PAYROLL_MONTH_NOT_CLOSED",message:"급여 대상 월이 아직 종료되지 않았습니다.",messageVi:"Tháng lương vẫn chưa kết thúc."},409);
  if(message.includes("BATCH_PREFLIGHT_FAILED"))return payrollJson({ok:false,code:"PAYROLL_BATCH_PREFLIGHT_FAILED"},409);
  return payrollJson({ok:false,code:"PAYROLL_PAYMENT_FAILED"},500);
}
function paymentFailureCodes(employee:Awaited<ReturnType<typeof loadPayrollOverview>>["employees"][number],activeContractCount:number,blockingCodes:string[]){const codes:string[]=[];if(activeContractCount===0)codes.push("MISSING_CONTRACT");if(activeContractCount>1)codes.push("CONTRACT_OVERLAP");if(employee.amounts.currentAmount===null||!Number.isSafeInteger(employee.amounts.netPayoutAmount))codes.push("NET_AMOUNT_UNAVAILABLE");codes.push(...blockingCodes);return[...new Set(codes)]}

export async function POST(request:Request){
  const auth=await requirePayrollActor();if(auth.response||!auth.actor)return auth.response;
  const body=await request.json().catch(()=>null) as Record<string,unknown>|null;
  const month=validPayrollMonth(typeof body?.month==="string"?body.month:null);const userId=validId(body?.userId);const actualPaidAmount=Number(body?.actualPaidAmount);const paymentDate=validDate(body?.paymentDate);const expectedHash=String(body?.calculationHash??"");const differenceReason=String(body?.differenceReason??"").trim();
  if(!month||!userId||!paymentDate||!Number.isSafeInteger(actualPaidAmount)||actualPaidAmount<1||!expectedHash)return payrollJson({ok:false,code:"INVALID_PAYMENT"},400);
  if(!isClosedPayrollMonth(month))return payrollJson({ok:false,code:"PAYROLL_MONTH_NOT_CLOSED",message:"급여 대상 월이 아직 종료되지 않았습니다.",messageVi:"Tháng lương vẫn chưa kết thúc."},409);
  try{
    const overview=await loadPayrollOverview(month);const employee=overview.employees.find(item=>item.userId===userId);const raw=overview.rawByUser.get(userId);
    if(!employee||!raw||employee.amounts.currentAmount===null)return payrollJson({ok:false,code:"PAYROLL_EMPLOYEE_NOT_CALCULABLE"},409);
    const{data:existingBatch,error:batchError}=await supabaseServer.from("payroll_payment_batches").select("id").eq("payroll_month",`${month}-01`).maybeSingle();if(batchError)throw batchError;
    const preflightFailures=existingBatch?[]:overview.employees.flatMap(item=>{const activeContractCount=overview.snapshot.context.contracts.filter(contract=>contract.userId===item.userId&&contract.effectiveFrom<=overview.period.asOfDate&&(!contract.effectiveTo||contract.effectiveTo>overview.period.asOfDate)).length;const blockingCodes=(overview.rawByUser.get(item.userId)?.reviews??[]).filter(review=>review.reviewLevel==="blocking").map(review=>review.warningCode);const reasonCodes=paymentFailureCodes(item,activeContractCount,blockingCodes);return reasonCodes.length?[{userId:item.userId,employeeName:item.name,reasonCodes}]:[]});
    if(!existingBatch&&(overview.employees.length===0||preflightFailures.length>0))return payrollJson({ok:false,code:"PAYROLL_BATCH_PREFLIGHT_FAILED",unavailableEmployeeCount:preflightFailures.length,employees:preflightFailures,message:"지급 불가 직원을 먼저 수정해주세요.",messageVi:"Vui lòng sửa thông tin của nhân viên chưa thể chi trả trước."},409);
    const calculationSnapshot=buildEmployeePaymentSnapshot(employee,raw,overview.snapshot.sourceSnapshot as Record<string,unknown>);const calculationHash=payrollPaymentSnapshotHash(calculationSnapshot);
    if(calculationHash!==expectedHash)return payrollJson({ok:false,code:"PAYROLL_CALCULATION_STALE",message:"급여 계산 결과가 변경되었습니다. 다시 확인해주세요.",messageVi:"Kết quả tính lương đã thay đổi. Vui lòng kiểm tra lại."},409);
    if(actualPaidAmount!==employee.amounts.netPayoutAmount&&!differenceReason)return payrollJson({ok:false,code:"PAYROLL_PAYMENT_REASON_REQUIRED"},400);
    const targets=overview.employees.map(item=>({userId:item.userId,employeeName:item.name,part:item.part,position:item.position,isPayable:true,failureCodes:[]}));
    const{data,error}=await supabaseServer.rpc("payroll_pay_employee_v1",{p_month:`${month}-01`,p_targets:targets,p_user_id:userId,p_calculation_snapshot:calculationSnapshot,p_calculation_hash:calculationHash,p_calculated_net_amount:employee.amounts.netPayoutAmount,p_actual_paid_amount:actualPaidAmount,p_difference_reason:differenceReason||null,p_payment_date:paymentDate,p_actor_user_id:auth.actor.id,p_engine_version:overview.snapshot.sourceSnapshot.engineVersion,p_common_settings_snapshot:overview.snapshot.sourceSnapshot,p_director_insurance_amount:overview.directorInsuranceAmount});
    return error?fail(error.message):payrollJson({ok:true,result:data});
  }catch(error){return fail(error instanceof Error?error.message:"PAYROLL_PAYMENT_FAILED")}
}

export async function PATCH(request:Request){
  const auth=await requirePayrollActor();if(auth.response||!auth.actor)return auth.response;
  const body=await request.json().catch(()=>null) as Record<string,unknown>|null;const runId=validId(body?.runId);const userId=validId(body?.userId);const reason=String(body?.reason??"").trim();
  if(!runId||!userId||!reason)return payrollJson({ok:false,code:"INVALID_PAYMENT_CANCELLATION"},400);
  const{data,error}=await supabaseServer.rpc("payroll_cancel_employee_payment_v1",{p_run_id:runId,p_user_id:userId,p_reason:reason,p_actor_user_id:auth.actor.id});
  return error?fail(error.message):payrollJson({ok:true,result:data});
}
