import { payrollRpcVersion } from "@/lib/payroll/rpc-version";
import { payrollJson, requirePayrollActor } from "@/lib/payroll/server";
import { supabaseServer } from "@/lib/supabase/server";

export async function POST(request: Request, { params }: { params: Promise<{ runId: string; employeeId: string }> }) {
  const auth = await requirePayrollActor();
  if (auth.response || !auth.actor) return auth.response;
  const route = await params;
  const runId = Number(route.runId), employeeId = Number(route.employeeId);
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!Number.isSafeInteger(runId) || !Number.isSafeInteger(employeeId) || !body || !Number.isSafeInteger(Number(body.reviewId)) || typeof body.action !== "string" || typeof body.reason !== "string" || !body.reason.trim()) {
    return payrollJson({ ok: false, code: "INVALID_REVIEW_RESOLUTION", message: "처리 방법과 사유를 확인해주세요." }, 400);
  }
  const { data: run, error: runError } = await supabaseServer.from("payroll_runs").select("engine_version").eq("id", runId).maybeSingle();
  if (runError || !run) return payrollJson({ ok: false, code: "RUN_NOT_FOUND", message: "급여 장부를 찾을 수 없습니다." }, 404);
  const rpcVersion = payrollRpcVersion(run.engine_version);
  if (!rpcVersion) return payrollJson({ ok: false, code: "PAYROLL_ENGINE_VERSION_UNSUPPORTED", message: "지원하지 않는 급여 계산 엔진입니다." }, 409);
  const args = { p_run_id: runId, p_run_employee_id: employeeId, p_review_id: body.reviewId, p_action: body.action, p_custom_minutes: body.customMinutes ?? null, p_reason: body.reason, p_actor_user_id: auth.actor.id };
  const { error } = rpcVersion === "v4"
    ? await supabaseServer.rpc("payroll_resolve_review_v4", args)
    : await supabaseServer.rpc("payroll_resolve_review_v3", args);
  if (error) {
    const conflict = error.message.includes("ALREADY_RESOLVED") || error.message.includes("ALREADY_EXISTS");
    const status = conflict || error.message.includes("LOCKED") ? 409 : error.message.includes("INVALID_REVIEW") || error.message.includes("INVALID_CUSTOM") ? 400 : error.message.includes("MISMATCH") || error.message.includes("NOT_FOUND") ? 404 : 500;
    return payrollJson({ ok: false, code: conflict ? "REVIEW_ALREADY_RESOLVED" : status === 409 ? "RUN_LOCKED" : status === 400 ? "INVALID_REVIEW_ACTION" : "REVIEW_RESOLUTION_FAILED", message: conflict ? "이미 처리된 확인 항목입니다." : status === 409 ? "작성 중인 급여만 처리할 수 있습니다." : status === 400 ? "이 확인 항목에 사용할 수 없는 처리 방법입니다." : "확인 항목을 처리하지 못했습니다." }, status);
  }
  return payrollJson({ ok: true });
}
