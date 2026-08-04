import { supabaseServer } from "@/lib/supabase/server";
import { payrollJson, requirePayrollActor } from "@/lib/payroll/server";
import { validPayrollMonth } from "@/lib/payroll/monthly-run";

export const dynamic = "force-dynamic";
const KINDS = new Set(["incentive", "penalty"]);
const CATEGORIES = new Set(["sales","performance","service","late","early_leave","absence","damage","discipline","manual","other"]);
function id(value: unknown) { const result=Number(value);return Number.isSafeInteger(result)&&result>0?result:null; }
function dateInMonth(value: unknown, month: string) { if(typeof value!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!value.startsWith(`${month}-`))return null;const[y,m,d]=value.split("-").map(Number);const parsed=new Date(Date.UTC(y,m-1,d));return parsed.toISOString().slice(0,10)===value?value:null; }
function adjustmentError(message:string, fallback:string){return message.includes("PAYROLL_ADJUSTMENT_LOCKED_FOR_PAID_EMPLOYEE")?payrollJson({ok:false,code:"PAYROLL_ADJUSTMENT_LOCKED_FOR_PAID_EMPLOYEE"},409):payrollJson({ok:false,code:fallback},500)}

export async function GET(request: Request) {
  const auth=await requirePayrollActor();if(auth.response)return auth.response;
  const url=new URL(request.url);const month=validPayrollMonth(url.searchParams.get("month"));const userId=id(url.searchParams.get("userId"));
  if(!month)return payrollJson({ok:false,code:"INVALID_MONTH"},400);
  let query=supabaseServer.from("payroll_monthly_adjustments").select("id,user_id,payroll_month,kind,category,amount,business_date,reason,note,created_by,created_at,cancelled_at,cancelled_by,cancellation_reason").eq("payroll_month",`${month}-01`).order("business_date").order("id");
  if(userId)query=query.eq("user_id",userId);const{data,error}=await query;
  return error?payrollJson({ok:false,code:"PAYROLL_ADJUSTMENT_READ_FAILED"},500):payrollJson({ok:true,adjustments:data??[]});
}

export async function POST(request: Request) {
  const auth=await requirePayrollActor();if(auth.response||!auth.actor)return auth.response;
  const body=await request.json().catch(()=>null) as Record<string,unknown>|null;const month=validPayrollMonth(typeof body?.month==="string"?body.month:null);const userId=id(body?.userId);const amount=Number(body?.amount);const kind=String(body?.kind??"");const category=String(body?.category??"");const reason=String(body?.reason??"").trim();
  if(!month||!userId||!KINDS.has(kind)||!CATEGORIES.has(category)||!Number.isSafeInteger(amount)||amount<1||!dateInMonth(body?.businessDate,month)||!reason)return payrollJson({ok:false,code:"INVALID_ADJUSTMENT"},400);
  const{data:target}=await supabaseServer.from("users").select("id").eq("id",userId).eq("is_system_account",false).maybeSingle();if(!target)return payrollJson({ok:false,code:"USER_NOT_FOUND"},404);
  const{data,error}=await supabaseServer.from("payroll_monthly_adjustments").insert({user_id:userId,payroll_month:`${month}-01`,kind,category,amount,business_date:body!.businessDate,reason,note:String(body?.note??"").trim()||null,source_type:"manual",created_by:auth.actor.id}).select().single();
  return error?adjustmentError(error.message,"PAYROLL_ADJUSTMENT_CREATE_FAILED"):payrollJson({ok:true,adjustment:data},201);
}

export async function PATCH(request: Request) {
  const auth=await requirePayrollActor();if(auth.response||!auth.actor)return auth.response;
  const body=await request.json().catch(()=>null) as Record<string,unknown>|null;const adjustmentId=id(body?.id);const reason=String(body?.cancellationReason??"").trim();if(!adjustmentId||!reason)return payrollJson({ok:false,code:"INVALID_CANCELLATION"},400);
  const{data,error}=await supabaseServer.from("payroll_monthly_adjustments").update({cancelled_at:new Date().toISOString(),cancelled_by:auth.actor.id,cancellation_reason:reason}).eq("id",adjustmentId).is("cancelled_at",null).select().maybeSingle();
  if(error)return adjustmentError(error.message,"PAYROLL_ADJUSTMENT_CANCEL_FAILED");return data?payrollJson({ok:true,adjustment:data}):payrollJson({ok:false,code:"ADJUSTMENT_NOT_ACTIVE"},409);
}
