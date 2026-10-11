import "server-only";
import { supabaseServer } from "@/lib/supabase/server";
import { inventoryDisplayOverlay } from "@/lib/inventory/ledger-sync-contract";

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

export { loadPurchaseCases as loadInventoryProjectionIssues } from "./purchase-case-loader";