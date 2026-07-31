import { loadPayrollMonthSnapshot } from "@/lib/payroll/monthly-run";
import { payrollRpcVersion, payrollRunActionGuard } from "@/lib/payroll/rpc-version";
import { payrollJson, requirePayrollActor } from "@/lib/payroll/server";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
function validId(value: string) { const id = Number(value); return Number.isSafeInteger(id) && id > 0 ? id : null; }
function failed(message: string) {
  if (message.includes("PAYROLL_PENALTY_SNAPSHOT_STALE")) return payrollJson({ ok: false, code: "PAYROLL_PENALTY_SNAPSHOT_STALE", message: "급여 초안 생성 후 근태 패널티 설정이 변경되었습니다. 급여를 재계산한 뒤 확정해주세요.", messageVi: "Cài đặt phạt chấm công đã thay đổi sau khi tạo bản nháp. Vui lòng tính lại bảng lương trước khi chốt." }, 409);
  if (message.includes("PAYROLL_INSURANCE_SNAPSHOT_STALE")) return payrollJson({ ok: false, code: "PAYROLL_INSURANCE_SNAPSHOT_STALE", message: "급여 초안 생성 후 보험 설정이 변경되었습니다. 급여를 재계산한 뒤 확정해주세요.", messageVi: "Cài đặt bảo hiểm đã thay đổi sau khi tạo bản nháp. Vui lòng tính lại bảng lương trước khi chốt." }, 409);
  if (message.includes("LOCKED")) return payrollJson({ ok: false, code: "RUN_LOCKED", message: "현재 상태에서는 급여 장부를 변경할 수 없습니다." }, 409);
  if (message.includes("OPEN_REVIEWS")) return payrollJson({ ok: false, code: "OPEN_REVIEWS", message: "확인 필요 항목을 모두 처리한 뒤 확정해주세요." }, 409);
  if (message.includes("FORCE_NOT_REQUIRED")) return payrollJson({ ok: false, code: "FORCE_NOT_REQUIRED", message: "미해결 차단 항목이 없어 일반 확정을 사용해야 합니다." }, 400);
  if (message.includes("REASON_REQUIRED")) return payrollJson({ ok: false, code: "REASON_REQUIRED", message: "처리 사유를 입력해주세요." }, 400);
  return payrollJson({ ok: false, code: "RUN_ACTION_FAILED", message: "급여 장부 요청을 처리하지 못했습니다." }, 500);
}

