import type { TableOverview } from "./table-overview.ts";

export type PaymentObservation = { receiptId: number; firstVerifiedAt: string; expiresAt: string; expired: boolean };

/** A new DB-generated activation key is required for every OFF -> ON cycle. */
export function autoNormalActivation() {
  const key = process.env.BABA_TABLE_AUTO_NORMAL_ACTIVATION?.trim();
  return process.env.BABA_TABLE_AUTO_NORMAL_ENABLED?.trim() === "true"
    && process.env.POS_OPEN_ORDERS_READ_ENABLED?.trim() === "true"
    && key && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(key) ? key : null;
}

/** Only the server's current verified paid state can be retired. Never certify vacancy. */
export function applyPaymentObservations(overview: TableOverview, observations: Record<string, PaymentObservation>,
  eligible: Record<string, { receiptId: number }>, reviewTableIds: string[] = []) {
  for (const table of overview.tables) {
    if (table.state === "idle" && reviewTableIds.includes(table.id) && !eligible[table.id]) table.state = "unknown";
    if (table.state !== "paid") continue;
    const key = eligible[table.id], observation = observations[table.id];
    // Independent DB evidence is stricter than the display projection (e.g. merge conflicts).
    // A verified merged payment stays paid for display only: merge membership has no cleaning
    // key, so it never gets a timer, an automatic return to normal or a cleaning action.
    if (!key) { if (!table.merge?.paid) table.state = "unknown"; continue; }
    if (!observation || observation.receiptId !== key.receiptId) continue;
    const start = Date.parse(observation.firstVerifiedAt), end = Date.parse(observation.expiresAt), now = Date.parse(overview.serverNow);
    if (!Number.isFinite(start) || end - start !== 30 * 60_000 || start > now) continue;
    table.paymentObservation = observation;
    if (observation.expired && now >= end) table.state = "idle";
  }
  if (overview.summary.paid !== null) overview.summary.paid = overview.tables.filter(t => t.state === "paid").length;
  overview.summary.unknown = overview.tables.filter(t => t.state === "unknown").length;
  if (overview.summary.unknown) {
    overview.summary.occupied = null; overview.summary.paid = null;
    if (overview.summary.occupiedConfirmed != null) overview.summary.occupiedPartial = true;
  }
}
