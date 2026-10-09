import "server-only";
import { supabaseServer } from "@/lib/supabase/server";
import { inventoryDisplayOverlay } from "@/lib/inventory/ledger-sync-contract";
import { loadInventoryRepairPreview } from "./inventory-repair";
import type { PurchaseRepairPreview } from "@/lib/inventory/purchase-repair-contract";
import { canReviewPurchaseCorrection } from "@/lib/inventory/purchase-repair-contract";

// Preserve evidence snapshots in API responses; display_snapshot is explicitly display-only.
export async function withInventoryDisplay<T extends { id: number | string; source_snapshot?: Record<string, unknown> | null }>(rows: T[]): Promise<Array<T & { display_snapshot?: Record<string, unknown> }>> {
  const overlays = new Map<number, Record<string, unknown>>();
  for (let from = 0; from < rows.length; from += 200) {
    const { data, error } = await supabaseServer.from("ledger_candidates")
      .select("resolved_transaction_id,source_drift_snapshot")
      .eq("source_type", "inventory_purchase_log").eq("status", "confirmed")
      .in("resolved_transaction_id", rows.slice(from, from + 200).map(row => Number(row.id)));
    if (error) throw error;
    for (const row of data ?? []) if (row.source_drift_snapshot) overlays.set(Number(row.resolved_transaction_id), row.source_drift_snapshot);
  }
  const logIds = [...new Set(rows.map(row => Number(row.source_snapshot?.inventory_log_id))
    .filter(id => Number.isSafeInteger(id) && id > 0))];
  const currentSuppliers = new Map<number, string | null>();
  for (let from = 0; from < logIds.length; from += 200) {
    const { data, error } = await supabaseServer.from("inventory_logs")
      .select("id,new_supplier").in("id", logIds.slice(from, from + 200));
    if (error) throw error;
    for (const log of data ?? []) currentSuppliers.set(Number(log.id), log.new_supplier?.trim() || null);
  }
  return rows.map(row => {
    const drift = overlays.get(Number(row.id));
    const logId = Number(row.source_snapshot?.inventory_log_id);
    if (!drift && !currentSuppliers.has(logId)) return { ...row };
    const display = inventoryDisplayOverlay(row.source_snapshot, drift);
    if (currentSuppliers.has(logId)) display.supplier = currentSuppliers.get(logId);
    return { ...row, display_snapshot: display };
  });
}

export async function loadInventoryProjectionIssues(start: string, end: string, actorUserId: number) {
  const rows: Array<{ inventoryLogId: number; status: string; code: string; itemName: string; itemNameVi: string | null; supplier: string | null; businessDate: string; quantityDelta: number; amountDelta: number; itemId: number; createdAt: string; originalQuantity: number | null; resolution?: PurchaseRepairPreview }> = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabaseServer.from("ledger_inventory_projection_status")
      .select("inventory_log_id,status,code,source:inventory_logs!inner(item_id,business_date,created_at,item_name,item_name_vi,change_quantity,new_purchase_price,new_supplier,reason,source)")
      .or("status.in.(failed,review_required),and(status.eq.synced,code.eq.NOT_A_PURCHASE)")
      .gte("source.business_date", start).lt("source.business_date", end)
      .order("inventory_log_id").range(from, from + 999);
    if (error) throw error;
    rows.push(...(data ?? []).filter(row => {
      const source = Array.isArray(row.source) ? row.source[0] : row.source;
      return row.status !== "synced" || (source?.reason === "purchase" && source?.source === "quick_save" && Number(source?.change_quantity) < 0);
    }).map(row => {
      const source = Array.isArray(row.source) ? row.source[0] : row.source;
      const quantityDelta = Number(source?.change_quantity ?? 0);
      return {
        inventoryLogId: Number(row.inventory_log_id), status: row.status === "synced" ? "review_required" : row.status,
        code: row.status === "synced" ? "PURCHASE_CORRECTION_REFERENCE_REQUIRED" : row.code,
        itemName: source?.item_name || source?.item_name_vi || "-",
        itemNameVi: source?.item_name_vi || null,
        supplier: source?.new_supplier?.trim() || null,
        businessDate: source?.business_date ?? "", quantityDelta,
        amountDelta: quantityDelta * Number(source?.new_purchase_price ?? 0),
        itemId: Number(source?.item_id ?? 0), createdAt: source?.created_at ?? "", originalQuantity: null,
      };
    }));
    if ((data?.length ?? 0) < 1000) break;
  }
  for (const issue of rows) {
    if (!canReviewPurchaseCorrection(issue.code) || !issue.itemId || !issue.createdAt) continue;
    // Preview is advisory only. POST revalidates everything under canonical locks.
    // A missing migration/preview must never hide the underlying warning.
    try {
      issue.resolution = await loadInventoryRepairPreview(issue.inventoryLogId, actorUserId);
      issue.originalQuantity = issue.resolution?.recommended ? Number(issue.resolution.candidates[0].quantity) : null;
    } catch { issue.resolution = { candidates: [], recommended: false }; }
  }
  return rows;
}
