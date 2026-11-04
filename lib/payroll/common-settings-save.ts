// 급여 공통설정 저장 결과가 불확실할 때(네트워크 오류·응답 유실) 최신 설정 조회 결과로
// 실제 반영 여부를 판정한다. 읽기 전용 판정이며 저장을 다시 보내지 않는다.

export type CommonSettingsPayload = {
  paymentDay: number;
  employeeInsuranceRateBp: number;
  employerInsuranceRateBp: number;
  directorInsuranceEnabled: boolean;
  directorInsuranceBaseAmount: number;
  directorInsuranceRateBp: number;
  lateMajorThresholdMinutes: number;
  lateMinorPenaltyMinutes: number;
  lateMajorPenaltyRateBp: number;
  unauthorizedAbsencePenaltyDays: number;
};

export type CommonSettingsRow = {
  payment_day: number;
  employee_insurance_rate_bp: number;
  employer_insurance_rate_bp: number;
  director_insurance_enabled: boolean;
  director_insurance_base_amount: number;
  director_insurance_rate_bp: number;
  late_major_threshold_minutes: number;
  late_minor_penalty_minutes: number;
  late_major_penalty_rate_bp: number;
  unauthorized_absence_penalty_days: number;
};

export type MealPolicyVersion = { dailyAmount: number; effectiveFrom: string; revision: number };
export type AttendanceBonusPolicyVersion = {
  effectiveMonth: string;
  minimumActualWorkdays: number;
  allowedLateCount: number;
  allowedEarlyLeaveCount: number;
  bonusAmount: number;
  revision: number;
  note: string | null;
};

export type LatestCommonSettingsState<S extends CommonSettingsRow = CommonSettingsRow, M extends MealPolicyVersion = MealPolicyVersion, B extends AttendanceBonusPolicyVersion = AttendanceBonusPolicyVersion> = {
  settings: S;
  mealCurrent: M | null;
  mealHistory: M[];
  bonusCurrent: B | null;
  bonusHistory: B[];
};

export type SubmittedBonusDraft = {
  effectiveMonth: string;
  minimumActualWorkdays: string;
  allowedLateCount: string;
  allowedEarlyLeaveCount: string;
  bonusAmount: string;
  note: string;
};

export type SubmittedCommonSettingsState = {
  payload: CommonSettingsPayload;
  /** null = 이번 저장에서 식대를 보내지 않음 */
  meal: { dailyAmount: number; effectiveFrom: string } | null;
  /** null = 이번 저장에서 개근수당 정책을 보내지 않음 */
  bonus: SubmittedBonusDraft | null;
};

// 화면이 "최신 개근수당 정책"으로 쓰는 값과 동일한 선택 규칙(history 최신 → current).
export function latestAttendanceBonusPolicy<B extends AttendanceBonusPolicyVersion>(latest: { bonusCurrent: B | null; bonusHistory: B[] }): B | null {
  return latest.bonusHistory[0] ?? latest.bonusCurrent;
}

export function commonSettingsSaveApplied(latest: LatestCommonSettingsState, submitted: SubmittedCommonSettingsState): boolean {
  const row = latest.settings;
  const payload = submitted.payload;
  const settingsMatch =
    row.payment_day === payload.paymentDay &&
    row.employee_insurance_rate_bp === payload.employeeInsuranceRateBp &&
    row.employer_insurance_rate_bp === payload.employerInsuranceRateBp &&
    row.director_insurance_enabled === payload.directorInsuranceEnabled &&
    Number(row.director_insurance_base_amount) === payload.directorInsuranceBaseAmount &&
    row.director_insurance_rate_bp === payload.directorInsuranceRateBp &&
    row.late_major_threshold_minutes === payload.lateMajorThresholdMinutes &&
    row.late_minor_penalty_minutes === payload.lateMinorPenaltyMinutes &&
    row.late_major_penalty_rate_bp === payload.lateMajorPenaltyRateBp &&
    row.unauthorized_absence_penalty_days === payload.unauthorizedAbsencePenaltyDays;
  if (!settingsMatch) return false;

  if (submitted.meal) {
    // history는 effective_from desc, revision desc — 같은 적용일의 첫 항목이 최신 revision이다.
    const sameDate = latest.mealHistory.find((version) => version.effectiveFrom === submitted.meal!.effectiveFrom);
    if (!sameDate || sameDate.dailyAmount !== submitted.meal.dailyAmount) return false;
  }

  if (submitted.bonus) {
    const policy = latestAttendanceBonusPolicy(latest);
    if (!policy) return false;
    const bonus = submitted.bonus;
    if (
      policy.effectiveMonth !== bonus.effectiveMonth ||
      String(policy.minimumActualWorkdays) !== String(Number(bonus.minimumActualWorkdays)) ||
      String(policy.allowedLateCount) !== String(Number(bonus.allowedLateCount)) ||
      String(policy.allowedEarlyLeaveCount) !== String(Number(bonus.allowedEarlyLeaveCount)) ||
      String(policy.bonusAmount) !== String(Number(bonus.bonusAmount)) ||
      (policy.note ?? "") !== bonus.note.trim()
    ) return false;
  }
  return true;
}
