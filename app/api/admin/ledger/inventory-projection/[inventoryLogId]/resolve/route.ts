import { ledgerJson, requireLedgerActor } from "@/lib/ledger/server";
import { supabaseServer } from "@/lib/supabase/server";
import { loadInventoryRepairPreview } from "@/lib/ledger/inventory-repair";

type Context = { params: Promise<{ inventoryLogId: string }> };
const validId = (value: unknown) => Number.isSafeInteger(Number(value)) && Number(value) > 0;

export async function GET(_request: Request, context: Context) {
  const auth = await requireLedgerActor();
  if (!auth.actor) return auth.response;
  const { inventoryLogId } = await context.params;
  if (!validId(inventoryLogId)) return ledgerJson({ ok: false, code: "INVALID_ID" }, 400);
  try {
    const preview = await loadInventoryRepairPreview(Number(inventoryLogId), auth.actor.id);
    return ledgerJson({ ...preview, ok: preview?.status === "ok" }, preview?.status === "ok" ? 200 : 409);
  } catch {
    return ledgerJson({ ok: false, code: "REPAIR_PREVIEW_UNAVAILABLE" }, 503);
  }
}

export async function POST(request: Request, context: Context) {
  const auth = await requireLedgerActor();
  if (!auth.actor) return auth.response;
  const { inventoryLogId } = await context.params;
  let body;
  try { body = await request.json(); } catch { return ledgerJson({ ok: false, code: "INVALID_PAYLOAD" }, 400); }
  if (!validId(inventoryLogId) || !validId(body?.purchaseLogId)) return ledgerJson({ ok: false, code: "INVALID_ID" }, 400);
  try {
    const { data, error } = await supabaseServer.rpc("ledger_resolve_inventory_purchase_correction_v1", {
      p_inventory_log_id: Number(inventoryLogId), p_purchase_log_id: Number(body.purchaseLogId),
      p_actor_user_id: auth.actor.id,
    });
    if (error) throw error;
    return ledgerJson({ ...data, ok: data?.status === "synced" }, data?.status === "synced" ? 200 : 409);
  } catch {
    return ledgerJson({ ok: false, code: "REPAIR_UNAVAILABLE" }, 503);
  }
}
