import "server-only";
import { supabaseServer } from "@/lib/supabase/server";
import { autoNormalActivation } from "./table-auto-normal";
import { readCleaningState } from "./table-cleaning-server";

/** Called with Next after() only after a successful central collection commit.
 * Independent RPC/transaction; no provider access and no effect on the collector result.
 * Failed observations are retried by the next successful collection, never by GET.
 */
export async function observeVerifiedPayments() {
  const activation = autoNormalActivation();
  if (!activation) return;
  try {
    const state = await readCleaningState(new Date(), 2_000);
    if (!state?.context.observations || state.base.snapshotStatus !== "ok") return;
    const tables = state.base.tables.filter(t => t.state === "paid" && state.context.keys[t.id]?.autoKey)
      .map(t => ({ tableId: t.id, receiptId: state.context.keys[t.id].receiptId, autoKey: state.context.keys[t.id].autoKey }));
    if (!tables.length) return;
    const result = await supabaseServer.rpc("tables_observe_payments_v1", { p_scope: state.scope, p_day: state.day,
      p_activation: activation, p_tables: tables, p_snapshot: state.context.snapshot, p_receipts: state.context.receipts })
      .abortSignal(AbortSignal.timeout(2_000));
    if (result.error) throw Error("observation_failed");
  } catch {
    // Fixed diagnostic only: no provider payload, credentials, customer data or raw SQL.
    console.error("[TABLE_PAYMENT_OBSERVATION_FAILED]");
  }
}
