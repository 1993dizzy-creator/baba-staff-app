import { supabaseServer } from "@/lib/supabase/server";
import { validPayrollMonth } from "@/lib/payroll/monthly-run";
import { loadPayrollOverview } from "@/lib/payroll/overview-server";
import { payrollJson, requirePayrollActor } from "@/lib/payroll/server";
import { paidExtraWorkAmount, paidExtraWorkRows } from "@/lib/payroll/paid-extra-work";

export const dynamic = "force-dynamic";

const validId = (value: unknown) => {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

async function paidPaymentsByUser(month: string) {
  const { data: batch, error: batchError } = await supabaseServer
    .from("payroll_payment_batches").select("id").eq("payroll_month", `${month}-01`).maybeSingle();
  if (batchError) throw batchError;
  if (!batch) return new Map<number, Record<string, unknown>>();
  const { data, error } = await supabaseServer.from("payroll_employee_payments")
    .select("user_id,calculation_snapshot").eq("payroll_batch_id", batch.id).eq("payment_status", "paid");
  if (error) throw error;
  return new Map((data ?? []).map(row => [Number(row.user_id), row]));
}

export async function GET(request: Request) {
  const auth = await requirePayrollActor();
  if (auth.response) return auth.response;
  const url = new URL(request.url);
  const month = validPayrollMonth(url.searchParams.get("month"));
  const rawUserId = url.searchParams.get("userId");
  const userId = rawUserId === null ? undefined : validId(rawUserId) ?? undefined;
  if (!month || (rawUserId !== null && userId === undefined)) return payrollJson({ ok: false, code: "INVALID_EXTRA_WORK_QUERY" }, 400);
  try {
    const [overview, paid] = await Promise.all([loadPayrollOverview(month, { userId }), paidPaymentsByUser(month)]);
    const employees = overview.employees.filter(employee => employee.contract && employee.contract.calculationBasis !== "fixed_monthly").map(employee => {
      const paidPayment = paid.get(employee.userId);
      const snapshot = paidPayment?.calculation_snapshot as Record<string, unknown> | null | undefined;
      const candidates = paidPayment ? paidExtraWorkRows(snapshot ?? null) : employee.partTimeExtraWork;
      return {
      userId: employee.userId,
      name: employee.name,
      paid: Boolean(paidPayment),
      summary: {
        candidateMinutes: candidates.reduce((sum, row) => sum + row.candidateMinutes, 0),
        approvedMinutes: candidates.filter(row => row.status === "approved").reduce((sum, row) => sum + row.candidateMinutes, 0),
        approvedAmount: paidPayment ? paidExtraWorkAmount(snapshot ?? null) : employee.amounts.partTimeExtraWorkAmount,
        reviewRequiredCount: candidates.filter(row => row.status === "review_required" || row.status === "stale").length,
      },
      candidates,
    };});
    return payrollJson({ ok: true, month, employees });
  } catch {
    return payrollJson({ ok: false, code: "PAYROLL_EXTRA_WORK_READ_FAILED" }, 500);
  }
}

export async function POST(request: Request) {
  const auth = await requirePayrollActor();
  if (auth.response || !auth.actor) return auth.response;
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const month = validPayrollMonth(typeof body?.month === "string" ? body.month : null);
  const attendanceRecordId = validId(body?.attendanceRecordId);
  const decision = body?.decision === "approved" || body?.decision === "rejected" ? body.decision : null;
  const sourceHash = typeof body?.sourceHash === "string" && /^[a-f0-9]{64}$/.test(body.sourceHash) ? body.sourceHash : null;
  const decisionReason = typeof body?.decisionReason === "string" ? body.decisionReason.trim() || null : null;
  if (!month || !attendanceRecordId || !decision || !sourceHash) return payrollJson({ ok: false, code: "INVALID_EXTRA_WORK_DECISION" }, 400);
  try {
    const overview = await loadPayrollOverview(month);
    const candidate = overview.employees.flatMap(employee => employee.partTimeExtraWork).find(row => row.attendanceRecordId === attendanceRecordId);
    if (!candidate) return payrollJson({ ok: false, code: "PAYROLL_EXTRA_WORK_NOT_FOUND" }, 404);
    if (candidate.sourceHash !== sourceHash) return payrollJson({ ok: false, code: "PAYROLL_EXTRA_WORK_STALE", current: candidate }, 409);
    const { data, error } = await supabaseServer.rpc("payroll_admin_set_part_time_extra_work_decision_v1", {
      p_payroll_month: `${month}-01`,
      p_attendance_record_id: attendanceRecordId,
      p_user_id: candidate.userId,
      p_business_date: candidate.businessDate,
      p_decision: decision,
      p_candidate_minutes: candidate.candidateMinutes,
      p_candidate_amount: candidate.candidateAmount,
      p_hourly_rate_amount: candidate.hourlyRateAmount,
      p_before_schedule_minutes: candidate.beforeScheduleMinutes,
      p_after_schedule_minutes: candidate.afterScheduleMinutes,
      p_excluded_before_open_minutes: candidate.excludedBeforeOpenMinutes,
      p_excluded_after_close_minutes: candidate.excludedAfterCloseMinutes,
      p_schedule_start_time: candidate.scheduleStartTime,
      p_schedule_end_time: candidate.scheduleEndTime,
      p_store_open_time: candidate.storeOpenTime,
      p_store_close_time: candidate.storeCloseTime,
      p_source_hash: candidate.sourceHash,
      p_source_snapshot: candidate.sourceSnapshot,
      p_decision_reason: decisionReason,
      p_actor_user_id: auth.actor.id,
    });
    if (error) {
      if (error.message.includes("PAID")) return payrollJson({ ok: false, code: "PAYROLL_EMPLOYEE_ALREADY_PAID" }, 409);
      if (error.message.includes("FORBIDDEN")) return payrollJson({ ok: false, code: "FORBIDDEN" }, 403);
      throw error;
    }
    return payrollJson({ ok: true, decision: data });
  } catch {
    return payrollJson({ ok: false, code: "PAYROLL_EXTRA_WORK_DECISION_FAILED" }, 500);
  }
}

export async function DELETE(request: Request) {
  const auth = await requirePayrollActor();
  if (auth.response || !auth.actor) return auth.response;
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const attendanceRecordId = validId(body?.attendanceRecordId);
  const cancellationReason = typeof body?.cancellationReason === "string" ? body.cancellationReason.trim() : "";
  if (!attendanceRecordId || !cancellationReason) return payrollJson({ ok: false, code: "INVALID_EXTRA_WORK_CANCELLATION" }, 400);
  const { data, error } = await supabaseServer.rpc("payroll_admin_cancel_part_time_extra_work_decision_v1", {
      p_attendance_record_id: attendanceRecordId,
      p_reason: cancellationReason,
    p_actor_user_id: auth.actor.id,
  });
  if (error) {
    if (error.message.includes("PAID")) return payrollJson({ ok: false, code: "PAYROLL_EMPLOYEE_ALREADY_PAID" }, 409);
    if (error.message.includes("FORBIDDEN")) return payrollJson({ ok: false, code: "FORBIDDEN" }, 403);
    return payrollJson({ ok: false, code: "PAYROLL_EXTRA_WORK_CANCELLATION_FAILED" }, 500);
  }
  return payrollJson({ ok: true, decision: data });
}
