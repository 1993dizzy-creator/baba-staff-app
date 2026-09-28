export type PurchaseRoot = {
  id: number;
  item_id: number;
  business_date: string;
  created_at: string;
  reason: string;
  change_quantity: number;
  correction_of_inventory_log_id: number | null;
  unit: string | null;
  new_supplier: string | null;
  purchase_supplier_partner_id: number | null;
  new_purchase_price: number | null;
};

export function nearestPriorPurchaseRoot(
  rows: readonly PurchaseRoot[], itemId: number, businessDate: string, before: string,
) {
  return rows.filter(row =>
    row.item_id === itemId && row.business_date === businessDate &&
    row.reason === "purchase" && Number(row.change_quantity) > 0 &&
    row.correction_of_inventory_log_id == null &&
    Date.parse(row.created_at) <= Date.parse(before),
  ).sort((a, b) =>
    Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id,
  )[0] ?? null;
}

export function purchaseCorrectionIdentityMatches(
  root: PurchaseRoot,
  next: { unit: unknown; supplier: unknown; supplier_partner_id: unknown; purchase_price: unknown },
) {
  if (root.unit !== next.unit || !Number.isFinite(Number(next.purchase_price)) || Number(next.purchase_price) <= 0) return false;
  const rootPartner = root.purchase_supplier_partner_id;
  const nextPartner = next.supplier_partner_id == null ? null : Number(next.supplier_partner_id);
  if (rootPartner != null && nextPartner != null) return rootPartner === nextPartner;
  return String(root.new_supplier ?? "").trim().toLowerCase() === String(next.supplier ?? "").trim().toLowerCase();
}

export function purchaseFamilyAllowsDelta(rootQuantity: number, correctionQuantities: readonly number[], delta: number) {
  return Number.isFinite(delta) && rootQuantity + correctionQuantities.reduce((sum, quantity) => sum + quantity, 0) + delta >= 0;
}
