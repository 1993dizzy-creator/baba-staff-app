export type LateNormalizationRecord = {
  status: string;
  check_out_at: string | null;
  early_leave_minutes: number | null;
};

export function canCancelOwnLeave(input: {
  actorId: number;
  recordUserId: unknown;
}) {
  return Number(input.recordUserId) === input.actorId;
}

export type AdminLeaveCancellationRecord = {
  status: string;
  approval_status: string | null;
};

export function getAdminLeaveCancellationDecision(
  record: AdminLeaveCancellationRecord | null
) {
  if (!record) {
    return { ok: false as const, status: 404 as const, code: "LEAVE_REQUEST_NOT_FOUND" as const };
  }
  if (record.status !== "leave") {
    return { ok: false as const, status: 409 as const, code: "INVALID_LEAVE_REQUEST_STATE" as const };
  }
  if (record.approval_status === "approved") {
    return {
      ok: false as const,
      status: 409 as const,
      code: "APPROVAL_MUST_BE_CANCELLED_FIRST" as const,
    };
  }
  if (record.approval_status !== null && record.approval_status !== "pending") {
    return { ok: false as const, status: 409 as const, code: "INVALID_LEAVE_REQUEST_STATE" as const };
  }
  return { ok: true as const };
}

export function getNormalizedLatePatch(
  record: LateNormalizationRecord,
  updatedAt: string
) {
  const status =
    record.status === "early_leave" ||
    Number(record.early_leave_minutes || 0) > 0
      ? "early_leave"
      : record.check_out_at
        ? "done"
        : "working";

  return {
    late_minutes: 0,
    status,
    updated_at: updatedAt,
  };
}
