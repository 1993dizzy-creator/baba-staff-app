import { NextResponse } from "next/server";
import { getBusinessDate } from "@/lib/common/business-time";
import {
  authorizeCron,
  callSalesSyncRoute,
  buildSalesSyncCronResponse,
} from "@/lib/pos/cukcuk/sales-sync-cron-shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const guardResponse = authorizeCron(req);
  if (guardResponse) return guardResponse;

  const posAdminSecret = process.env.POS_ADMIN_SECRET?.trim();

  if (!posAdminSecret) {
    return NextResponse.json(
      { ok: false, error: "POS_ADMIN_SECRET is not configured." },
      { status: 403 }
    );
  }

  const origin = new URL(req.url).origin;

  // Configure schedule outside the app, for example in Vercel Cron.
  // This route intentionally always uses force=false. businessDate is
  // intentionally omitted here so sync-to-sales resolves the current
  // business date itself from the store settings time module (single source
  // of truth, instead of being decided twice). The just-closed business date
  // is handled separately by /api/cron/sales-sync-final.
  const { syncRes, syncJson, elapsedMs } = await callSalesSyncRoute({
    origin,
    posAdminSecret,
  });

  return buildSalesSyncCronResponse({
    syncRes,
    syncJson,
    elapsedMs,
    fallbackBusinessDate: getBusinessDate(),
  });
}
