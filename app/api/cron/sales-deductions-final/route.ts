import { NextResponse } from "next/server";
import { getBusinessDate } from "@/lib/common/business-time";
import { addStoreDays } from "@/lib/store-settings/business-time-core";
import { loadBusinessTimeAdapter } from "@/lib/store-settings/business-time-adapter";
import {
  authorizeCron,
  getCronActor,
  runSalesDeductionCron,
} from "@/lib/sales/sales-deduction-cron-shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Runs once, right after the store's cutoff, to give the business date that
// just closed one last deduction pass. Candidate selection itself is entirely
// receipt-flag driven (see getDeductionCandidateReceiptIds in the shared
// module), so this mainly keeps logging/labeling accurate for the previous
// business date rather than the one that just started.
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
      "[SALES_DEDUCTIONS_FINAL_STORE_SETTING_LOOKUP_FAILED]",
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

  const actorResult = await getCronActor();
  if (actorResult.errorResponse) return actorResult.errorResponse;
  const actor = actorResult.actor!;

  const resolved = await resolvePreviousBusinessDate();

  console.log(
    "[SALES_DEDUCTIONS_FINAL_TARGET]",
    JSON.stringify({
      executedAt: new Date().toISOString(),
      currentBusinessDate: resolved.currentBusinessDate,
      targetBusinessDate: resolved.targetBusinessDate,
      revision: resolved.revision,
      isFallback: resolved.isFallback,
    })
  );

  const result = await runSalesDeductionCron({
    businessDate: resolved.targetBusinessDate,
    actor,
  });
  return NextResponse.json(result.body, { status: result.status });
}
