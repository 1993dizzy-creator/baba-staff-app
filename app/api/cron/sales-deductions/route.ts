import { NextResponse } from "next/server";
import { getBusinessDate } from "@/lib/common/business-time";
import {
  authorizeCron,
  getCronActor,
  runSalesDeductionCron,
} from "@/lib/sales/sales-deduction-cron-shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const guardResponse = authorizeCron(req);
  if (guardResponse) return guardResponse;

  const actorResult = await getCronActor();
  if (actorResult.errorResponse) return actorResult.errorResponse;
  const actor = actorResult.actor!;

  // Current business date. The just-closed business date is handled
  // separately by /api/cron/sales-deductions-final.
  const businessDate = getBusinessDate();

  const result = await runSalesDeductionCron({ businessDate, actor });
  return NextResponse.json(result.body, { status: result.status });
}
