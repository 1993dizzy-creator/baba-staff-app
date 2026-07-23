import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth/server-auth";
import {
  executeUnifiedInventoryDeductions,
  MAX_UNIFIED_EXECUTE_ITEMS,
  type UnifiedExecuteItemInput,
} from "@/lib/sales/inventory-deduction-unified-execute";
import type { UnifiedInventoryDeductionOperationType } from "@/lib/sales/inventory-deduction-unified-preview";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type JsonObject = Record<string, unknown>;

const OPERATION_TYPES = new Set<UnifiedInventoryDeductionOperationType>([
  "initial_apply",
  "reprocess_modified",
  "needs_check",
  "no_op",
]);

function getOptionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function getReceiptId(value: unknown) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseItems(value: unknown):
  | { ok: true; items: UnifiedExecuteItemInput[] }
  | { ok: false; error: string } {
  if (!Array.isArray(value)) {
    return { ok: false, error: "items must be an array." };
  }
  if (value.length === 0) {
    return { ok: false, error: "items cannot be empty." };
  }
  if (value.length > MAX_UNIFIED_EXECUTE_ITEMS) {
    return {
      ok: false,
      error: `items cannot exceed ${MAX_UNIFIED_EXECUTE_ITEMS} receipts.`,
    };
  }

  const receiptIds = new Set<number>();
  const items: UnifiedExecuteItemInput[] = [];

  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      return { ok: false, error: "Each item must be an object." };
    }

    const row = entry as JsonObject;
    const receiptId = getReceiptId(row.receiptId);
    if (!receiptId) {
      return { ok: false, error: "Each item requires a positive receiptId." };
    }
    if (receiptIds.has(receiptId)) {
      return { ok: false, error: "Duplicate receiptId is not allowed." };
    }
    receiptIds.add(receiptId);

    const expectedOperationType =
      typeof row.expectedOperationType === "string"
        ? row.expectedOperationType
        : "";
    if (
      !OPERATION_TYPES.has(
        expectedOperationType as UnifiedInventoryDeductionOperationType
      )
    ) {
      return {
        ok: false,
        error: "Each item requires a valid expectedOperationType.",
      };
    }

    items.push({
      receiptId,
      expectedOperationType:
        expectedOperationType as UnifiedInventoryDeductionOperationType,
      expectedFingerprint: getOptionalString(row.expectedFingerprint),
      expectedInventoryAffectingHash: getOptionalString(
        row.expectedInventoryAffectingHash
      ),
      expectedReceiptUpdatedAt: getOptionalString(row.expectedReceiptUpdatedAt),
    });
  }

  return { ok: true, items };
}

export async function POST(req: Request) {
  try {
    const auth = await requireRole(["owner", "master", "manager"]);
    if (!auth.ok) {
      return NextResponse.json(
        { success: false, error: auth.code, code: auth.code },
        { status: auth.status }
      );
    }

    const body = (await req.json().catch(() => ({}))) as JsonObject;

    const parsed = parseItems(body.items);
    if (!parsed.ok) {
      return NextResponse.json(
        { success: false, error: parsed.error },
        { status: 400 }
      );
    }

    const result = await executeUnifiedInventoryDeductions({
      actorUsername: auth.actor.username,
      items: parsed.items,
    });

    return NextResponse.json(result);
  } catch (error) {
    console.error("[ADMIN_SALES_INVENTORY_UNIFIED_EXECUTE_ERROR]", error);
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to execute unified inventory deductions.",
      },
      { status: 500 }
    );
  }
}
