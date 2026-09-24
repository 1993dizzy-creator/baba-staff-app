import { NextResponse } from "next/server";
import { authorizeCron } from "@/lib/pos/cukcuk/sales-sync-cron-shared";
import { resolveQuyenMenuSalesIncentiveCronTarget } from "@/lib/payroll/quyen-menu-sales-incentive";
import { runQuyenMenuSalesIncentive } from "@/lib/payroll/quyen-menu-sales-incentive-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * BABA runs this daily at 20:15 UTC, but writes only on day 1 in Vietnam.
 * 03:15 is deliberately after the 03:00 final POS sync and 03:05 sales close,
 * so the previous calendar month's /admin/sales/monthly projection is stable.
 * It must never run at 23:59: late-night sales still belong to the closing
 * business day. The deterministic source key makes Vercel retries idempotent,
 * and the existing payroll paid-lock prevents a late correction from changing
 * an already-paid salary. This remains a Quyen-only source-level agreement;
 * generalize it only when BABA introduces additional incentive policies.
 */
export async function GET(request: Request) {
  const guardResponse = authorizeCron(request);
  if (guardResponse) return guardResponse;

  const target = resolveQuyenMenuSalesIncentiveCronTarget(new Date());
  if (!target.ok) {
    return NextResponse.json({ ok: true, noOp: target.reason, targetMonth: target.targetMonth ?? null });
  }

  try {
    const result = await runQuyenMenuSalesIncentive(target.targetMonth);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    console.error("[PAYROLL_QUYEN_MENU_INCENTIVE_FAILED]", error);
    return NextResponse.json({ ok: false, code: "PAYROLL_QUYEN_MENU_INCENTIVE_FAILED" }, { status: 500 });
  }
}
