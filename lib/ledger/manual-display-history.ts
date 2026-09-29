export type ManualDisplayHistoryEntry = {
  createdAt: string;
  actorName: string | null;
  reason: string;
  beforeTitle: string | null;
  afterTitle: string | null;
  beforeMemo: string | null;
  afterMemo: string | null;
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
  const display = record(record(snapshot)?.display_snapshot);
  return text(display?.titleOverride);
}

function memo(snapshot: unknown): string | null {
  return text(record(snapshot)?.memo);
}

function actorName(value: unknown): string | null {
  const actor = record(Array.isArray(value) ? value[0] : value);
  return [actor?.name, actor?.full_name, actor?.username]
    .map(text).find(name => name !== null && name.trim() !== "") ?? null;
}

export function projectManualDisplayHistory(row: AuditRecord): ManualDisplayHistoryEntry {
  return {
    createdAt: row.created_at,
    actorName: actorName(row.actor),
    reason: row.reason ?? "",
    beforeTitle: title(row.before_snapshot),
    afterTitle: title(row.after_snapshot),
    beforeMemo: memo(row.before_snapshot),
    afterMemo: memo(row.after_snapshot),
  };
}

