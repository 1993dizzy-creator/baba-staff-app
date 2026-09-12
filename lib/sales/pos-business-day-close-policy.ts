// @ts-expect-error Node's direct TypeScript tests require explicit extensions.
import { buildPosCollectionWindow, type BusinessTimeSnapshot } from "../store-settings/business-time-adapter-core.ts";
// @ts-expect-error Node's direct TypeScript tests require explicit extensions.
import { POS_BUCKETS, validPosBusinessDate, type PosBusinessDaySource } from "../ledger/pos-sales-source.ts";

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

export function comparePosClosedSource(current: PosBusinessDaySource, closedSnapshot: unknown, closedFingerprint: string | null) {
  if (closedFingerprint === null) return { isClosed: false, drift: false, totalDelta: null, bucketDeltas: null };
  if (!closedSnapshot || typeof closedSnapshot !== "object") throw new Error("POS_CLOSED_SOURCE_SNAPSHOT_INCOMPLETE");
  const snapshot = closedSnapshot as Record<string, unknown>;
  const buckets = snapshot.totalsByBucket as Record<string, unknown> | undefined;
  if (snapshot.businessDate !== current.businessDate || !Number.isSafeInteger(snapshot.receiptTotal) || !buckets
    || POS_BUCKETS.some(bucket => !Number.isSafeInteger(buckets[bucket]))) throw new Error("POS_CLOSED_SOURCE_SNAPSHOT_INCOMPLETE");
  const bucketDeltas = { cash: 0, transfer: 0, card: 0, other: 0 };
  for (const bucket of POS_BUCKETS) bucketDeltas[bucket] = current[bucket] - Number(buckets[bucket]);
  return { isClosed: true, drift: current.sourceFingerprint !== closedFingerprint,
    totalDelta: current.receiptTotal - Number(snapshot.receiptTotal), bucketDeltas };
}
