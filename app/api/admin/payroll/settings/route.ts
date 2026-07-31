import { supabaseServer } from "@/lib/supabase/server";
import { payrollJson, requirePayrollActor } from "@/lib/payroll/server";

export const dynamic = "force-dynamic";
const FIELDS = "payment_day,payment_month_offset,employee_insurance_rate_bp,employer_insurance_rate_bp,director_insurance_enabled,director_insurance_base_amount,director_insurance_rate_bp,updated_at,updated_by";

export async function GET() {
  const auth = await requirePayrollActor();
  if (auth.response) return auth.response;
  const { data, error } = await supabaseServer.from("payroll_settings").select(FIELDS).eq("id", 1).single();
  return error ? payrollJson({ ok:false, code:"PAYROLL_SETTINGS_READ_FAILED" },500) : payrollJson({ ok:true, settings:data });
}

export async function PATCH(request: Request) {
  const auth = await requirePayrollActor();
  if (auth.response || !auth.actor) return auth.response;
  const body = await request.json().catch(() => null) as Record<string,unknown> | null;
  if(!body)return payrollJson({ok:false,code:"INVALID_PAYROLL_SETTINGS"},400);
  const allowed=new Set(["paymentDay","employeeInsuranceRateBp","employerInsuranceRateBp","directorInsuranceEnabled","directorInsuranceBaseAmount","directorInsuranceRateBp"]);if(Object.keys(body).some(key=>!allowed.has(key))||!Object.keys(body).some(key=>allowed.has(key)))return payrollJson({ok:false,code:"INVALID_PAYROLL_SETTINGS"},400);
  const{data:current,error:readError}=await supabaseServer.from("payroll_settings").select(FIELDS).eq("id",1).single();if(readError||!current)return payrollJson({ok:false,code:"PAYROLL_SETTINGS_READ_FAILED"},500);
  const update:Record<string,unknown>={updated_at:new Date().toISOString(),updated_by:auth.actor.id};
  if("paymentDay" in body){const paymentDay=Number(body.paymentDay);if(!Number.isInteger(paymentDay)||paymentDay<1||paymentDay>28)return payrollJson({ok:false,code:"INVALID_PAYMENT_DAY"},400);update.payment_day=paymentDay;}
  if("employeeInsuranceRateBp" in (body??{})){const value=Number(body?.employeeInsuranceRateBp);if(!Number.isInteger(value)||value<0||value>10000)return payrollJson({ok:false,code:"INVALID_INSURANCE_SETTINGS"},400);update.employee_insurance_rate_bp=value;}
  if("employerInsuranceRateBp" in (body??{})){const value=Number(body?.employerInsuranceRateBp);if(!Number.isInteger(value)||value<0||value>10000)return payrollJson({ok:false,code:"INVALID_INSURANCE_SETTINGS"},400);update.employer_insurance_rate_bp=value;}
  if("directorInsuranceRateBp" in (body??{})){const value=Number(body?.directorInsuranceRateBp);if(!Number.isInteger(value)||value<0||value>10000)return payrollJson({ok:false,code:"INVALID_INSURANCE_SETTINGS"},400);update.director_insurance_rate_bp=value;}
  if("directorInsuranceBaseAmount" in (body??{})){const value=Number(body?.directorInsuranceBaseAmount);if(!Number.isSafeInteger(value)||value<0)return payrollJson({ok:false,code:"INVALID_INSURANCE_SETTINGS"},400);update.director_insurance_base_amount=value;}
  if("directorInsuranceEnabled" in (body??{})){if(typeof body?.directorInsuranceEnabled!=="boolean")return payrollJson({ok:false,code:"INVALID_INSURANCE_SETTINGS"},400);update.director_insurance_enabled=body.directorInsuranceEnabled;}
  const { data, error } = await supabaseServer.from("payroll_settings").update(update).eq("id",1).select(FIELDS).single();
  return error ? payrollJson({ ok:false, code:"PAYROLL_SETTINGS_UPDATE_FAILED" },500) : payrollJson({ ok:true, settings:data });
}
