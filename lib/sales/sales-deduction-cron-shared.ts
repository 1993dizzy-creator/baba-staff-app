import crypto from "crypto";
import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { buildUnifiedInventoryDeductionPreview } from "@/lib/sales/inventory-deduction-unified-preview";
import { executeUnifiedInventoryDeductions } from "@/lib/sales/inventory-deduction-unified-execute";

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

// Shared by /api/cron/sales-deductions (current business date) and
// /api/cron/sales-deductions-final (previous, just-closed business date).
export function authorizeCron(req: Request) {
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

export async function getCronActor() {
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

async function getDeductionCandidateReceiptIds() {
  const retryBefore = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const { data, error } = await supabaseServer
    .from("pos_sales_receipts")
    .select("id")
    .not("inventory_deduction_auto_eligible_at", "is", null)
    .eq("inventory_deduction_processing_paused", false)
    .or(
      `inventory_deduction_last_checked_at.is.null,inventory_deduction_last_checked_at.lt.${retryBefore}`
    )
    .or("payment_status.eq.3,is_canceled.eq.true")
    .order("inventory_deduction_auto_eligible_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(200);

  if (error) {
    throw new Error(`Failed to fetch sales deduction candidates: ${error.message}`);
  }

  return ((data || []) as { id: number }[]).map((row) => Number(row.id));
}

async function recoverStaleReceiptEditPauses() {
  const staleBefore = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const { error } = await supabaseServer
    .from("pos_sales_receipts")
    .update({
      inventory_deduction_auto_eligible_at: null,
      inventory_deduction_processing_paused: false,
      inventory_deduction_processing_paused_at: null,
      inventory_deduction_processing_error: "stale_admin_edit",
    })
    .eq("inventory_deduction_processing_paused", true)
    .lt("inventory_deduction_processing_paused_at", staleBefore);

  if (error) {
    throw new Error(`Failed to recover stale receipt edit pauses: ${error.message}`);
  }
}

async function finalizeDeductionCandidate(params: {
  receiptId: number;
  terminal: boolean;
  expectedUpdatedAt: string;
  fingerprint: string | null;
  pendingStatus: string;
}) {
  const checkedAt = new Date().toISOString();
  const update = params.terminal
    ? {
        inventory_deduction_auto_eligible_at: null,
        inventory_deduction_last_checked_at: checkedAt,
        inventory_deduction_reprocess_required: false,
        inventory_deduction_pending_fingerprint: null,
        inventory_deduction_pending_status: null,
      }
    : {
        inventory_deduction_last_checked_at: checkedAt,
        inventory_deduction_pending_fingerprint: params.fingerprint,
        inventory_deduction_pending_status: params.pendingStatus,
      };
  const { error } = await supabaseServer
    .from("pos_sales_receipts")
    .update(update)
    .eq("id", params.receiptId)
    .eq("updated_at", params.expectedUpdatedAt)
    .eq("inventory_deduction_processing_paused", false);

  if (error) {
    throw new Error(`Failed to finalize deduction candidate: ${error.message}`);
  }
}

async function applyReceiptDeduction(params: {
  receiptId: number;
  businessDate: string;
  actorUsername: string;
}) {
  const preview = await buildUnifiedInventoryDeductionPreview({
    businessDateFrom: params.businessDate,
    businessDateTo: params.businessDate,
    receiptIds: [params.receiptId],
  });

  const receiptPreview = preview.receipts[0];

  if (!receiptPreview) {
    return {
      outcome: "skipped" as const,
      reason: "preview_receipt_not_found",
      terminal: false,
      expectedUpdatedAt: null,
      fingerprint: null,
    };
  }

  if (!receiptPreview.canExecute) {
    return {
      outcome: "skipped" as const,
      terminal: receiptPreview.operationType === "no_op",
      expectedUpdatedAt: receiptPreview.updatedAt,
      fingerprint: receiptPreview.currentFingerprint,
      reason: [
        receiptPreview.operationType,
        receiptPreview.rawPreviewStatus,
        ...receiptPreview.blockingReasons,
      ]
        .filter(Boolean)
        .join(":"),
    };
  }

  const executed = await executeUnifiedInventoryDeductions({
    actorUsername: params.actorUsername,
    executionId: `cron:${params.businessDate}:${params.receiptId}`,
    items: [
      {
        receiptId: params.receiptId,
        expectedOperationType: receiptPreview.operationType,
        expectedFingerprint: receiptPreview.currentFingerprint,
        expectedInventoryAffectingHash:
          receiptPreview.inventoryAffectingHash,
        expectedReceiptUpdatedAt: receiptPreview.updatedAt,
      },
    ],
  });
  const result = executed.results[0];

  if (!result) {
    return {
      outcome: "failed" as const,
      error: "Unified deduction execution returned no receipt result.",
      batchId: null,
      code: null,
      terminal: false,
      expectedUpdatedAt: receiptPreview.updatedAt,
      fingerprint: receiptPreview.currentFingerprint,
    };
  }

  if (result.result === "applied" || result.result === "already_processed") {
    return {
      outcome: "applied" as const,
      batchId: result.batchId,
      terminal: true,
      expectedUpdatedAt: receiptPreview.updatedAt,
      fingerprint: receiptPreview.currentFingerprint,
    };
  }

  if (
    result.result === "no_op" ||
    result.result === "needs_check" ||
    result.result === "stale_preview"
  ) {
    return {
      outcome: "skipped" as const,
      terminal: result.result === "no_op",
      expectedUpdatedAt: receiptPreview.updatedAt,
      fingerprint: receiptPreview.currentFingerprint,
      reason: `${result.result}:${result.failureReason || "no_reason"}`,
    };
  }

  return {
    outcome: "failed" as const,
    error: result.failureReason || result.result,
    batchId: result.batchId,
    code: result.result,
    terminal: false,
    expectedUpdatedAt: receiptPreview.updatedAt,
    fingerprint: receiptPreview.currentFingerprint,
  };
}

// Core loop shared by the normal and final sales-deductions crons. businessDate
// is only used for logging and for the (currently unused-for-filtering)
// buildUnifiedInventoryDeductionPreview businessDateFrom/To metadata — actual
// candidate selection is entirely receipt-flag driven (see
// getDeductionCandidateReceiptIds), not businessDate driven.
export async function runSalesDeductionCron(params: {
  businessDate: string;
  actor: { id: number; username: string };
}) {
  const startedAt = Date.now();

  console.log(
    "[SALES_DEDUCTION_CRON_START]",
    JSON.stringify({ businessDate: params.businessDate, actorUsername: params.actor.username })
  );

  try {
    await recoverStaleReceiptEditPauses();
    const candidateReceiptIds = await getDeductionCandidateReceiptIds();

    const appliedReceiptIds: number[] = [];
    const skipped: SkippedReceipt[] = [];
    const failed: FailedReceipt[] = [];

    for (const receiptId of candidateReceiptIds) {
      try {
        const result = await applyReceiptDeduction({
          receiptId,
          businessDate: params.businessDate,
          actorUsername: params.actor.username,
        });
        if (result.expectedUpdatedAt) {
          await finalizeDeductionCandidate({
            receiptId,
            terminal: result.terminal === true,
            expectedUpdatedAt: result.expectedUpdatedAt,
            fingerprint: result.fingerprint,
            pendingStatus:
              result.outcome === "skipped"
                ? result.reason
                : result.outcome,
          });
        }

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
      businessDate: params.businessDate,
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

    return { status: 200, body: responseBody };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to run sales deduction cron.";

    console.error(
      "[SALES_DEDUCTION_CRON_RESULT]",
      JSON.stringify({
        ok: false,
        businessDate: params.businessDate,
        error: message,
        elapsedMs: Date.now() - startedAt,
      })
    );

    return {
      status: 500,
      body: { ok: false, businessDate: params.businessDate, error: message },
    };
  }
}
