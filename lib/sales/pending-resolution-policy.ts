export const PENDING_RESOLUTION_DELAY_MS = 30 * 60 * 1000;

// Stored timestamptz values must carry an explicit offset. Never use the host TZ.
function instant(value: unknown): number | null {
  if (typeof value !== "string" || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return null;
  const result = Date.parse(value);
  return Number.isFinite(result) ? result : null;
}

export function pendingResolutionEligibility(row: {
  source: string | null; payment_status: number | null; is_canceled: boolean | null;
  ref_date: string | null; created_at: string | null;
}, now = Date.now()) {
  const ref = instant(row.ref_date);
  const fallbackReason = ref === null ? "invalid_ref_date" : ref > now ? "future_ref_date" : null;
  const start = fallbackReason ? instant(row.created_at) : ref;
  const eligibleAt = start === null ? null : new Date(start + PENDING_RESOLUTION_DELAY_MS).toISOString();
  const pending = row.source === "cukcuk" && row.payment_status === 1 && row.is_canceled !== true;
  return {
    pending, eligible: pending && start !== null && start + PENDING_RESOLUTION_DELAY_MS <= now,
    eligibleAt, fallbackReason, basis: fallbackReason ? "created_at" : "ref_date",
    serverNow: new Date(now).toISOString(),
  };
}

export type ResolutionPayment = { method: "cash" | "transfer" | "card" | "other"; amount: number };
export function validResolutionPayments(amount: unknown, payments: unknown): payments is ResolutionPayment[] {
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount <= 0 || amount > 1_000_000_000_000 ||
      !Array.isArray(payments) || payments.length < 1 || payments.length > 4) return false;
  const methods = new Set<string>();
  let total = 0;
  for (const payment of payments) {
    if (!payment || typeof payment !== "object" || !["cash", "transfer", "card", "other"].includes(payment.method) ||
        methods.has(payment.method) || typeof payment.amount !== "number" || !Number.isSafeInteger(payment.amount) || payment.amount <= 0) return false;
    methods.add(payment.method);
    total += payment.amount;
  }
  return total === amount;
}

// A warning, never permission to remove a line. Different detail IDs do not
// eliminate duplicate suspicion, including on receipts with admin edits.
export function duplicateLineGroups(lines: Array<{
  id?: number; item_code?: string | null; item_name?: string | null; quantity?: unknown;
  unit_price?: unknown; parent_ref_detail_id?: string | null; is_excluded?: boolean | null;
}>) {
  const groups = new Map<string, number[]>();
  lines.forEach((line, index) => {
    if (line.is_excluded === true) return;
    const key = JSON.stringify([line.item_code || line.item_name, Number(line.quantity), Number(line.unit_price), line.parent_ref_detail_id || null]);
    groups.set(key, [...(groups.get(key) || []), line.id ?? index]);
  });
  return [...groups.values()].filter(group => group.length > 1);
}
