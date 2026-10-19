export type DailyPurchaseRow = { id: number; reason?: unknown; change_quantity?: unknown; correction_of_inventory_log_id?: unknown; [key: string]: unknown };
export type DailyPurchaseDiagnostic = {
  code: "unlinked_nonpositive_purchase" | "invalid_purchase_quantity" | "invalid_correction_family" | "fully_cancelled" | "linked_correction";
  logId: number; rootLogId: number | null; logIds: number[]; quantity: number | null; log: DailyPurchaseRow;
};

/** Read-only projection. Only explicit correction links change a receipt's quantity. */
export function analyzeDailyEffectivePurchases<T extends DailyPurchaseRow>(logs: readonly T[], corrections: readonly DailyPurchaseRow[]) {
  const roots = logs.filter(row => row.reason === "purchase" && Number(row.change_quantity) > 0 && row.correction_of_inventory_log_id == null);
  const rootIds = new Set(roots.map(row => row.id));
  const byRoot = new Map<number, Map<number, DailyPurchaseRow>>();
  for (const row of corrections) {
    const id = Number(row.correction_of_inventory_log_id);
    if (!rootIds.has(id)) continue;
    const family = byRoot.get(id) ?? new Map(); family.set(row.id, row); byRoot.set(id, family);
  }
  const diagnostics: DailyPurchaseDiagnostic[] = [];
  const projected = roots.flatMap(root => {
    const linked = [...(byRoot.get(root.id)?.values() ?? [])].sort((a,b) => a.id-b.id);
    const valid = Number.isFinite(Number(root.change_quantity)) && linked.every(row => row.reason === "purchase" &&
      Number.isFinite(Number(row.change_quantity)) && row.change_quantity != null &&
      (row.item_id == null || root.item_id == null || Number(row.item_id) === Number(root.item_id)));
    const quantity = valid ? Number((Number(root.change_quantity) + linked.reduce((sum,row) => sum+Number(row.change_quantity),0)).toFixed(6)) : NaN;
    if (!valid || !Number.isFinite(quantity) || quantity < 0) {
      diagnostics.push({code:"invalid_correction_family",logId:root.id,rootLogId:root.id,logIds:[root.id,...linked.map(row=>row.id)],quantity:Number.isFinite(quantity)?quantity:null,log:root});
      return [];
    }
    if (quantity === 0) {
      diagnostics.push({code:"fully_cancelled",logId:root.id,rootLogId:root.id,logIds:[root.id,...linked.map(row=>row.id)],quantity:0,log:root});
      return [];
    }
    const latest = linked.at(-1);
    return [{...root,...(latest?{item_name:latest.item_name,item_name_vi:latest.item_name_vi,new_purchase_price:latest.new_purchase_price,new_supplier:latest.new_supplier}:{}),change_quantity:quantity}];
  });
  const remaining = logs.filter(row => !rootIds.has(row.id) && row.correction_of_inventory_log_id == null);
  for (const log of remaining) if (log.reason === "purchase") {
    const quantity = Number(log.change_quantity);
    diagnostics.push({code:!Number.isFinite(quantity)||log.change_quantity==null?"invalid_purchase_quantity":"unlinked_nonpositive_purchase",
      logId:log.id,rootLogId:null,logIds:[log.id],quantity:Number.isFinite(quantity)?quantity:null,log});
  }
  // A correction recorded today can refer to an earlier day's receipt. Keep it
  // visible in the audit panel without treating it as a new receipt or an error.
  for (const log of logs) if (log.correction_of_inventory_log_id != null && !rootIds.has(Number(log.correction_of_inventory_log_id))) {
    const quantity = Number(log.change_quantity);
    diagnostics.push({code:"linked_correction",logId:log.id,rootLogId:Number(log.correction_of_inventory_log_id),
      logIds:[Number(log.correction_of_inventory_log_id),log.id],quantity:Number.isFinite(quantity)?quantity:null,log});
  }
  return {purchases:[...remaining,...projected] as T[],diagnostics};
}

/** Compatibility entry point: retain raw unlinked audit rows for existing readers. */
export function projectDailyEffectivePurchases<T extends DailyPurchaseRow>(logs: readonly T[], corrections: readonly DailyPurchaseRow[]): T[] {
  return analyzeDailyEffectivePurchases(logs,corrections).purchases;
}
