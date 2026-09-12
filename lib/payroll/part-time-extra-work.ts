import { createHash } from "node:crypto";
import type { PayrollContract } from "./types";

const STORE_OFFSET = "+07:00";
export const EXTRA_WORK_MINIMUM_CANDIDATE_MINUTES = 30;

export type PartTimeExtraWorkDecision = {
  id: number;
  attendanceRecordId: number;
  decision: "approved" | "rejected";
  sourceHash: string;
  decisionReason: string | null;
  decidedBy: number;
  decidedAt: string;
};

export type PartTimeExtraWorkCandidate = {
  attendanceRecordId: number;
  userId: number;
  businessDate: string;
  checkInAt: string;
  checkOutAt: string;
  contractId: number;
  contractRevision: number;
  minuteRateAmount: number;
  // Existing DB/RPC compatibility field. For non-hourly contracts this is the
  // calculated minute rate converted to a rounded hourly equivalent.
  hourlyRateAmount: number;
  scheduleId: number;
  scheduleRevision: number;
  scheduleStartTime: string;
  scheduleEndTime: string;
  storeSettingId: number;
  storeSettingRevision: number;
  storeOpenTime: string;
  storeCloseTime: string;
  beforeScheduleMinutes: number;
  afterScheduleMinutes: number;
  excludedBeforeOpenMinutes: number;
  excludedAfterCloseMinutes: number;
  candidateMinutes: number;
  candidateAmount: number;
  sourceSnapshot: Record<string, unknown>;
  sourceHash: string;
  decision: PartTimeExtraWorkDecision | null;
  status: "review_required" | "stale" | "approved" | "rejected";
};

export function isExtraWorkEligible(contract: Pick<PayrollContract, "payType" | "calculationBasis">) {
  return contract.calculationBasis !== "fixed_monthly"
    && (contract.payType === "hourly" || contract.payType === "daily" || contract.payType === "monthly");
}

export function partTimeExtraWorkDecisionEffect(candidate: PartTimeExtraWorkCandidate) {
  if (candidate.status === "approved") return { amount: candidate.candidateAmount, warningCode: null } as const;
  if (candidate.status === "rejected") return { amount: 0, warningCode: null } as const;
  return { amount: 0, warningCode: candidate.status === "stale" ? "PART_TIME_EXTRA_WORK_DECISION_STALE" : "PART_TIME_EXTRA_WORK_REVIEW_REQUIRED" } as const;
}

function localInstant(date: string, time: string) {
  const value = new Date(`${date}T${time.slice(0, 5)}:00${STORE_OFFSET}`).getTime();
  if (!Number.isFinite(value)) throw new Error("INVALID_PART_TIME_EXTRA_WORK_TIME");
  return value;
}

function windowFor(date: string, startTime: string, endTime: string) {
  const start = localInstant(date, startTime);
  let end = localInstant(date, endTime);
  if (end <= start) end += 24 * 60 * 60 * 1000;
  return { start, end };
}

function overlapMinutes(aStart: number, aEnd: number, bStart: number, bEnd: number) {
  return Math.max(0, Math.floor((Math.min(aEnd, bEnd) - Math.max(aStart, bStart)) / 60_000));
}

export function partTimeExtraWorkSourceHash(snapshot: Record<string, unknown>) {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

export function calculatePartTimeExtraWork(input: {
  attendanceRecordId: number;
  userId: number;
  businessDate: string;
  checkInAt: string;
  checkOutAt: string;
  contractId: number;
  contractRevision: number;
  minuteRateAmount: number;
  hourlyRateAmount: number;
  scheduleId: number;
  scheduleRevision: number;
  scheduleStartTime: string;
  scheduleEndTime: string;
  storeSettingId: number;
  storeSettingRevision: number;
  storeOpenTime: string;
  storeCloseTime: string;
  decision?: PartTimeExtraWorkDecision | null;
}): PartTimeExtraWorkCandidate | null {
  const actualStart = new Date(input.checkInAt).getTime();
  const actualEnd = new Date(input.checkOutAt).getTime();
  if (!Number.isFinite(actualStart) || !Number.isFinite(actualEnd) || actualEnd <= actualStart) return null;
  const store = windowFor(input.businessDate, input.storeOpenTime, input.storeCloseTime);
  const schedule = windowFor(input.businessDate, input.scheduleStartTime, input.scheduleEndTime);
  const insideStart = Math.max(actualStart, store.start);
  const insideEnd = Math.min(actualEnd, store.end);
  const beforeScheduleMinutes = insideEnd > insideStart
    ? overlapMinutes(insideStart, insideEnd, insideStart, Math.min(schedule.start, insideEnd))
    : 0;
  const afterScheduleMinutes = insideEnd > insideStart
    ? overlapMinutes(insideStart, insideEnd, Math.max(schedule.end, insideStart), insideEnd)
    : 0;
  const excludedBeforeOpenMinutes = overlapMinutes(actualStart, actualEnd, actualStart, Math.min(store.start, actualEnd));
  const excludedAfterCloseMinutes = overlapMinutes(actualStart, actualEnd, Math.max(store.end, actualStart), actualEnd);
  // Early arrival is audit metadata only. Pay and the minimum threshold use
  // exclusively work after the scheduled end, already clipped to store close.
  const candidateMinutes = afterScheduleMinutes;
  if (candidateMinutes < EXTRA_WORK_MINIMUM_CANDIDATE_MINUTES) return null;
  const candidateAmount = Math.round(candidateMinutes * input.minuteRateAmount);
  const sourceSnapshot = {
    attendanceRecordId: input.attendanceRecordId,
    checkInAt: input.checkInAt,
    checkOutAt: input.checkOutAt,
    userId: input.userId,
    businessDate: input.businessDate,
    contractId: input.contractId,
    contractRevision: input.contractRevision,
    minuteRateAmount: input.minuteRateAmount,
    hourlyRateAmount: input.hourlyRateAmount,
    scheduleId: input.scheduleId,
    scheduleRevision: input.scheduleRevision,
    scheduleStartTime: input.scheduleStartTime,
    scheduleEndTime: input.scheduleEndTime,
    storeSettingId: input.storeSettingId,
    storeSettingRevision: input.storeSettingRevision,
    storeOpenTime: input.storeOpenTime,
    storeCloseTime: input.storeCloseTime,
    beforeScheduleMinutes,
    afterScheduleMinutes,
    excludedBeforeOpenMinutes,
    excludedAfterCloseMinutes,
    candidateMinutes,
    candidateAmount,
  };
  const sourceHash = partTimeExtraWorkSourceHash(sourceSnapshot);
  const decision = input.decision ?? null;
  const status = !decision ? "review_required" : decision.sourceHash !== sourceHash ? "stale" : decision.decision;
  return { ...input, beforeScheduleMinutes, afterScheduleMinutes, excludedBeforeOpenMinutes, excludedAfterCloseMinutes, candidateMinutes, candidateAmount, sourceSnapshot, sourceHash, decision, status };
}
