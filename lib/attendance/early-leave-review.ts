export const EARLY_LEAVE_REVIEW_START_DATE = "2026-09-01";
export type EarlyLeaveSelection = "use_raw" | "use_effective";

export function isEarlyLeaveSelection(value: unknown): value is EarlyLeaveSelection {
  return value === "use_raw" || value === "use_effective";
}

export function resolveEarlyLeaveReview(input: {
  businessDate: string;
  rawEarlyLeaveMinutes: number;
  earlyLeaveGraceMinutes: number;
  selection?: EarlyLeaveSelection | null;
}) {
  const raw = Math.max(0, input.rawEarlyLeaveMinutes);
  const effectiveEarlyLeaveMinutes = Math.max(0, raw - input.earlyLeaveGraceMinutes);
  const applies = input.businessDate >= EARLY_LEAVE_REVIEW_START_DATE;
  const selection = applies && raw > input.earlyLeaveGraceMinutes ? input.selection ?? null : null;
  return {
    effectiveEarlyLeaveMinutes,
    earlyLeaveMinutes: selection === "use_raw" ? raw : effectiveEarlyLeaveMinutes,
    earlyLeaveReviewRequired: applies && effectiveEarlyLeaveMinutes > 0 && selection === null,
    earlyLeaveSelection: selection,
  };
}
