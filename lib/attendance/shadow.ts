import type { AttendancePolicyResult } from "./policy-engine";

export type LegacyAttendanceShadowResult = {
  status: string;
  lateMinutes: number;
  earlyLeaveMinutes: number;
  unresolved: boolean;
  autoCloseAt: string | null;
};

export type AttendanceShadowComparison = {
  recordId: number;
  userId: number;
  userName: string;
  businessDate: string;
  legacy: LegacyAttendanceShadowResult;
  configured: {
    status: AttendancePolicyResult["status"];
    lateMinutes: number;
    earlyLeaveMinutes: number;
    unresolved: boolean;
    effectiveStoreCloseAt: string | null;
    normalCheckoutThresholdAt: string | null;
    settingsRevision: number;
    closeSource: AttendancePolicyResult["source"]["close"];
  };
  differences: {
    status: boolean;
    lateMinutes: boolean;
    earlyLeaveMinutes: boolean;
    unresolved: boolean;
    autoCloseAt: boolean;
  };
};

export type AttendanceShadowSummary = {
  total: number;
  matched: number;
  mismatched: number;
  statusChanged: number;
  lateChanged: number;
  earlyLeaveChanged: number;
  unresolvedChanged: number;
  autoCloseChanged: number;
};

export function compareAttendanceShadow(input: {
  recordId: number;
  userId: number;
  userName: string;
  businessDate: string;
  legacy: LegacyAttendanceShadowResult;
  configured: AttendancePolicyResult;
}): AttendanceShadowComparison {
  const configured = {
    status: input.configured.status,
    lateMinutes: input.configured.lateMinutes,
    earlyLeaveMinutes: input.configured.earlyLeaveMinutes,
    unresolved: input.configured.unresolved,
    effectiveStoreCloseAt: input.configured.effectiveStoreCloseAt,
    normalCheckoutThresholdAt:
      input.configured.normalCheckoutThresholdAt,
    settingsRevision: input.configured.source.settingsRevision,
    closeSource: input.configured.source.close,
  };
  const differences = {
    status: input.legacy.status !== configured.status,
    lateMinutes: input.legacy.lateMinutes !== configured.lateMinutes,
    earlyLeaveMinutes:
      input.legacy.earlyLeaveMinutes !== configured.earlyLeaveMinutes,
    unresolved: input.legacy.unresolved !== configured.unresolved,
    autoCloseAt:
      input.legacy.autoCloseAt !== null &&
      input.legacy.autoCloseAt !== configured.effectiveStoreCloseAt,
  };

  return {
    recordId: input.recordId,
    userId: input.userId,
    userName: input.userName,
    businessDate: input.businessDate,
    legacy: input.legacy,
    configured,
    differences,
  };
}

export function summarizeAttendanceShadow(
  rows: AttendanceShadowComparison[]
): AttendanceShadowSummary {
  const summary: AttendanceShadowSummary = {
    total: rows.length,
    matched: 0,
    mismatched: 0,
    statusChanged: 0,
    lateChanged: 0,
    earlyLeaveChanged: 0,
    unresolvedChanged: 0,
    autoCloseChanged: 0,
  };

  for (const row of rows) {
    const changed = Object.values(row.differences).some(Boolean);
    if (changed) summary.mismatched += 1;
    else summary.matched += 1;
    if (row.differences.status) summary.statusChanged += 1;
    if (row.differences.lateMinutes) summary.lateChanged += 1;
    if (row.differences.earlyLeaveMinutes) {
      summary.earlyLeaveChanged += 1;
    }
    if (row.differences.unresolved) summary.unresolvedChanged += 1;
    if (row.differences.autoCloseAt) summary.autoCloseChanged += 1;
  }

  return summary;
}
