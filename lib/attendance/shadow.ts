import type { AttendancePolicyResult } from "./policy-engine";

export type ShadowMetricStatus = {
  comparisonStatus: "compared" | "excluded";
  exclusionReason: "manual_late_normalization" | null;
};

export type LegacyAttendanceShadowResult = {
  status: string;
  lateMinutes: number;
  earlyLeaveMinutes: number;
  unresolved: boolean;
  unresolvedAt?: string | null;
  /** @deprecated Use unresolvedAt. Kept for single-day clients during rollout. */
  autoCloseAt: string | null;
};

export type AttendanceShadowComparison = {
  recordId: number;
  userId: number;
  userName: string;
  businessDate: string;
  checkInAt: string | null;
  checkOutAt: string | null;
  comparisonStatus: "compared" | "excluded";
  exclusionReason:
    | "manual_late_normalization"
    | "leave"
    | "no_check_in"
    | null;
  metricComparison: {
    late: ShadowMetricStatus;
    earlyLeave: ShadowMetricStatus;
    unresolved: ShadowMetricStatus;
  };
  differenceTypes: string[];
  legacy: LegacyAttendanceShadowResult;
  configured: {
    status: AttendancePolicyResult["status"];
    lateMinutes: number;
    earlyLeaveMinutes: number;
    unresolved: boolean;
    effectiveStoreCloseAt: string | null;
    unresolvedAt: string | null;
    normalCheckoutThresholdAt: string | null;
    scheduledEndAt: string | null;
    settingsRevision: number;
    closeSource: AttendancePolicyResult["source"]["close"];
  };
  differences: {
    status: boolean;
    lateMinutes: boolean;
    earlyLeaveMinutes: boolean;
    unresolved: boolean;
    unresolvedAt: boolean;
    /** @deprecated Alias of unresolvedAt. */
    autoCloseAt: boolean;
  };
};

export type AttendanceShadowSummary = {
  total: number;
  totalRecords: number;
  compared: number;
  excluded: number;
  matched: number;
  mismatched: number;
  statusChanged: number;
  lateChanged: number;
  earlyLeaveChanged: number;
  unresolvedChanged: number;
  unresolvedAtChanged: number;
  /** @deprecated Alias of unresolvedAtChanged. */
  autoCloseChanged: number;
  manualLateExcluded: number;
  leaveExcluded: number;
  otherExcluded: number;
};

