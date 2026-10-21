import "server-only";
import { supabaseServer } from "@/lib/supabase/server";
import { loginCukcuk } from "@/lib/pos/cukcuk/auth";
import { fetchSaInvoiceDetail, getInvoiceRefId, getPaymentStatus, getNumber } from "@/lib/pos/cukcuk/sales-receipt-sync";
import { resolutionSchemaReady } from "@/lib/sales/admin-resolution-server";

// Recheck is an observation, including old closed days. It never silently
// changes a closed financial source or assumes a POS error means paid/canceled.
export async function observePendingPos(refId: string, origin: "refresh" | "retry") {
  const signal = AbortSignal.timeout(10_000);
  const login = await loginCukcuk(signal);
  const payload = await fetchSaInvoiceDetail({ accessToken: login.accessToken, companyCode: login.companyCode, refId, signal });
  if (getInvoiceRefId(payload) !== refId) throw new Error("pos_ref_mismatch");
  const { error } = await supabaseServer.rpc("sales_observe_resolved_receipts_v1", { p_observations: [{
    refId, observedAt: new Date().toISOString(), origin, listStatus: null, detailStatus: getPaymentStatus(payload),
    amount: getNumber(payload, ["FinalAmount", "TotalAmount", "SaleAmount", "Amount"]), raw: { detail: payload },
  }] });
  if (error) throw new Error("pos_observation_failed");
}

export async function runPendingPosRechecks() {
  if (!resolutionSchemaReady() || process.env.POS_PENDING_RECHECK_ENABLED !== "true") return { enabled: false };
  const { data, error } = await supabaseServer.rpc("sales_claim_pending_rechecks_v1");
  if (error) return { enabled: true, error: "claim_failed" };
  let checked = 0; let failed = 0;
  for (const job of (data || []).slice(0, 3) as Array<{ receiptId: number; refId: string; leaseId: string }>) {
    let failure: string | null = null;
    try { await observePendingPos(job.refId, "retry"); checked++; }
    catch { failure = "pos_lookup_failed"; failed++; }
    const result = await supabaseServer.rpc("sales_finish_pending_recheck_v1", { p_receipt_id: job.receiptId, p_lease_id: job.leaseId, p_error: failure });
    if (result.error || result.data !== true) failed++;
  }
  return { enabled: true, checked, failed };
}
