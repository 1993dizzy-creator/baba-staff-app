export type DailyItemLogRow = {
  id: number;
  reason?: string | null;
  change_quantity?: number | string | null;
  correction_of_inventory_log_id?: number | null;
  business_date?: string | null;
  created_at?: string | null;
  new_purchase_price?: number | string | null;
  new_supplier?: string | null;
  purchase_supplier_partner_id?: number | null;
  ledger_projection_status?: string | null;
};

export type DailyItemLogEntry<T extends DailyItemLogRow> =
  | { kind: "log"; key: string; log: T; sortAt: string }
  | {
    kind: "purchase"; key: string; root: T; corrections: T[];
    /** Root with the family's effective quantity and latest purchase details. */
    final: T; effectiveQuantity: number; cancelled: boolean; invalid: boolean;
    /** Stock already changed but the Ledger waits for the owner (or failed). */
    ledgerReviewPending: boolean;
    rootOutsideDay: boolean; sortAt: string;
  };

const isPurchaseRoot = (row: DailyItemLogRow) =>
  row.reason === "purchase" && Number(row.change_quantity) > 0 && row.correction_of_inventory_log_id == null;

const latestAt = (rows: readonly DailyItemLogRow[]) =>
  rows.reduce((latest, row) => String(row.created_at ?? "") > latest ? String(row.created_at ?? "") : latest, "");

/**
 * Display-only view of one business day. Each original receipt and its
 * explicitly linked corrections become one card in the final state; separate
 * receipts of the same item stay separate. Source rows are never altered.
 */
export function buildDailyItemLogEntries<T extends DailyItemLogRow>(logs: readonly T[], businessDate: string): DailyItemLogEntry<T>[] {
  const byId = new Map(logs.map(row => [Number(row.id), row]));
  const families = new Map<number, T[]>();
  for (const row of logs) {
    if (row.correction_of_inventory_log_id == null) continue;
    const rootId = Number(row.correction_of_inventory_log_id);
    const root = byId.get(rootId);
    if (!root || !isPurchaseRoot(root)) continue;
    families.set(rootId, [...(families.get(rootId) ?? []), row]);
  }
  const grouped = new Set<number>();
  const entries: DailyItemLogEntry<T>[] = [];
  for (const root of logs) {
    if (!isPurchaseRoot(root)) continue;
    const corrections = [...(families.get(Number(root.id)) ?? [])].sort((a, b) => Number(a.id) - Number(b.id));
    if (root.business_date !== businessDate && !corrections.some(row => row.business_date === businessDate)) continue;
    grouped.add(Number(root.id));
    corrections.forEach(row => grouped.add(Number(row.id)));
    const quantities = [root, ...corrections].map(row => Number(row.change_quantity));
    const invalid = quantities.some(quantity => !Number.isFinite(quantity)) ||
      corrections.some(row => row.reason !== "purchase");
    const effectiveQuantity = invalid ? NaN : Number(quantities.reduce((sum, quantity) => sum + quantity, 0).toFixed(6));
    const latest = corrections.at(-1);
    const final = {
      ...root,
      ...(latest ? {
        new_purchase_price: latest.new_purchase_price,
        new_supplier: latest.new_supplier,
        purchase_supplier_partner_id: latest.purchase_supplier_partner_id,
      } : {}),
      change_quantity: invalid ? root.change_quantity : effectiveQuantity,
    } as T;
    entries.push({
      kind: "purchase", key: `purchase-${root.id}`, root, corrections, final, effectiveQuantity,
      cancelled: !invalid && effectiveQuantity === 0, invalid: invalid || effectiveQuantity < 0,
      ledgerReviewPending: [root, ...corrections].some(row => row.ledger_projection_status === "review_required" || row.ledger_projection_status === "failed"),
      rootOutsideDay: root.business_date !== businessDate, sortAt: latestAt([root, ...corrections]),
    });
  }
  for (const row of logs) {
    if (grouped.has(Number(row.id)) || row.business_date !== businessDate) continue;
    entries.push({ kind: "log", key: `log-${row.id}`, log: row, sortAt: String(row.created_at ?? "") });
  }
  return entries.sort((a, b) => b.sortAt.localeCompare(a.sortAt) ||
    Number(b.kind === "log" ? b.log.id : b.root.id) - Number(a.kind === "log" ? a.log.id : a.root.id));
}

