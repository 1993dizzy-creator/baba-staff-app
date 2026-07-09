import crypto from "crypto";
import { NextResponse } from "next/server";
import { getBusinessDate } from "@/lib/common/business-time";
import { supabaseServer } from "@/lib/supabase/server";
import { buildInventoryDeductionPreview } from "@/lib/sales/inventory-deduction-preview";
import { saveInventoryDeductionPreviewBatch } from "@/lib/sales/inventory-deduction-batches";
import { validateInventoryDeductionBatch } from "@/lib/sales/inventory-deduction-batch-validation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type SkippedReceipt = { receiptId: number; reason: string };
type FailedReceipt = { receiptId: number; error: string };

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function getBearerToken(req: Request) {
  const authorization = req.headers.get("authorization")?.trim() || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);

  return match?.[1]?.trim() || "";
}

function authorizeCron(req: Request) {
  const expected = process.env.CRON_SECRET?.trim();

  if (!expected) {
    return NextResponse.json(
      { ok: false, error: "CRON_SECRET is not configured." },
      { status: 403 }
    );
  }

  const actual =
    getBearerToken(req) || req.headers.get("x-cron-secret")?.trim() || "";

  if (!actual || !safeEqual(actual, expected)) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized cron request." },
      { status: 401 }
    );
  }

  return null;
}

async function getCronActor() {
  const actorUsername = process.env.SALES_DEDUCTION_CRON_ACTOR_USERNAME?.trim();

  if (!actorUsername) {
    return {
      errorResponse: NextResponse.json(
        {
          ok: false,
          error: "SALES_DEDUCTION_CRON_ACTOR_USERNAME is not configured.",
        },
        { status: 403 }
      ),
    };
  }

  const { data, error } = await supabaseServer
    .from("users")
    .select("id, username, role, is_active")
    .eq("username", actorUsername)
    .eq("is_active", true)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to verify sales deduction cron actor: ${error.message}`);
  }

  if (!data || (data.role !== "owner" && data.role !== "master")) {
    return {
      errorResponse: NextResponse.json(
        {
          ok: false,
          error:
            "Sales deduction cron actor was not found or lacks owner/master role.",
        },
        { status: 403 }
      ),
    };
  }

  return { actor: { id: Number(data.id), username: String(data.username) } };
}

async function getDeductionCandidateReceiptIds(businessDate: string) {
  const { data, error } = await supabaseServer
    .from("pos_sales_receipts")
    .select("id")
    .eq("business_date", businessDate)
    .eq("payment_status", 3)
    .or("is_canceled.is.null,is_canceled.eq.false")
    .or("is_modified.is.null,is_modified.eq.false")
    .or("source.is.null,source.neq.manual")
    .order("id", { ascending: true });

  if (error) {
    throw new Error(`Failed to fetch sales deduction candidates: ${error.message}`);
  }

  return ((data || []) as { id: number }[]).map((row) => Number(row.id));
}

async function applyReceiptDeduction(params: {
  receiptId: number;
  businessDate: string;
  actorUsername: string;
}) {
  const preview = await buildInventoryDeductionPreview({
    businessDateFrom: params.businessDate,
    businessDateTo: params.businessDate,
    receiptIds: [params.receiptId],
  });

  const receiptPreview = preview.receipts[0];

  if (preview.receipts.length !== 1 || !receiptPreview) {
    return { outcome: "skipped" as const, reason: "preview_receipt_not_found" };
  }

  if (receiptPreview.status !== "ready") {
    return {
      outcome: "skipped" as const,
      reason: `not_ready:${receiptPreview.status}`,
    };
  }

  if (
    receiptPreview.lines.every((line) => line.deductions.length === 0)
  ) {
    return { outcome: "skipped" as const, reason: "no_deduction_candidates" };
  }

  const savedBatch = await saveInventoryDeductionPreviewBatch({
    preview,
    actorUsername: params.actorUsername,
    note: "cron_auto_apply",
  });

  const validation = await validateInventoryDeductionBatch(savedBatch.batchId);

  if (!validation.found || !validation.applyReady) {
    return {
      outcome: "skipped" as const,
      reason: "validation_not_apply_ready",
    };
  }

  const validationReceipts = validation.receipts.map((receipt) => ({
    receiptId: receipt.receiptId,
    currentInventoryHash: receipt.currentInventoryHash,
    currentReceiptUpdatedAt: receipt.currentReceiptUpdatedAt,
    applyAllowed: receipt.applyAllowed,
  }));

  const { error } = await supabaseServer.rpc(
    "apply_sales_inventory_deduction_batch",
    {
      p_batch_id: savedBatch.batchId,
      p_actor_username: params.actorUsername,
      p_validation_receipts: validationReceipts,
    }
  );

  if (error) {
    return {
      outcome: "failed" as const,
      error: error.message,
      batchId: savedBatch.batchId,
      code: error.code,
    };
  }

  return { outcome: "applied" as const, batchId: savedBatch.batchId };
}

export async function GET(req: Request) {
  const guardResponse = authorizeCron(req);
  if (guardResponse) return guardResponse;

  const actorResult = await getCronActor();
  if (actorResult.errorResponse) return actorResult.errorResponse;
  const actor = actorResult.actor!;

  const businessDate = getBusinessDate();
  const startedAt = Date.now();

  console.log(
    "[SALES_DEDUCTION_CRON_START]",
    JSON.stringify({ businessDate, actorUsername: actor.username })
  );

  try {
    const candidateReceiptIds = await getDeductionCandidateReceiptIds(
      businessDate
    );

    const appliedReceiptIds: number[] = [];
    const skipped: SkippedReceipt[] = [];
    const failed: FailedReceipt[] = [];

    for (const receiptId of candidateReceiptIds) {
      try {
        const result = await applyReceiptDeduction({
          receiptId,
          businessDate,
          actorUsername: actor.username,
        });

        if (result.outcome === "applied") {
          appliedReceiptIds.push(receiptId);
        } else if (result.outcome === "skipped") {
          skipped.push({ receiptId, reason: result.reason });
        } else {
          failed.push({ receiptId, error: result.error });
          console.error(
            "[SALES_DEDUCTION_CRON_RECEIPT_FAILED]",
            JSON.stringify({
              receiptId,
              batchId: result.batchId,
              error: result.error,
              code: result.code,
            })
          );
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown sales deduction error";
        failed.push({ receiptId, error: message });
        console.error(
          "[SALES_DEDUCTION_CRON_RECEIPT_FAILED]",
          JSON.stringify({ receiptId, error: message })
        );
      }
    }

    const responseBody = {
      ok: true,
      businessDate,
      candidateCount: candidateReceiptIds.length,
      appliedCount: appliedReceiptIds.length,
      skippedCount: skipped.length,
      failedCount: failed.length,
      appliedReceiptIds,
      skipped,
      failed,
    };

    console.log(
      "[SALES_DEDUCTION_CRON_RESULT]",
      JSON.stringify({ ...responseBody, elapsedMs: Date.now() - startedAt })
    );

    return NextResponse.json(responseBody);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to run sales deduction cron.";

    console.error(
      "[SALES_DEDUCTION_CRON_RESULT]",
      JSON.stringify({
        ok: false,
        businessDate,
        error: message,
        elapsedMs: Date.now() - startedAt,
      })
    );

    return NextResponse.json(
      { ok: false, businessDate, error: message },
      { status: 500 }
    );
  }
}
