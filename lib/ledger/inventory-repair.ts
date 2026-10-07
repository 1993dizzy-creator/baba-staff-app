import "server-only";
import { supabaseServer } from "@/lib/supabase/server";

export async function loadInventoryRepairPreview(inventoryLogId: number, actorUserId: number) {
  const { data, error } = await supabaseServer.rpc("ledger_inventory_purchase_repair_preview_v1", {
    p_inventory_log_id: inventoryLogId, p_actor_user_id: actorUserId,
  });
  if (error) throw error;
  return data;
}
