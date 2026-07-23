import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth/server-auth";
import {
  calculateStoredInventoryTotals,
} from "@/lib/sales/inventory-deduction-batches";
import {
  getPositiveInteger,
} from "@/lib/pos/mapping-admin";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireRole(["owner", "master", "manager", "leader"]);
    if (!auth.ok) {
      return NextResponse.json(
        { ok: false, error: auth.code, code: auth.code },
        { status: auth.status }
      );
    }

    const { id } = await context.params;
    const batchId = getPositiveInteger(id);
    if (!batchId) {
      return NextResponse.json(
        { ok: false, error: "Invalid batch id." },
        { status: 400 }
      );
    }

    const [batchResult, receiptsResult, deductionsResult] = await Promise.all([
      supabaseServer
        .from("pos_inventory_deduction_batches")
        .select("*")
        .eq("id", batchId)
        .maybeSingle(),
      supabaseServer
        .from("pos_inventory_deduction_receipts")
        .select("*")
        .eq("batch_id", batchId)
        .order("business_date", { ascending: true })
        .order("id", { ascending: true }),
      supabaseServer
        .from("pos_inventory_deductions")
        .select(
          "id, batch_id, batch_receipt_id, receipt_id, receipt_line_id, receipt_ref_no, business_date, mapping_id, recipe_id, mapping_type, operation_type, mapping_snapshot, inventory_affecting_hash, amount_hash, idempotency_key, inventory_item_id, quantity_sold, deduct_quantity_per_unit, deduct_quantity_total, current_quantity_snapshot, after_quantity_snapshot, status, blocked_reason"
        )
        .eq("batch_id", batchId)
        .order("receipt_id", { ascending: true })
        .order("receipt_line_id", { ascending: true }),
    ]);

    if (batchResult.error) throw batchResult.error;
    if (!batchResult.data) {
      return NextResponse.json(
        { ok: false, error: "Batch was not found." },
        { status: 404 }
      );
    }
    if (receiptsResult.error) throw receiptsResult.error;
    if (deductionsResult.error) throw deductionsResult.error;

    const deductions = deductionsResult.data || [];
    const selectedDeductions = deductions.filter(
      (deduction) => deduction.status === "selected"
    );
    const inventoryIds = Array.from(
      new Set(
        deductions
          .map((deduction) => Number(deduction.inventory_item_id))
          .filter((inventoryId) => inventoryId > 0)
      )
    );
    const inventoryById = new Map<number, Record<string, unknown>>();

    if (inventoryIds.length > 0) {
      const { data: inventoryItems, error } = await supabaseServer
        .from("inventory")
        .select("id, item_name, item_name_vi, code, unit")
        .in("id", inventoryIds);
      if (error) throw error;
      for (const item of inventoryItems || []) {
        inventoryById.set(Number(item.id), item);
      }
    }

    return NextResponse.json({
      ok: true,
      batch: batchResult.data,
      receipts: receiptsResult.data || [],
      deductions: deductions.map((deduction) => ({
        ...deduction,
        inventoryItem:
          inventoryById.get(Number(deduction.inventory_item_id)) ?? null,
      })),
      inventoryTotals: calculateStoredInventoryTotals(deductions),
      selectedInventoryTotals:
        calculateStoredInventoryTotals(selectedDeductions),
    });
  } catch (error) {
    console.error("[ADMIN_SALES_INVENTORY_BATCH_GET_ERROR]", error);
    return NextResponse.json(
      {
        ok: false,
        error: "Failed to load batch.",
      },
      { status: 500 }
    );
  }
}
