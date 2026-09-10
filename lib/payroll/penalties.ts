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

// 30분 단위 올림 패널티는 딱 두 경우에만 쓴다:
//   (1) 관리자가 수동 정상화한 지각(manualLateNormalized === true)
//   (2) 조퇴(early_leave)
// 30분 올림한 시간 × "그날 기준 분급(dayRate / 기준근무분, hourly는 시급/60)".
// 일반 지각(manualLateNormalized === false)은 아래 calculateLatePenalty(minor/major tier)를 그대로 쓴다.
export const TIME_PENALTY_BLOCK_MINUTES = 30;

// effectiveMinutes = attendance policy(grace 등)를 이미 적용한 실제 지각/조퇴 분.
// 0이면 0, 그 외에는 blockMinutes(기본 30) 단위로 올림한다. (17→30, 31→60, 47→60 …)
export function roundUpPenaltyMinutes(effectiveMinutes: number, blockMinutes: number = TIME_PENALTY_BLOCK_MINUTES) {
  const safe = Math.max(0, Math.floor(effectiveMinutes));
  return safe > 0 ? Math.ceil(safe / blockMinutes) * blockMinutes : 0;
}

// 수동 정상화 지각 + 조퇴 전용: 30분 올림한 패널티 시간 × 그날 기준 분급 → 기존 VND 반올림(Math.round).
export function calculateTimePenalty(input: {
  effectiveMinutes: number;
  minuteRate: number;
  blockMinutes?: number;
}) {
  const penaltyMinutes = roundUpPenaltyMinutes(input.effectiveMinutes, input.blockMinutes ?? TIME_PENALTY_BLOCK_MINUTES);
  return { penaltyMinutes, amount: Math.round(Math.max(0, input.minuteRate) * penaltyMinutes) };
}

/**
 * 일반 지각(manualLateNormalized === false)의 활성 급여 정책.
 * /admin/payroll/settings 의 late_major_threshold_minutes / late_minor_penalty_minutes /
 * late_major_penalty_rate_bp 를 실제 계산에 사용한다.
 *   - lateMinutes ≤ threshold  → minor: minuteRate × minorPenaltyMinutes
 *   - lateMinutes >  threshold  → major: dayRate × majorPenaltyRateBp / 10000
 * 수동 정상화 지각/조퇴는 이 함수가 아니라 calculateTimePenalty(30분 단위)를 쓴다.
 */
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
