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
  const rows: Array<{ inventoryLogId: number; status: string; code: string; itemName: string; businessDate: string; quantityDelta: number; amountDelta: number; itemId: number; createdAt: string; originalQuantity: number | null }> = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabaseServer.from("ledger_inventory_projection_status")
      .select("inventory_log_id,status,code,source:inventory_logs!inner(item_id,business_date,created_at,item_name,item_name_vi,change_quantity,new_purchase_price)")
      .in("status", ["failed", "review_required"])
      .gte("source.business_date", start).lt("source.business_date", end)
      .order("inventory_log_id").range(from, from + 999);
    if (error) throw error;
    rows.push(...(data ?? []).map(row => {
      const source = Array.isArray(row.source) ? row.source[0] : row.source;
      const quantityDelta = Number(source?.change_quantity ?? 0);
      return {
        inventoryLogId: Number(row.inventory_log_id), status: row.status, code: row.code,
        itemName: source?.item_name || source?.item_name_vi || "-",
        businessDate: source?.business_date ?? "", quantityDelta,
        amountDelta: quantityDelta * Number(source?.new_purchase_price ?? 0),
        itemId: Number(source?.item_id ?? 0), createdAt: source?.created_at ?? "", originalQuantity: null,
      };
    }));
    if ((data?.length ?? 0) < 1000) break;
  }
  for (const issue of rows) {
    if (issue.code !== "PURCHASE_CORRECTION_REFERENCE_REQUIRED" || !issue.itemId || !issue.createdAt) continue;
    const { data: root, error } = await supabaseServer.from("inventory_logs")
      .select("change_quantity").eq("item_id", issue.itemId).eq("business_date", issue.businessDate)
      .eq("reason", "purchase").gt("change_quantity", 0).is("correction_of_inventory_log_id", null)
      .lte("created_at", issue.createdAt).order("created_at", { ascending: false })
      .order("id", { ascending: false }).limit(1).maybeSingle();
    if (error) throw error;
    issue.originalQuantity = root ? Number(root.change_quantity) : null;
  }
  return rows;
}
