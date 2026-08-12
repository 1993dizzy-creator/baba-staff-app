export type PayrollPenaltySettings = {
  lateMajorThresholdMinutes: number;
  lateMinorPenaltyMinutes: number;
  lateMajorPenaltyRateBp: number;
  unauthorizedAbsencePenaltyDays: number;
};

export const DEFAULT_PAYROLL_PENALTY_SETTINGS: PayrollPenaltySettings = {
  lateMajorThresholdMinutes: 20,
  lateMinorPenaltyMinutes: 60,
  lateMajorPenaltyRateBp: 5000,
  unauthorizedAbsencePenaltyDays: 3,
};

export function calculateLatePenalty(input: {
  lateMinutes: number;
  minuteRate: number;
  dayRate: number;
  thresholdMinutes: number;
  minorPenaltyMinutes: number;
  majorPenaltyRateBp: number;
}) {
  if (input.lateMinutes <= 0) return { tier: "none" as const, amount: 0 };
  if (input.lateMinutes <= input.thresholdMinutes) {
    return {
      tier: "minor" as const,
      amount: Math.round(input.minuteRate * input.minorPenaltyMinutes),
    };
  }
  return {
    tier: "major" as const,
    amount: Math.round((input.dayRate * input.majorPenaltyRateBp) / 10_000),
  };
}

export function calculateUnauthorizedAbsencePenalty(input: {
  dayRate: number;
  penaltyDays: number;
}) {
  return Math.round(Math.max(0, input.dayRate) * Math.max(0, input.penaltyDays));
}
