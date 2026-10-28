// Manual reserve entry kinds accepted by ledger_create_reserve_entry_v2. 'regular' is only
// booked by confirming a recurring schedule, never by hand.
export const RESERVE_MANUAL_KINDS = ["extra", "restore", "release", "consume"] as const;
export type ReserveManualKind = (typeof RESERVE_MANUAL_KINDS)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ReserveEntryRequest = {
  kind: ReserveManualKind;
  amount: number;
  restoresEntryId: number | null;
  memo: string | null;
  requestKey: string;
};

// The body never carries a date: v2 books the entry now (no back-dating).
export function parseReserveEntryRequest(body: unknown): ReserveEntryRequest | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const value = body as Record<string, unknown>;
  const allowed = new Set(["kind", "amount", "restoresEntryId", "memo", "requestKey"]);
  if (Object.keys(value).some(key => !allowed.has(key))) return null;
  const kind = value.kind;
  if (typeof kind !== "string" || !(RESERVE_MANUAL_KINDS as readonly string[]).includes(kind)) return null;
  const amount = typeof value.amount === "number" ? value.amount : NaN;
  if (!Number.isFinite(amount) || amount <= 0 || Math.round(amount * 1000) !== amount * 1000) return null;
  const restoresEntryId = value.restoresEntryId == null ? null : Number(value.restoresEntryId);
  if ((kind === "restore") !== (restoresEntryId !== null)) return null;
  if (restoresEntryId !== null && (!Number.isSafeInteger(restoresEntryId) || restoresEntryId < 1)) return null;
  if (value.memo != null && (typeof value.memo !== "string" || value.memo.length > 500)) return null;
  if (typeof value.requestKey !== "string" || !UUID.test(value.requestKey)) return null;
  const memo = typeof value.memo === "string" && value.memo.trim() ? value.memo.trim() : null;
  return { kind: kind as ReserveManualKind, amount, restoresEntryId, memo, requestKey: value.requestKey };
}

type RestoreSourceEntry = { id: number; entry_type: string; amount: number | string; occurred_at: string; allocation_kind?: string | null; restores_entry_id?: number | null };

// Releases that still have an amount left to restore (release − restores linked to it).
export function restorableReleases(entries: readonly RestoreSourceEntry[]) {
  return entries
    .filter(entry => entry.entry_type === "release")
    .map(entry => {
      const restored = entries
        .filter(row => row.allocation_kind === "restore" && Number(row.restores_entry_id) === entry.id)
        .reduce((sum, row) => sum + Number(row.amount), 0);
      return { id: entry.id, occurredAt: entry.occurred_at, released: Number(entry.amount), restored, remaining: Number(entry.amount) - restored };
    })
    .filter(row => row.remaining > 0);
}
