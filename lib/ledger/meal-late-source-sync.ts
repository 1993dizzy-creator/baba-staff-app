export type MealSourceRow = {
  businessDate: string;
  sourceKey: string;
  amount: number;
  active: boolean;
  snapshot: Record<string, unknown>;
  fingerprint: string;
  categoryId: number | null;
};

export function selectMealSyncActor<T extends { role: string }>(actors: readonly T[]): T | null {
  return actors.find((actor) => String(actor.role).toLowerCase() === "owner")
    ?? actors.find((actor) => String(actor.role).toLowerCase() === "master")
    ?? null;
}

export function previousVietnamBusinessDate(now: Date): string {
  // The store's business day changes at 03:00 Vietnam time.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(now.getTime() - 3 * 60 * 60 * 1000));
}

export async function syncConfirmedMealSource(input: {
  month: string;
  latestBusinessDate: string;
  candidates: readonly { status: string; sourceKey: string }[];
  loadRows: (month: string) => Promise<readonly MealSourceRow[]>;
  syncRows: (rows: readonly MealSourceRow[]) => Promise<{ status: string; driftCount?: number }>;
}) {
  const { month, latestBusinessDate } = input;
  const keys = new Set(input.candidates
    .filter((candidate) => candidate.status === "confirmed" &&
      /^meal:\d{4}-\d{2}-\d{2}$/.test(candidate.sourceKey) &&
      candidate.sourceKey.slice(5, 12) === month &&
      candidate.sourceKey.slice(5) <= latestBusinessDate)
    .map((candidate) => candidate.sourceKey));
  if (keys.size === 0) {
    return { status: "no_confirmed_candidate" as const };
  }
  const rows = await input.loadRows(month);
  // Include inactive rows: a removed attendance record also changes a confirmed source.
  const confirmedRows = rows.filter((row) => keys.has(row.sourceKey) && row.sourceKey === `meal:${row.businessDate}`);
  if (confirmedRows.length !== keys.size) throw new Error("MEAL_SOURCE_ROW_NOT_FOUND");
  const result = await input.syncRows(confirmedRows);
  if (result.status !== "ok") throw new Error(`MEAL_SYNC_${result.status.toUpperCase()}`);
  return { status: "synced" as const, scannedCount: confirmedRows.length, driftCount: result.driftCount ?? 0 };
}
