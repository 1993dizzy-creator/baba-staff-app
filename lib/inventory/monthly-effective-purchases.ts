export type MonthlyPurchaseLog = {
  id: number;
  item_id: number | null;
  item_name: string | null;
  item_name_vi: string | null;
  part: string | null;
  category: string | null;
  category_vi: string | null;
  change_quantity: string | number | null;
  unit: string | null;
  code: string | null;
  new_purchase_price: string | number | null;
  new_supplier: string | null;
  reason: string | null;
  business_date: string | null;
  correction_of_inventory_log_id: number | null;
};

export type MonthlyEffectivePurchase = {
  rootLogId: number;
  correctionLogIds: number[];
  item_id: number | null;
  item_name: string | null;
  item_name_vi: string | null;
  part: string | null;
  category: string | null;
  category_vi: string | null;
  unit: string | null;
  code: string | null;
  new_purchase_price: string | number | null;
  new_supplier: string | null;
  business_date: string | null;
  effectiveQuantity: number;
};

const toFiniteNumber = (value: unknown) => {
  const numberValue = Number(value ?? 0);
  return Number.isFinite(numberValue) ? numberValue : 0;
};

const roundQuantity = (value: number) => Math.round(value * 1000) / 1000;

export const isMonthlyPurchaseRoot = (log: MonthlyPurchaseLog) =>
  String(log.reason ?? "").trim().toLowerCase() === "purchase" &&
  toFiniteNumber(log.change_quantity) > 0 &&
  log.correction_of_inventory_log_id === null;

/**
 * Projects raw purchase roots and their explicitly linked correction rows into
 * the purchases that actually remain for monthly reporting. Corrections are
 * quantity deltas, not independent purchases. Their latest row (highest ID)
 * contains the post-correction price, supplier, and display metadata; those
 * values are intentionally used even when null because null can be the saved
 * result of a correction rather than a signal to fall back to the root.
 */
export function buildMonthlyEffectivePurchases(
  monthlyLogs: readonly MonthlyPurchaseLog[],
  linkedCorrections: readonly MonthlyPurchaseLog[]
): MonthlyEffectivePurchase[] {
  const correctionsByRootId = new Map<number, MonthlyPurchaseLog[]>();

  for (const correction of linkedCorrections) {
    const rootId = Number(correction.correction_of_inventory_log_id);
    if (!Number.isSafeInteger(rootId) || rootId < 1) continue;
    const corrections = correctionsByRootId.get(rootId) ?? [];
    corrections.push(correction);
    correctionsByRootId.set(rootId, corrections);
  }

  const effectivePurchases: MonthlyEffectivePurchase[] = [];
  for (const root of monthlyLogs) {
    if (!isMonthlyPurchaseRoot(root)) continue;

    const corrections = [...(correctionsByRootId.get(Number(root.id)) ?? [])]
      .sort((left, right) => Number(left.id) - Number(right.id));
    const effectiveQuantity = roundQuantity(
      toFiniteNumber(root.change_quantity) +
      corrections.reduce(
        (sum, correction) => sum + toFiniteNumber(correction.change_quantity),
        0
      )
    );

    if (effectiveQuantity <= 0) continue;

    const latest = corrections.at(-1);
    effectivePurchases.push({
      rootLogId: Number(root.id),
      correctionLogIds: corrections.map((correction) => Number(correction.id)),
      item_id: root.item_id,
      item_name: latest ? latest.item_name : root.item_name,
      item_name_vi: latest ? latest.item_name_vi : root.item_name_vi,
      part: latest ? latest.part : root.part,
      category: latest ? latest.category : root.category,
      category_vi: latest ? latest.category_vi : root.category_vi,
      unit: latest ? latest.unit : root.unit,
      code: latest ? latest.code : root.code,
      new_purchase_price: latest
        ? latest.new_purchase_price
        : root.new_purchase_price,
      new_supplier: latest ? latest.new_supplier : root.new_supplier,
      business_date: root.business_date,
      effectiveQuantity,
    });
  }

  return effectivePurchases;
}
