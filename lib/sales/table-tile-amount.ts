import type { TableTile } from "./table-overview.ts";
import { verifiedOrderStart } from "./table-detail-display.ts";

/** Display-only sum of verified current order headers; never changes sales/KPI values. */
export function verifiedCurrentOrderAmount(table: TableTile, snapshotAt: string | null, serverNow: string, snapshotStatus: string, businessDate: string) {
  if (!verifiedOrderStart(table, snapshotAt, serverNow, snapshotStatus, businessDate)) return null;
  const unique = new Map<string, string>();
  let amount = 0;
  for (const order of table.orders.filter(o => o.verifiedOpen)) {
    const key = order.id.trim().toLowerCase(), signature = JSON.stringify({ ...order, id: key });
    if (!key || order.detailsNeedReview || !order.lines?.length || !Number.isSafeInteger(order.amount) || order.amount < 0
      || order.lines.some(l => ![l.quantity, l.price, l.amount].every(n => Number.isFinite(n) && n >= 0))) return null;
    const previous = unique.get(key);
    if (previous) { if (previous !== signature) return null; else continue; }
    unique.set(key, signature); amount += order.amount;
    if (!Number.isSafeInteger(amount)) return null;
  }
  return unique.size ? amount : null;
}

/** Truncate only beyond 0.001 of a large unit; ≈ explicitly marks omitted VND.
 * k is exact (integer VND). Never rounds across a k/M boundary. Full VND is accessible.
 */
export function compactOrderAmount(amount: number) {
  if (!Number.isSafeInteger(amount) || amount < 0) return null;
  for (const [unit, suffix] of [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "k"]] as const) {
    if (amount < unit) continue;
    const step = unit / 1000, thousandths = Math.floor(amount / step);
    const whole = Math.floor(thousandths / 1000), fraction = String(thousandths % 1000).padStart(3, "0").replace(/0+$/, "");
    return `${amount % step ? "≈" : ""}${whole}${fraction ? "." + fraction : ""}${suffix}`;
  }
  return String(amount);
}
