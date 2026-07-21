import { NextResponse } from "next/server";
import { getBusinessDate } from "@/lib/common/business-time";
import { addStoreDays } from "@/lib/store-settings/business-time-core";
import { loadBusinessTimeAdapter } from "@/lib/store-settings/business-time-adapter";
import {
  authorizeCron,
  callSalesSyncRoute,
  buildSalesSyncCronResponse,
} from "@/lib/pos/cukcuk/sales-sync-cron-shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Runs once, right after the store's cutoff. Unlike /api/cron/sales-sync,
// this must not sync "today" (the business date that just started at
// cutoff) — it exists specifically to make one last pass over the business
// date that just closed, in case any receipt was posted or finalized in
// CUKCUK between the last regular sync and cutoff.
async function resolvePreviousBusinessDate() {
  try {
    const adapter = await loadBusinessTimeAdapter(new Date());
    return {
      currentBusinessDate: adapter.databaseBusinessDate,
      targetBusinessDate: addStoreDays(adapter.databaseBusinessDate, -1),
      revision: adapter.snapshot.revision,
      isFallback: adapter.snapshot.isFallback,
    };
  } catch (error) {
    console.error(
      "[SALES_SYNC_FINAL_STORE_SETTING_LOOKUP_FAILED]",
      JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
      })
    );

    const currentBusinessDate = getBusinessDate();

    return {
      currentBusinessDate,
      targetBusinessDate: addStoreDays(currentBusinessDate, -1),
      revision: 0,
      isFallback: true,
    };
  }
}

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
  const resolved = await resolvePreviousBusinessDate();

  console.log(
    "[SALES_SYNC_FINAL_TARGET]",
    JSON.stringify({
      executedAt: new Date().toISOString(),
      currentBusinessDate: resolved.currentBusinessDate,
      targetBusinessDate: resolved.targetBusinessDate,
      revision: resolved.revision,
      isFallback: resolved.isFallback,
    })
  );

  const { syncRes, syncJson, elapsedMs } = await callSalesSyncRoute({
    origin,
    posAdminSecret,
    businessDate: resolved.targetBusinessDate,
  });

  return buildSalesSyncCronResponse({
    syncRes,
    syncJson,
    elapsedMs,
    fallbackBusinessDate: resolved.targetBusinessDate,
  });
}