export async function GET(_request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const auth = await requirePayrollActor(); if (auth.response) return auth.response;
  const runId = validId((await params).runId);
  if (!runId) return payrollJson({ ok: false, code: "INVALID_RUN_ID", message: "올바르지 않은 급여 장부입니다." }, 400);
  const { data: employees, error: employeeError } = await supabaseServer.from("payroll_run_employees").select("*").eq("payroll_run_id", runId).order("employee_name");
  const employeeIds = (employees ?? []).map(row => row.id);
  const [{ data: run, error }, { data: items, error: itemError }, { data: reviews, error: reviewError }, { data: audit, error: auditError }] = await Promise.all([
    supabaseServer.from("payroll_runs").select("*").eq("id", runId).maybeSingle(),
    supabaseServer.from("payroll_run_items").select("*").in("payroll_run_employee_id", employeeIds.length ? employeeIds : [-1]).order("id"),
    supabaseServer.from("payroll_run_reviews").select("*").in("payroll_run_employee_id", employeeIds.length ? employeeIds : [-1]).order("business_date"),
    supabaseServer.from("payroll_run_audit_logs").select("*").eq("payroll_run_id", runId).order("created_at", { ascending: false }),
  ]);
  if (error || employeeError || itemError || reviewError || auditError) return payrollJson({ ok: false, code: "PAYROLL_RUN_READ_FAILED", message: "급여 장부를 불러오지 못했습니다." }, 500);
  if (!run) return payrollJson({ ok: false, code: "RUN_NOT_FOUND", message: "급여 장부를 찾을 수 없습니다." }, 404);
  return payrollJson({ ok: true, run, employees: employees ?? [], items: items ?? [], reviews: reviews ?? [], audit: audit ?? [] });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const auth = await requirePayrollActor(); if (auth.response || !auth.actor) return auth.response;
  const runId = validId((await params).runId);
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!runId || !body || typeof body.action !== "string") return payrollJson({ ok: false, code: "INVALID_ACTION", message: "올바르지 않은 요청입니다." }, 400);
  try {
    const { data: run, error: readError } = await supabaseServer.from("payroll_runs").select("payroll_month,status,engine_version").eq("id", runId).maybeSingle();
    if (readError || !run) return payrollJson({ ok: false, code: "RUN_NOT_FOUND", message: "급여 장부를 찾을 수 없습니다." }, 404);
    const rpcVersion = payrollRpcVersion(run.engine_version);
    if (body.action === "recalculate") {
      if (run.status !== "draft") return payrollJson({ ok: false, code: "RUN_LOCKED", message: "초안 상태에서만 재계산할 수 있습니다." }, 409);
      const guard = payrollRunActionGuard(run.engine_version, body.action);
      if (guard === "PAYROLL_LEGACY_RUN_RECALC_UNSUPPORTED") return payrollJson({ ok: false, code: guard, message: "이 장부는 이전 급여 계산 기준으로 생성되어 현재 방식으로 재계산할 수 없습니다.\n새 급여 장부를 생성해주세요.", messageVi: "Bảng lương này được tạo theo cách tính cũ nên không thể tính lại theo cách hiện tại.\nVui lòng tạo bảng lương mới." }, 409);
      if (guard || rpcVersion !== "v4") return payrollJson({ ok: false, code: "PAYROLL_ENGINE_VERSION_UNSUPPORTED", message: "지원하지 않는 급여 계산 엔진입니다.", messageVi: "Phiên bản công cụ tính lương này không được hỗ trợ." }, 409);
      const snapshot = await loadPayrollMonthSnapshot(String(run.payroll_month).slice(0, 7));
      const args = { p_run_id: runId, p_calculated_at: snapshot.sourceSnapshot.calculatedAt, p_engine_version: snapshot.sourceSnapshot.engineVersion, p_source_snapshot: snapshot.sourceSnapshot, p_employees: snapshot.employees, p_actor_user_id: auth.actor.id };
      const { data, error } = await supabaseServer.rpc("payroll_recalculate_run_v4", args);
      if (error) return failed(error.message);
      const replacementRunId = Number(data);
      return Number.isSafeInteger(replacementRunId) && replacementRunId > 0 ? payrollJson({ ok: true, replacementRunId }) : failed("INVALID_RPC_RESULT");
    }
    const guard = payrollRunActionGuard(run.engine_version, body.action);
    if (guard === "PAYROLL_LEGACY_RUN_UNFINALIZE_UNSUPPORTED") return payrollJson({ ok: false, code: guard, message: "이전 기준으로 생성된 급여 장부는 확정을 취소할 수 없습니다.", messageVi: "Không thể hủy chốt bảng lương được tạo theo cách tính cũ." }, 409);
    if (guard || !rpcVersion) return payrollJson({ ok: false, code: "PAYROLL_ENGINE_VERSION_UNSUPPORTED", message: "지원하지 않는 급여 계산 엔진입니다.", messageVi: "Phiên bản công cụ tính lương này không được hỗ trợ." }, 409);
    const args = { p_run_id: runId, p_action: body.action, p_reason: body.reason ?? null, p_payment_date: body.paymentDate ?? null, p_payment_method: body.paymentMethod ?? null, p_payment_note: body.paymentNote ?? null, p_actor_user_id: auth.actor.id };
    const { error } = rpcVersion === "v4" ? await supabaseServer.rpc("payroll_transition_run_v4", args) : await supabaseServer.rpc("payroll_transition_run_v3", args);
    if (error) return failed(error.message);
    return payrollJson({ ok: true });
  } catch (error) { return failed(error instanceof Error ? error.message : "RUN_ACTION_FAILED"); }
}
