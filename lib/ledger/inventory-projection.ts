import "server-only";
import { supabaseServer } from "@/lib/supabase/server";
import type { LedgerSyncResult } from "@/lib/inventory/ledger-sync-contract";

// Call only after the Inventory source write has committed. Never throw into its response.
export async function projectInventoryPurchaseLog(inventoryLogId: number, actorUserId: number): Promise<LedgerSyncResult> {
  try {
    const { data, error } = await supabaseServer.rpc("ledger_project_inventory_purchase_log_v1", {
      p_inventory_log_id: inventoryLogId,
      p_request_actor_user_id: actorUserId,
    });
    if (error) throw error;
    const result = data as LedgerSyncResult | null;
    if (!result || !["synced", "pending", "review_required", "failed"].includes(result.status)) throw new Error("INVALID_PROJECTION_RESPONSE");
    if (result.status !== "synced") console.warn("[INVENTORY_LEDGER_PROJECTION_STATUS]", { inventoryLogId, status: result.status, code: result.code });
    return { ...result, inventoryLogId };
  } catch (error) {
    const dbCode = error && typeof error === "object" && "code" in error ? String(error.code) : "PROJECTION_UNAVAILABLE";
    console.error("[INVENTORY_LEDGER_PROJECTION_FAILED]", { inventoryLogId, code: dbCode });
    return { status: "failed", code: dbCode, inventoryLogId };
  }
}

export async function projectInventoryPurchaseLogs(ids: number[], actorUserId: number) {
  const results: LedgerSyncResult[] = [];
  for (const id of [...new Set(ids)]) results.push(await projectInventoryPurchaseLog(id, actorUserId));
  const status = (["failed", "review_required", "pending", "synced"] as const).find(value => results.some(row => row.status === value)) ?? "synced";
  return { status, code: results.find(row => row.status === status)?.code, results };
}