export function compareAttendanceShadow(input: {
  recordId: number;
  userId: number;
  userName: string;
  businessDate: string;
  checkInAt?: string | null;
  checkOutAt?: string | null;
  legacy: LegacyAttendanceShadowResult;
  configured: AttendancePolicyResult;
  manualLateNormalization?: boolean;
}): AttendanceShadowComparison {
  const lateExcluded = input.manualLateNormalization === true;
  const configured = {
    status: input.configured.status,
    lateMinutes: input.configured.lateMinutes,
    earlyLeaveMinutes: input.configured.earlyLeaveMinutes,
    unresolved: input.configured.unresolved,
    effectiveStoreCloseAt: input.configured.effectiveStoreCloseAt,
    unresolvedAt: input.configured.unresolvedAt,
    normalCheckoutThresholdAt: input.configured.normalCheckoutThresholdAt,
    scheduledEndAt: input.configured.scheduledEndAt,
    settingsRevision: input.configured.source.settingsRevision,
    closeSource: input.configured.source.close,
  };
  const isOpen = Boolean(input.checkInAt && !input.checkOutAt);
  const unresolvedAt =
    isOpen &&
    (input.legacy.unresolvedAt ?? input.legacy.autoCloseAt) !==
      configured.unresolvedAt;
  const lateMinutes =
    !lateExcluded && input.legacy.lateMinutes !== configured.lateMinutes;
  const earlyLeaveMinutes =
    input.legacy.earlyLeaveMinutes !== configured.earlyLeaveMinutes;
  const unresolved =
    isOpen && input.legacy.unresolved !== configured.unresolved;
  const statusRaw = input.legacy.status !== configured.status;
  const status = lateExcluded && !earlyLeaveMinutes && !unresolved
    ? false
    : statusRaw;

  const differenceTypes: string[] = [];
  if (lateExcluded) differenceTypes.push("manual_late_normalization");
  if (lateMinutes) differenceTypes.push("late_minutes");
  if (earlyLeaveMinutes) {
    differenceTypes.push("early_leave_minutes");
    if (
      input.legacy.earlyLeaveMinutes > 0 &&
      input.legacy.status !== "early_leave" &&
      configured.status === "early_leave"
    ) {
      differenceTypes.push("legacy_90_minute_threshold");
    }
    if (configured.closeSource === "override") {
      differenceTypes.push("special_close");
    }
    if (
      configured.scheduledEndAt &&
      configured.normalCheckoutThresholdAt &&
      configured.scheduledEndAt !== configured.normalCheckoutThresholdAt
    ) {
      differenceTypes.push("employee_store_close");
    }
  }
  if (unresolved || unresolvedAt) differenceTypes.push("unresolved_at");
  if (status && differenceTypes.length === 0) differenceTypes.push("other");

  return {
    recordId: input.recordId,
    userId: input.userId,
    userName: input.userName,
    businessDate: input.businessDate,
    checkInAt: input.checkInAt ?? null,
    checkOutAt: input.checkOutAt ?? null,
    comparisonStatus: "compared",
    exclusionReason: lateExcluded ? "manual_late_normalization" : null,
    metricComparison: {
      late: {
        comparisonStatus: lateExcluded ? "excluded" : "compared",
        exclusionReason: lateExcluded ? "manual_late_normalization" : null,
      },
      earlyLeave: { comparisonStatus: "compared", exclusionReason: null },
      unresolved: { comparisonStatus: "compared", exclusionReason: null },
    },
    differenceTypes,
    legacy: input.legacy,
    configured,
    differences: {
      status,
      lateMinutes,
      earlyLeaveMinutes,
      unresolved,
      unresolvedAt,
      autoCloseAt: unresolvedAt,
    },
  };
}

export function summarizeAttendanceShadow(
  rows: AttendanceShadowComparison[],
  totalRecords = rows.length
): AttendanceShadowSummary {
  const summary: AttendanceShadowSummary = {
    total: rows.length,
    totalRecords,
    compared: 0,
    excluded: 0,
    matched: 0,
    mismatched: 0,
    statusChanged: 0,
    lateChanged: 0,
    earlyLeaveChanged: 0,
    unresolvedChanged: 0,
    unresolvedAtChanged: 0,
    autoCloseChanged: 0,
    manualLateExcluded: 0,
    leaveExcluded: 0,
    otherExcluded: 0,
  };

  for (const row of rows) {
    if (row.comparisonStatus === "excluded") {
      summary.excluded += 1;
      if (row.exclusionReason === "leave") summary.leaveExcluded += 1;
      else summary.otherExcluded += 1;
      continue;
    }
    summary.compared += 1;
    if (row.metricComparison.late.comparisonStatus === "excluded") {
      summary.manualLateExcluded += 1;
    }
    const changed = [
      row.differences.status,
      row.differences.lateMinutes,
      row.differences.earlyLeaveMinutes,
      row.differences.unresolved,
      row.differences.unresolvedAt,
    ].some(Boolean);
    if (changed) summary.mismatched += 1;
    else summary.matched += 1;
    if (row.differences.status) summary.statusChanged += 1;
    if (row.differences.lateMinutes) summary.lateChanged += 1;
    if (row.differences.earlyLeaveMinutes) summary.earlyLeaveChanged += 1;
    if (row.differences.unresolved) summary.unresolvedChanged += 1;
    if (row.differences.unresolvedAt) {
      summary.unresolvedAtChanged += 1;
      summary.autoCloseChanged += 1;
    }
  }
  return summary;
}
