import { buildPosCollectionWindow, type BusinessTimeSnapshot } from "../store-settings/business-time-adapter-core.ts";
import { addStoreDays } from "../store-settings/business-time-core.ts";
import { POS_BUCKETS, validPosBusinessDate, type PosBusinessDaySource } from "../ledger/pos-sales-source.ts";
import { isPosTimestampOnlyDrift } from "./pos-business-day-final-policy.ts";

export function canWritePosBusinessDayClose(role: string | null | undefined, reclose = false) {
  return role === "owner" || role === "master" || (!reclose && role === "manager");
}

export function validatePosSystemActor(actor: {
  id: number; username: string; role: string | null; is_active: boolean | null; app_login_enabled: boolean | null;
} | null) {
  if (!actor || actor.username !== "pos" || !Number.isSafeInteger(actor.id) || actor.id < 1
    || actor.is_active !== true || actor.app_login_enabled !== true
    || !canWritePosBusinessDayClose(actor.role?.trim().toLowerCase(), true)) {
    throw new Error("POS_CLOSE_SYSTEM_ACTOR_UNAVAILABLE");
  }
  return { id: actor.id, username: actor.username, role: actor.role!.trim().toLowerCase() };
}

export function evaluatePosCloseTime(businessDate: string, currentBusinessDate: string, now: Date, snapshot: BusinessTimeSnapshot) {
  if (!validPosBusinessDate(businessDate) || !validPosBusinessDate(currentBusinessDate) || !Number.isFinite(now.getTime())) throw new Error("INVALID_POS_CLOSE_TIME");
  const window = buildPosCollectionWindow(businessDate, snapshot);
  if (businessDate < currentBusinessDate) return { allowed: true, reason: "past_business_date", closeAt: window.closeAt, cutoffAt: window.cutoffAt };
  if (businessDate > currentBusinessDate) return { allowed: false, reason: "future_business_date", closeAt: window.closeAt, cutoffAt: window.cutoffAt };
  if (snapshot.isFallback || !window.closeAt) return { allowed: false, reason: "configured_close_time_unavailable", closeAt: window.closeAt, cutoffAt: window.cutoffAt };
  return { allowed: now.getTime() >= new Date(window.closeAt).getTime(), reason: "configured_close_time", closeAt: window.closeAt, cutoffAt: window.cutoffAt };
}

// Manual close opens at 00:00 (Asia/Ho_Chi_Minh) of the calendar day after the business date, i.e. still
// inside the same business day (which ends at the 03:00 cutoff). Fixed time, independent of store hours.
export function posManualCloseAt(businessDate: string) {
  if (!validPosBusinessDate(businessDate)) throw new Error("INVALID_POS_CLOSE_TIME");
  return `${addStoreDays(businessDate, 1)}T00:00:00+07:00`;
}

// Display phase of a not-yet-closed business date (server clock and business date only).
export type PosBusinessPhase = "past" | "future" | "hours_unavailable" | "before_open" | "open" | "closeable";

export function evaluatePosManualCloseTime(businessDate: string, currentBusinessDate: string, now: Date, snapshot: BusinessTimeSnapshot) {
  if (!validPosBusinessDate(businessDate) || !validPosBusinessDate(currentBusinessDate) || !Number.isFinite(now.getTime())) throw new Error("INVALID_POS_CLOSE_TIME");
  const window = buildPosCollectionWindow(businessDate, snapshot);
  const manualCloseAt = posManualCloseAt(businessDate);
  const openAt = window.isClosed || snapshot.isFallback ? null : window.openAt;
  const base = { closeAt: window.closeAt, cutoffAt: window.cutoffAt, openAt, manualCloseAt };
  if (businessDate < currentBusinessDate) return { allowed: true, reason: "past_business_date", phase: "past" as PosBusinessPhase, ...base };
  if (businessDate > currentBusinessDate) return { allowed: false, reason: "future_business_date", phase: "future" as PosBusinessPhase, ...base };
  const allowed = now.getTime() >= Date.parse(manualCloseAt);
  const phase: PosBusinessPhase = allowed ? "closeable" : !openAt ? "hours_unavailable"
    : now.getTime() < Date.parse(openAt) ? "before_open" : "open";
  return { allowed, reason: "manual_close_time", phase, ...base };
}

export function comparePosClosedSource(current: PosBusinessDaySource, closedSnapshot: unknown, closedFingerprint: string | null) {
  if (closedFingerprint === null) return { isClosed: false, drift: false, timestampOnlyDrift: false, totalDelta: null, bucketDeltas: null };
  if (!closedSnapshot || typeof closedSnapshot !== "object") throw new Error("POS_CLOSED_SOURCE_SNAPSHOT_INCOMPLETE");
  const snapshot = closedSnapshot as Record<string, unknown>;
  const buckets = snapshot.totalsByBucket as Record<string, unknown> | undefined;
  if (snapshot.businessDate !== current.businessDate || !Number.isSafeInteger(snapshot.receiptTotal) || !buckets
    || POS_BUCKETS.some(bucket => !Number.isSafeInteger(buckets[bucket]))) throw new Error("POS_CLOSED_SOURCE_SNAPSHOT_INCOMPLETE");
  const bucketDeltas = { cash: 0, transfer: 0, card: 0, other: 0 };
  for (const bucket of POS_BUCKETS) bucketDeltas[bucket] = current[bucket] - Number(buckets[bucket]);
  const timestampOnlyDrift = isPosTimestampOnlyDrift(closedSnapshot, closedFingerprint, current);
  return { isClosed: true, drift: current.sourceFingerprint !== closedFingerprint && !timestampOnlyDrift, timestampOnlyDrift,
    totalDelta: current.receiptTotal - Number(snapshot.receiptTotal), bucketDeltas };
}
