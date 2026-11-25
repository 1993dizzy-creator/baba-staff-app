/**
 * Table board read stages (2026-11-25 20:25-20:28: three PostgREST timeouts turned the whole
 * board unknown while every central collection succeeded, and nothing recorded which read failed).
 * One fixed log line per failed stage: stage, a sanitized code and the elapsed time only. Never a
 * message, payload, receipt, order, customer field, token or URL.
 */
export type TablesReadStage = "auto_context" | "cleaning_context" | "snapshot" | "receipts" | "response";
export const TABLES_READ_LOG = "[TABLES_READ_FAILED]";
/** Whole /api/tables server budget: well inside the board's 20-second request limit. */
export const TABLES_READ_BUDGET_MS = 12_000;
/** Below this a stage is not started (it could only fail the same way late). */
export const TABLES_READ_MIN_STAGE_MS = 1_000;

const FIXED = /^[A-Z][A-Z_]{2,39}$/;
/** PostgreSQL SQLSTATE, PostgREST PGRSTnnn, "timeout", one of our fixed codes, or "error". */
export function tablesReadErrorCode(error: unknown): string {
  if (!error || typeof error !== "object") return "error";
  const { code, name, message } = error as { code?: unknown; name?: unknown; message?: unknown };
  if (typeof code === "string" && /^(PGRST\d{3}|[0-9A-Z]{5})$/.test(code)) return code;
  const text = `${typeof name === "string" ? name : ""} ${typeof message === "string" ? message : ""}`;
  if (/abort|timeout|timed out/i.test(text)) return "timeout";
  if (typeof message === "string" && FIXED.test(message)) return message;
  return "error";
}
/** Statement timeout, PostgREST pool/connection timeout, or our own abort: repeating it only fails late. */
export const tablesReadTimedOut = (code: string) => code === "timeout" || code === "57014" || code === "PGRST003";

export function logTablesReadFailure(stage: TablesReadStage, error: unknown, startedAt: number,
  log: (...args: unknown[]) => void = console.error) {
  const code = tablesReadErrorCode(error);
  log(TABLES_READ_LOG, JSON.stringify({ stage, code, ms: Math.max(0, Math.round(Date.now() - startedAt)) }));
  return code;
}

/** Shared deadline for one request. Each stage gets only the time that is left. */
export function tablesReadBudget(totalMs = TABLES_READ_BUDGET_MS, start = Date.now()) {
  const deadline = start + totalMs;
  return {
    start,
    remaining: () => deadline - Date.now(),
    allows: (minimum = TABLES_READ_MIN_STAGE_MS) => deadline - Date.now() >= minimum,
    signal: () => AbortSignal.timeout(Math.max(1, deadline - Date.now())),
  };
}
export type TablesReadBudget = ReturnType<typeof tablesReadBudget>;
