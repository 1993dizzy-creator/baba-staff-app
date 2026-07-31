import { payrollRpcVersion } from "@/lib/payroll/rpc-version";
import { payrollJson, requirePayrollActor } from "@/lib/payroll/server";
import { supabaseServer } from "@/lib/supabase/server";

const additions = new Set(["incentive", "meal", "transport", "housing", "other_addition"]);
const deductions = new Set(["insurance_tax", "advance", "penalty", "other_deduction"]);
type Context = { params: Promise<{ runId: string; employeeId: string }> };

async function mutate(request: Request, context: Context, operation: "create" | "update" | "delete") {
  const auth = await requirePayrollActor();
  if (auth.response || !auth.actor) return auth.response;
  const params = await context.params;
  const runId = Number(params.runId), employeeId = Number(params.employeeId);
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const amount = Number(body?.amount ?? 0), category = String(body?.category ?? ""), direction = String(body?.direction ?? "");
  const validPair = (direction === "addition" && additions.has(category)) || (direction === "deduction" && deductions.has(category));
  if (!Number.isSafeInteger(runId) || !Number.isSafeInteger(employeeId) || !body || (operation !== "delete" && (!validPair || !Number.isSafeInteger(amount) || amount < 0 || typeof body.description !== "string" || !body.description.trim() || typeof body.reason !== "string" || !body.reason.trim())) || (operation === "delete" && (!Number.isSafeInteger(Number(body.itemId)) || typeof body.reason !== "string" || !body.reason.trim()))) {
    return payrollJson({ ok: false, code: "INVALID_ITEM", message: "급여 항목과 사유를 다시 확인해주세요." }, 400);
  }
  const { data: run, error: runError } = await supabaseServer.from("payroll_runs").select("engine_version").eq("id", runId).maybeSingle();
  if (runError || !run) return payrollJson({ ok: false, code: "RUN_NOT_FOUND", message: "급여 장부를 찾을 수 없습니다." }, 404);
  const rpcVersion = payrollRpcVersion(run.engine_version);
  if (!rpcVersion) return payrollJson({ ok: false, code: "PAYROLL_ENGINE_VERSION_UNSUPPORTED", message: "지원하지 않는 급여 계산 엔진입니다." }, 409);
  const args = { p_run_id: runId, p_run_employee_id: employeeId, p_item_id: body.itemId ?? null, p_operation: operation, p_category: category || "other_addition", p_direction: direction || "addition", p_amount: amount, p_description: body.description ?? "", p_reason: body.reason, p_actor_user_id: auth.actor.id };
  const { data, error } = rpcVersion === "v4"
    ? await supabaseServer.rpc("payroll_mutate_item_v4", args)
    : await supabaseServer.rpc("payroll_mutate_item_v3", args);
  if (error) {
    const status = error.message.includes("LOCKED") ? 409 : error.message.includes("MISMATCH") || error.message.includes("NOT_FOUND") ? 404 : 500;
    return payrollJson({ ok: false, code: status === 409 ? "RUN_LOCKED" : "ITEM_MUTATION_FAILED", message: status === 409 ? "작성 중인 급여만 변경할 수 있습니다." : "급여 항목을 변경하지 못했습니다." }, status);
  }
  const itemId = Number(data);
  return Number.isSafeInteger(itemId) && itemId > 0 ? payrollJson({ ok: true, itemId }) : payrollJson({ ok: false, code: "ITEM_MUTATION_FAILED", message: "급여 항목을 변경하지 못했습니다." }, 500);
}

export function POST(request: Request, context: Context) { return mutate(request, context, "create"); }
export function PATCH(request: Request, context: Context) { return mutate(request, context, "update"); }
export function DELETE(request: Request, context: Context) { return mutate(request, context, "delete"); }
