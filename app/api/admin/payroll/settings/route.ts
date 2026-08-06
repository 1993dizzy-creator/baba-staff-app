import { supabaseServer } from "@/lib/supabase/server";
import { payrollJson, requirePayrollActor } from "@/lib/payroll/server";

export const dynamic = "force-dynamic";
const FIELDS = "payment_day,payment_month_offset,employee_insurance_rate_bp,employer_insurance_rate_bp,director_insurance_enabled,director_insurance_base_amount,director_insurance_rate_bp,late_major_threshold_minutes,late_minor_penalty_minutes,late_major_penalty_rate_bp,unauthorized_absence_penalty_days,updated_at,updated_by";

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
  const allowed=new Set(["paymentDay","employeeInsuranceRateBp","employerInsuranceRateBp","directorInsuranceEnabled","directorInsuranceBaseAmount","directorInsuranceRateBp","lateMajorThresholdMinutes","lateMinorPenaltyMinutes","lateMajorPenaltyRateBp","unauthorizedAbsencePenaltyDays"]);if(Object.keys(body).some(key=>!allowed.has(key))||!Object.keys(body).some(key=>allowed.has(key)))return payrollJson({ok:false,code:"INVALID_PAYROLL_SETTINGS"},400);
  const{data:current,error:readError}=await supabaseServer.from("payroll_settings").select(FIELDS).eq("id",1).single();if(readError||!current)return payrollJson({ok:false,code:"PAYROLL_SETTINGS_READ_FAILED"},500);
  const update:Record<string,unknown>={updated_at:new Date().toISOString(),updated_by:auth.actor.id};
  if("paymentDay" in body){const paymentDay=Number(body.paymentDay);if(!Number.isInteger(paymentDay)||paymentDay<1||paymentDay>28)return payrollJson({ok:false,code:"INVALID_PAYMENT_DAY"},400);update.payment_day=paymentDay;}
  if("employeeInsuranceRateBp" in (body??{})){const value=Number(body?.employeeInsuranceRateBp);if(!Number.isInteger(value)||value<0||value>10000)return payrollJson({ok:false,code:"INVALID_INSURANCE_SETTINGS"},400);update.employee_insurance_rate_bp=value;}
  if("employerInsuranceRateBp" in (body??{})){const value=Number(body?.employerInsuranceRateBp);if(!Number.isInteger(value)||value<0||value>10000)return payrollJson({ok:false,code:"INVALID_INSURANCE_SETTINGS"},400);update.employer_insurance_rate_bp=value;}
  if("directorInsuranceRateBp" in (body??{})){const value=Number(body?.directorInsuranceRateBp);if(!Number.isInteger(value)||value<0||value>10000)return payrollJson({ok:false,code:"INVALID_INSURANCE_SETTINGS"},400);update.director_insurance_rate_bp=value;}
  if("directorInsuranceBaseAmount" in (body??{})){const value=Number(body?.directorInsuranceBaseAmount);if(!Number.isSafeInteger(value)||value<0)return payrollJson({ok:false,code:"INVALID_INSURANCE_SETTINGS"},400);update.director_insurance_base_amount=value;}
  if("directorInsuranceEnabled" in (body??{})){if(typeof body?.directorInsuranceEnabled!=="boolean")return payrollJson({ok:false,code:"INVALID_INSURANCE_SETTINGS"},400);update.director_insurance_enabled=body.directorInsuranceEnabled;}
  for(const [key,column,min,max] of [
    ["lateMajorThresholdMinutes","late_major_threshold_minutes",1,1440],
    ["lateMinorPenaltyMinutes","late_minor_penalty_minutes",1,1440],
    ["lateMajorPenaltyRateBp","late_major_penalty_rate_bp",0,10000],
    ["unauthorizedAbsencePenaltyDays","unauthorized_absence_penalty_days",1,31],
  ] as const){if(key in body){const value=Number(body[key]);if(!Number.isInteger(value)||value<min||value>max)return payrollJson({ok:false,code:"INVALID_PENALTY_SETTINGS"},400);update[column]=value;}}
  const { data, error } = await supabaseServer.from("payroll_settings").update(update).eq("id",1).select(FIELDS).single();
  return error ? payrollJson({ ok:false, code:"PAYROLL_SETTINGS_UPDATE_FAILED" },500) : payrollJson({ ok:true, settings:data });
}

