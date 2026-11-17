import { calculateBusinessTimeContext, createFallbackBusinessTimeSnapshot, type BusinessTimeSnapshot } from "../store-settings/business-time-adapter-core.ts";
import { evaluateOpenOrdersCronWindow, OPEN_ORDERS_CRON_FIRST_START_MINUTE, OPEN_ORDERS_CRON_FIRST_RUN_MINUTE,
  OPEN_ORDERS_CRON_FIRST_SUCCESS_DEADLINE_MINUTE } from "../pos/cukcuk/open-orders-cron-policy.ts";

export type TableCollectionHealth = "waiting" | "healthy" | "delayed" | "collection_failed" | "read_failed"
  | "stale" | "evidence_conflict" | "unavailable" | "disabled";
export type TableCollectionPhase = "before_opening" | "before_collection" | "first_start" | "first_run" | "collecting" | "outside_collection";
export type TableCollectionState = { phase: TableCollectionPhase; health: TableCollectionHealth; normalWaiting: boolean; hasSuccess: boolean };

/** Store hours and collector hours are independent. Dates always use the configured cutoff. */
export function tableCollectionTiming(now: Date, businessDate: string, snapshot?: BusinessTimeSnapshot) {
  const operation = calculateBusinessTimeContext(now, snapshot ?? createFallbackBusinessTimeSnapshot(businessDate));
  const atMinute = (minute: number) => Date.parse(`${businessDate}T00:00:00+07:00`) + minute * 60_000;
  const firstStart = atMinute(OPEN_ORDERS_CRON_FIRST_START_MINUTE), firstRun = atMinute(OPEN_ORDERS_CRON_FIRST_RUN_MINUTE);
  const deadline = atMinute(OPEN_ORDERS_CRON_FIRST_SUCCESS_DEADLINE_MINUTE), stamp = now.getTime();
  const beforeOpening = !operation.isOpen && !operation.isClosed && !operation.isAfterCloseBeforeCutoff
    && operation.openAt !== null && stamp < Date.parse(operation.openAt);
  const phase: TableCollectionPhase = beforeOpening ? "before_opening"
    : stamp < firstStart ? "before_collection"
    : stamp >= firstStart && stamp < firstRun ? "first_start"
    : stamp >= firstRun && stamp < deadline ? "first_run"
    : evaluateOpenOrdersCronWindow(now).allowed ? "collecting" : "outside_collection";
  return { beforeOpening, phase, beforeFirstDeadline: stamp < deadline && phase !== "outside_collection" };
}
