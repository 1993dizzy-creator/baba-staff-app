import "server-only";
import { supabaseServer } from "@/lib/supabase/server";
import { buildInventoryDeductionPreview } from "@/lib/sales/inventory-deduction-preview";
import { getReceiptContentFingerprint } from "@/lib/sales/inventory-deduction-fingerprint";
import { getOptionIdentity } from "@/lib/sales/inventory-deduction-unified-preview";

export async function getResolutionWork(receiptId: number, actorId: number) {
  const { data, error } = await supabaseServer.rpc("sales_get_admin_resolution_work_v2", {
    p_receipt_id: receiptId, p_actor_user_id: actorId,
  });
  if (error) throw new Error(error.message);
  return data;
}

// Plan construction never writes a batch or releases the receipt. Only the
// confirm RPC creates candidates and invokes the existing engines atomically.
export async function previewResolutionInventory(receiptId: number, actorId: number) {
  const work = await getResolutionWork(receiptId, actorId);
  const r = work.state.receipt;
  const lines = work.state.lines as Array<Record<string, unknown>>;
  const deductions = work.deductions as Array<Record<string, unknown>>;
  const successful = (d: Record<string, unknown>) => ["applied", "success", "reverted"].includes(String(d.status)) || Boolean(d.applied_at || d.inventory_log_id);
  const originals = deductions.filter(d => d.operation_type !== "revert" && successful(d));
  const active = originals.filter(d => !deductions.some(reverse => String(reverse.reversal_of_deduction_id) === String(d.id) && successful(reverse)));
  const keys = active.map(d => [d.receipt_line_id, d.inventory_item_id, d.mapping_id, d.recipe_id].join(":"));
  const blockers: string[] = [];
  if (deductions.some(d => successful(d) && !d.receipt_id)) blockers.push("legacy_inventory_link_requires_review");
  if (deductions.some(d => d.receipt_id && Number(d.receipt_id) !== receiptId)) blockers.push("cross_receipt_inventory_history");
  if (new Set(keys).size !== keys.length) blockers.push("duplicate_active_deductions");
  const contentFingerprint = getReceiptContentFingerprint({
    receiptId, refId: r.ref_id, source: r.source, paymentStatus: r.payment_status, isCanceled: r.is_canceled,
    lines: lines.map(l => ({ itemId: l.item_id as string | null, itemCode: l.item_code as string | null,
      optionIdentity: getOptionIdentity(l.raw_json), refDetailId: l.ref_detail_id as string | null, parentRefDetailId: l.parent_ref_detail_id as string | null,
      quantity: l.quantity as string | number | null, isOption: l.is_option as boolean | null,
      isExcluded: l.is_excluded as boolean | null, isCanceled: l.is_canceled as boolean | null,
      refDetailType: l.ref_detail_type as number | null, inventoryItemType: l.inventory_item_type as number | null })),
  });
  let plan: Record<string, unknown> = { workflow: active.length ? "rollback_canceled" : "no_stock_change", activeCount: active.length, contentFingerprint, lines: [] };
  if (!r.is_canceled) {
    const preview = await buildInventoryDeductionPreview({ businessDateFrom: r.business_date, businessDateTo: r.business_date,
      receiptIds: [receiptId], resolutionReview: true });
    const receipt = preview.receipts.find(p => p.receiptId === receiptId);
    if (!receipt) blockers.push("effective_receipt_not_found");
    else {
      for (const line of receipt.lines) {
        // Kegs and manual mappings require their own verified lifecycle. Never
        // silently omit them or interpret a monetary match as stock proof.
        if (line.isKegTracked || line.mappingType === "manual" || line.mappingType === "combo") blockers.push("special_mapping_requires_review");
        if (line.blocksReceipt || !["ready", "already_applied", "applied_after_modified", "ignore", "ignored", "skipped"].includes(line.status))
          blockers.push(line.status);
      }
      if (!receipt.lines.some(l => l.deductions.length)) blockers.push("no_verified_deduction_candidates");
      plan = { workflow: originals.length ? "reprocess_modified" : "initial_apply", activeCount: active.length,
        contentFingerprint, inventoryHash: receipt.inventoryAffectingHash, amountHash: receipt.amountHash,
        hashVersion: receipt.hashVersion, lines: receipt.lines, inventoryTotals: preview.inventoryTotals,
        previousDeductions: active.map(d => ({ id: d.id, inventoryItemId: d.inventory_item_id, quantity: d.deduct_quantity_total ?? d.deduct_quantity })) };
    }
  }
  plan = { ...plan, expectedRevision: r.revision, resolutionVersion: work.version, sourceFingerprint: work.fingerprint,
    amount: r.is_canceled ? 0 : Number(r.final_amount), payments: work.state.payments?.filter((p: Record<string, unknown>) => !p.admin_resolution_retired)
      .map((p: Record<string, unknown>) => ({ paymentName: p.payment_name, amount: p.amount })) || [] };
  const { data, error } = await supabaseServer.rpc("sales_preview_admin_resolution_inventory_v2", {
    p_receipt_id: receiptId, p_actor_user_id: actorId, p_context: work.contextFingerprint, p_plan: plan, p_blockers: [...new Set(blockers)],
  });
  if (error) throw new Error(error.message);
  return data;
}
