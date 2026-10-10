export type DailyPurchaseRow = { id: number; reason?: unknown; change_quantity?: unknown; correction_of_inventory_log_id?: unknown; [key: string]: unknown };
/** Display projection only: raw audit logs and accounting amounts remain untouched. */
export function projectDailyEffectivePurchases<T extends DailyPurchaseRow>(logs: readonly T[], corrections: readonly DailyPurchaseRow[]): T[] {
    const roots = logs.filter(row => row.reason === "purchase" && Number(row.change_quantity) > 0 && row.correction_of_inventory_log_id == null);
    const rootIds = new Set(roots.map(row => row.id));
    const projected = roots.flatMap(root => {
      const linked = corrections.filter(row => Number(row.correction_of_inventory_log_id) === root.id);
      const quantity = Number((Number(root.change_quantity) + linked.reduce((sum, row) => sum + Number(row.change_quantity ?? 0), 0)).toFixed(6));
      if (quantity <= 0) return [];
      const latest = linked.at(-1);
      return [{ ...root, ...(latest ? { item_name: latest.item_name, item_name_vi: latest.item_name_vi, new_purchase_price: latest.new_purchase_price, new_supplier: latest.new_supplier } : {}), change_quantity: quantity }];
    });
    const remaining = logs.filter(row => !rootIds.has(row.id) && row.correction_of_inventory_log_id == null);
    return [...remaining, ...projected] as T[];
}
