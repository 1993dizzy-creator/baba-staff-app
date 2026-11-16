import { payrollJson, requirePayrollActor } from "@/lib/payroll/server";
import { executeSettlement, loadSettlementContext, SettlementError } from "@/lib/payroll/special-settlement-2026-10-server";
import { validSettlementRequestKey } from "@/lib/payroll/special-settlement-2026-10";

export const dynamic = "force-dynamic";

// 2026-10 only: records the accountant-corrected payroll that was ALREADY paid
// (11/10 bank + cash, 11/14 cash). Payroll managers (owner/master) via the
// common payroll permission check. Nothing here sends money.
function failure(error: unknown) {
  if (error instanceof SettlementError) return payrollJson({ ok: false, code: error.code, ...(error.detail ?? {}) }, error.status);
  console.error("[PAYROLL_SPECIAL_SETTLEMENT_FAILED]", error);
  return payrollJson({ ok: false, code: "PAYROLL_SPECIAL_SETTLEMENT_FAILED" }, 500);
}

export async function GET() {
  const auth = await requirePayrollActor(); if (auth.response || !auth.actor) return auth.response;
  try {
    const { planHash, batch, preview } = await loadSettlementContext();
    return payrollJson({ ok: true, month: "2026-10", planHash, batch, ...preview });
  } catch (error) { return failure(error); }
}

export async function POST(request: Request) {
  const auth = await requirePayrollActor(); if (auth.response || !auth.actor) return auth.response;
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const previewToken = typeof body?.previewToken === "string" && /^[0-9a-f]{64}$/.test(body.previewToken) ? body.previewToken : null;
  const requestKey = validSettlementRequestKey(body?.requestKey) ? body!.requestKey as string : null;
  if (!previewToken || !requestKey || body?.confirm !== true) return payrollJson({ ok: false, code: "INVALID_SETTLEMENT_REQUEST" }, 400);
  try {
    const result = await executeSettlement({ actorUserId: auth.actor.id, previewToken, requestKey });
    return payrollJson({ ok: true, result });
  } catch (error) { return failure(error); }
}
