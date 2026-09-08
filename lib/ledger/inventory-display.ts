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
  return rows.map(row => ({ ...row, ...(overlays.has(Number(row.id)) ? { display_snapshot: inventoryDisplayOverlay(row.source_snapshot, overlays.get(Number(row.id))) } : {}) }));
}

export async function loadInventoryProjectionIssues(start: string, end: string) {
  const rows: Array<{ inventoryLogId: number; status: string; code: string }> = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabaseServer.from("ledger_inventory_projection_status")
      .select("inventory_log_id,status,code,source:inventory_logs!inner(business_date)")
      .in("status", ["failed", "review_required"])
      .gte("source.business_date", start).lt("source.business_date", end)
      .order("inventory_log_id").range(from, from + 999);
    if (error) throw error;
    rows.push(...(data ?? []).map(row => ({ inventoryLogId: Number(row.inventory_log_id), status: row.status, code: row.code })));
    if ((data?.length ?? 0) < 1000) return rows;
  }
}
