const EXPORT_BLOCKING_CODES = new Set([
  "NO_PAYROLL_CONTRACT",
  "CONTRACT_OVERLAP",
  "MISSING_CHECK_IN",
  "MISSING_CHECK_OUT",
  "INVALID_TIME_RANGE",
  "SCHEDULE_HISTORY_UNAVAILABLE",
  "PENDING_LEAVE_APPROVAL",
  "CALCULATION_FAILED",
  "EMPLOYEE_LEVEL_BASE_DATE_REQUIRED",
  "PART_TIME_EXTRA_WORK_REVIEW_REQUIRED",
  "PART_TIME_EXTRA_WORK_DECISION_STALE",
  "UNRESOLVED_ATTENDANCE",
]);

export function payrollSourceReadiness(input: {
  reviewCodes: readonly string[];
  taxRequiresReview: boolean;
  insuranceSettingMissing: boolean;
}) {
  const blockingCodes = input.reviewCodes.filter((code) => EXPORT_BLOCKING_CODES.has(code));
  if (input.taxRequiresReview) blockingCodes.push("TAX_SETTING_REQUIRES_REVIEW");
  const warningCodes = input.reviewCodes.filter((code) => !EXPORT_BLOCKING_CODES.has(code));
  if (input.insuranceSettingMissing) warningCodes.push("INSURANCE_SETTING_MISSING");
  return {
    readyForAccounting: blockingCodes.length === 0,
    blockingCodes: [...new Set(blockingCodes)].sort(),
    warningCodes: [...new Set(warningCodes)].sort(),
  };
}