// PATCH(위)는 기존 부분 업데이트 경로로 그대로 유지한다(RPC 없이 payroll_settings를 직접
// update). PUT은 공통 설정 화면이 저장 버튼 한 번으로 payroll_settings와 식대 공통 정책을
// 함께(하나의 transaction으로) 저장하기 위한 새 원자적 경로다 —
// payroll_update_common_settings_v1 RPC를 호출하며, 이 RPC가 실패하면 payroll_settings도
// 식대 정책도 전혀 바뀌지 않는다.
export async function PUT(request: Request) {
  const auth = await requirePayrollActor();
  if (auth.response || !auth.actor) return auth.response;
  const body = await request.json().catch(() => null) as Record<string,unknown> | null;
  if (!body) return payrollJson({ ok:false, code:"INVALID_PAYROLL_SETTINGS" }, 400);

  const paymentDay = Number(body.paymentDay);
  const employeeInsuranceRateBp = Number(body.employeeInsuranceRateBp);
  const employerInsuranceRateBp = Number(body.employerInsuranceRateBp);
  const directorInsuranceEnabled = body.directorInsuranceEnabled;
  const directorInsuranceBaseAmount = Number(body.directorInsuranceBaseAmount);
  const directorInsuranceRateBp = Number(body.directorInsuranceRateBp);
  const lateMajorThresholdMinutes = Number(body.lateMajorThresholdMinutes);
  const lateMinorPenaltyMinutes = Number(body.lateMinorPenaltyMinutes);
  const lateMajorPenaltyRateBp = Number(body.lateMajorPenaltyRateBp);
  const unauthorizedAbsencePenaltyDays = Number(body.unauthorizedAbsencePenaltyDays);
  const mealDailyAmountRaw = body.mealDailyAmount;
  const mealEffectiveFromRaw = body.mealEffectiveFrom;

  if (
    !Number.isInteger(paymentDay) || paymentDay < 1 || paymentDay > 28 ||
    !Number.isInteger(employeeInsuranceRateBp) || employeeInsuranceRateBp < 0 || employeeInsuranceRateBp > 10000 ||
    !Number.isInteger(employerInsuranceRateBp) || employerInsuranceRateBp < 0 || employerInsuranceRateBp > 10000 ||
    typeof directorInsuranceEnabled !== "boolean" ||
    !Number.isSafeInteger(directorInsuranceBaseAmount) || directorInsuranceBaseAmount < 0 ||
    !Number.isInteger(directorInsuranceRateBp) || directorInsuranceRateBp < 0 || directorInsuranceRateBp > 10000 ||
    !Number.isInteger(lateMajorThresholdMinutes) || lateMajorThresholdMinutes < 1 || lateMajorThresholdMinutes > 1440 ||
    !Number.isInteger(lateMinorPenaltyMinutes) || lateMinorPenaltyMinutes < 1 || lateMinorPenaltyMinutes > 1440 ||
    !Number.isInteger(lateMajorPenaltyRateBp) || lateMajorPenaltyRateBp < 0 || lateMajorPenaltyRateBp > 10000 ||
    !Number.isInteger(unauthorizedAbsencePenaltyDays) || unauthorizedAbsencePenaltyDays < 1 || unauthorizedAbsencePenaltyDays > 31
  ) return payrollJson({ ok:false, code:"INVALID_PAYROLL_SETTINGS" }, 400);

  // 식대: 금액·적용일은 함께 입력되거나 함께 비어 있어야 한다(둘 다 null = 식대 미변경).
  const mealBothBlank = (mealDailyAmountRaw === null || mealDailyAmountRaw === undefined)
    && (mealEffectiveFromRaw === null || mealEffectiveFromRaw === undefined || mealEffectiveFromRaw === "");
  const mealBothFilled = mealDailyAmountRaw !== null && mealDailyAmountRaw !== undefined
    && typeof mealEffectiveFromRaw === "string" && mealEffectiveFromRaw !== "";
  if (!mealBothBlank && !mealBothFilled) {
    return payrollJson({ ok:false, code:"INVALID_MEAL_ALLOWANCE_POLICY" }, 400);
  }
  const mealDailyAmount = mealBothFilled ? Number(mealDailyAmountRaw) : null;
  const mealEffectiveFrom = mealBothFilled ? String(mealEffectiveFromRaw) : null;
  if (mealBothFilled && (!Number.isSafeInteger(mealDailyAmount) || mealDailyAmount! < 0 || !/^\d{4}-\d{2}-\d{2}$/.test(mealEffectiveFrom!))) {
    return payrollJson({ ok:false, code:"MEAL_ALLOWANCE_INVALID_AMOUNT" }, 400);
  }

  const { data, error } = await supabaseServer.rpc("payroll_update_common_settings_v1", {
    p_actor_user_id: auth.actor.id,
    p_payment_day: paymentDay,
    p_employee_insurance_rate_bp: employeeInsuranceRateBp,
    p_employer_insurance_rate_bp: employerInsuranceRateBp,
    p_director_insurance_enabled: directorInsuranceEnabled,
    p_director_insurance_base_amount: directorInsuranceBaseAmount,
    p_director_insurance_rate_bp: directorInsuranceRateBp,
    p_late_major_threshold_minutes: lateMajorThresholdMinutes,
    p_late_minor_penalty_minutes: lateMinorPenaltyMinutes,
    p_late_major_penalty_rate_bp: lateMajorPenaltyRateBp,
    p_unauthorized_absence_penalty_days: unauthorizedAbsencePenaltyDays,
    p_meal_daily_amount: mealDailyAmount,
    p_meal_effective_from: mealEffectiveFrom,
  });
  if (error) {
    const status = error.message.includes("PAYROLL_FORBIDDEN") ? 403 : 400;
    const code = error.message.includes("PAYROLL_FORBIDDEN") ? "FORBIDDEN"
      : error.message.includes("INVALID_PAYMENT_DAY") ? "INVALID_PAYMENT_DAY"
      : error.message.includes("INVALID_INSURANCE_SETTINGS") ? "INVALID_INSURANCE_SETTINGS"
      : error.message.includes("INVALID_PENALTY_SETTINGS") ? "INVALID_PENALTY_SETTINGS"
      : error.message.includes("MEAL_ALLOWANCE_INVALID_AMOUNT") ? "MEAL_ALLOWANCE_INVALID_AMOUNT"
      : error.message.includes("INVALID_MEAL_ALLOWANCE_POLICY") ? "INVALID_MEAL_ALLOWANCE_POLICY"
      : "PAYROLL_SETTINGS_UPDATE_FAILED";
    return payrollJson({ ok:false, code }, status);
  }
  const result = data as { settings: Record<string, unknown>; mealPolicyChanged: boolean; mealPolicy: Record<string, unknown> | null };
  return payrollJson({ ok:true, settings: result.settings, mealPolicyChanged: result.mealPolicyChanged, mealPolicy: result.mealPolicy });
}
