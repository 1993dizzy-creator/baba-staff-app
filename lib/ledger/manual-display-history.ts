export type ManualDisplayHistoryEntry = {
  createdAt: string;
  actorName: string | null;
  reason: string;
  beforeTitle: string | null;
  afterTitle: string | null;
  beforeMemo: string | null;
  afterMemo: string | null;
  beforeAmount?: number;
  afterAmount?: number;
};

type AuditRecord = {
  created_at: string;
  reason: string | null;
  before_snapshot: unknown;
  after_snapshot: unknown;
  actor: unknown;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function title(snapshot: unknown): string | null {
  const display = record(transaction(snapshot)?.display_snapshot);
  return text(display?.titleOverride);
}

function memo(snapshot: unknown): string | null {
  return text(transaction(snapshot)?.memo);
}

function transaction(snapshot: unknown): Record<string, unknown> | null {
  const outer = record(snapshot);
  return record(outer?.transaction) ?? outer;
}

function amount(snapshot: unknown): number | null {
  const value = transaction(snapshot)?.amount;
  const number = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(number) ? number : null;
}

function actorName(value: unknown): string | null {
  const actor = record(Array.isArray(value) ? value[0] : value);
  return [actor?.name, actor?.full_name, actor?.username]
    .map(text).find(name => name !== null && name.trim() !== "") ?? null;
}

export function projectManualDisplayHistory(row: AuditRecord): ManualDisplayHistoryEntry {
  const fullEdit = record(row.after_snapshot)?.transaction != null;
  const beforeAmount = amount(row.before_snapshot);
  const afterAmount = amount(row.after_snapshot);
  return {
    createdAt: row.created_at,
    actorName: actorName(row.actor),
    reason: row.reason ?? "",
    beforeTitle: title(row.before_snapshot),
    afterTitle: title(row.after_snapshot),
    beforeMemo: memo(row.before_snapshot),
    afterMemo: memo(row.after_snapshot),
    ...(fullEdit && beforeAmount !== null && afterAmount !== null ? { beforeAmount, afterAmount } : {}),
  };
}

