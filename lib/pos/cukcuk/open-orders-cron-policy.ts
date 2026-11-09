// Pure policy for /api/cron/pos-open-orders-sync (no I/O): service window and the
// mapping of a central sync result to an HTTP response. Bodies carry only fixed
// outcome names, counts and safe error codes — never tokens, customer data or orders.

/** Vietnam is UTC+7 all year (no DST). */
const VN_OFFSET_MS = 7 * 3600_000;
/** First start minute of the service window: 17:30 (Asia/Ho_Chi_Minh). */
export const OPEN_ORDERS_CRON_FIRST_START_MINUTE = 17 * 60 + 30;
/**
 * Last start minute: 02:54 (inclusive, i.e. up to 02:54:59); 02:55:00 until 17:30 skip.
 * Even if the DB claim lands up to ~2 minutes after the cron start (cold start, store
 * settings RPC), the 3-minute lease still ends before the 03:00 business-day cutoff.
 */
export const OPEN_ORDERS_CRON_LAST_START_MINUTE = 2 * 60 + 54;

export function evaluateOpenOrdersCronWindow(now: Date) {
  const vn = new Date(now.getTime() + VN_OFFSET_MS);
  const minute = vn.getUTCHours() * 60 + vn.getUTCMinutes();
  const allowed = minute >= OPEN_ORDERS_CRON_FIRST_START_MINUTE || minute <= OPEN_ORDERS_CRON_LAST_START_MINUTE;
  return { allowed, vietnamTime: vn.toISOString().slice(11, 16) };
}

export type OpenOrdersCronOutcome =
  | "committed"
  | "skipped_disabled"
  | "skipped_outside_hours"
  | "skipped_busy"
  | "skipped_fresh"
  | "failed";

export type OpenOrdersCronResponse = {
  status: number;
  body: { ok: boolean; outcome: OpenOrdersCronOutcome; code?: string; orders?: number; lines?: number; vietnamTime?: string };
};

const SAFE_CODE = /^[a-z0-9_]{1,64}$/;
const safeCode = (value: unknown, fallback: string) => (typeof value === "string" && SAFE_CODE.test(value) ? value : fallback);
const count = (value: unknown) => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined);

/** Provider/collection failures are upstream problems (502); persistence/config are server problems (500). */
function failureStatus(code: string) {
  return /^(provider_|orders_|order_|run_deadline_exceeded$|collection_failed$)/.test(code) ? 502 : 500;
}

export function mapOpenOrdersSyncResult(result: Record<string, unknown> | null | undefined): OpenOrdersCronResponse {
  switch (result?.status) {
    case "committed":
      return { status: 200, body: { ok: true, outcome: "committed", orders: count(result.orders), lines: count(result.lines) } };
    case "busy":
      return { status: 200, body: { ok: true, outcome: "skipped_busy" } };
    case "fresh":
      return { status: 200, body: { ok: true, outcome: "skipped_fresh" } };
    case "not_enabled":
      return { status: 200, body: { ok: true, outcome: "skipped_disabled" } };
    case "failed": {
      const code = safeCode(result.code, "collection_failed");
      return { status: failureStatus(code), body: { ok: false, outcome: "failed", code } };
    }
    default:
      // e.g. a replayed claim status: never expected with fresh run ids.
      return { status: 500, body: { ok: false, outcome: "failed", code: "open_orders_unexpected_result" } };
  }
}

/** Maps an exception thrown outside the run's own failure handling to a safe code. */
export function openOrdersCronErrorCode(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (/^open_orders_[a-z_]{1,40}$/.test(message)) return message;
  if (message === "OPEN_ORDERS_SCOPE_UNAVAILABLE") return "open_orders_scope_unavailable";
  if (message.startsWith("Failed to calculate configured business date") || message.startsWith("Failed to load configured store setting")
    || message === "Invalid business-time timestamp") return "business_time_unavailable";
  return "open_orders_cron_failed";
}
