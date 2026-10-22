import "server-only";
import { supabaseServer } from "@/lib/supabase/server";
import { inventoryDisplayOverlay } from "@/lib/inventory/ledger-sync-contract";

// Preserve evidence snapshots in API responses; display_snapshot is explicitly display-only.
export async function withInventoryDisplay<T extends { id: number | string; source_snapshot?: Record<string, unknown> | null }>(rows: T[], options: { concurrency?: 1 | 2 } = {}): Promise<Array<T & { display_snapshot?: Record<string, unknown> }>> {
  // Only Entries opts in. Keep other callers serial and retain chunk-order merges,
  // even when a later read finishes first. No partial display is returned on error.
  const reads: Array<() => Promise<() => void>> = [];
  const overlays = new Map<number, Record<string, unknown>>();
  for (let from = 0; from < rows.length; from += 200) {
    const ids = rows.slice(from, from + 200).map(row => Number(row.id));
    reads.push(async () => {
      const { data, error } = await supabaseServer.from("ledger_candidates")
        .select("resolved_transaction_id,source_drift_snapshot")
        .eq("source_type", "inventory_purchase_log").eq("status", "confirmed")
        .in("resolved_transaction_id", ids);
      if (error) throw error;
      return () => {
        for (const row of data ?? []) if (row.source_drift_snapshot) overlays.set(Number(row.resolved_transaction_id), row.source_drift_snapshot);
      };
    });
  }
  const logIds = [...new Set(rows.map(row => Number(row.source_snapshot?.inventory_log_id))
    .filter(id => Number.isSafeInteger(id) && id > 0))];
  const currentSuppliers = new Map<number, string | null>();
  for (let from = 0; from < logIds.length; from += 200) {
    const ids = logIds.slice(from, from + 200);
    reads.push(async () => {
      const { data, error } = await supabaseServer.from("inventory_logs")
        .select("id,new_supplier").in("id", ids);
      if (error) throw error;
      return () => {
        for (const log of data ?? []) currentSuppliers.set(Number(log.id), log.new_supplier?.trim() || null);
      };
    });
  }
  const merges: Array<() => void> = new Array(reads.length);
  let next = 0;
  let failure: { error: unknown } | undefined;
  async function worker() {
    while (!failure && next < reads.length) {
      const index = next++;
      try {
        merges[index] = await reads[index]();
      } catch (error) {
        failure ??= { error };
      }
    }
  }
  // Drain in-flight reads before propagating the original error; stop scheduling
  // new reads after a failure and never merge an incomplete result.
  await Promise.all(Array.from({ length: Math.min(options.concurrency === 2 ? 2 : 1, reads.length) }, () => worker()));
  if (failure) throw failure.error;
  for (const merge of merges) merge();
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
