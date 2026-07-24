export type LateNormalizationRecord = {
  status: string;
  check_out_at: string | null;
  early_leave_minutes: number | null;
};

export type StaffCancellationRecord = {
  status: string;
  check_in_at: string | null;
  check_out_at: string | null;
  late_minutes: number | null;
  is_staff_direct_leave?: boolean | null;
};

export type StaffCancellationAction =
  | "cancel_check_in"
  | "cancel_check_out"
  | "cancel_leave";

export function getStaffCancellationDecision(
  action: StaffCancellationAction,
  record: StaffCancellationRecord | null
) {
  if (!record) {
    return {
      ok: false as const,
      status: 409 as const,
      code: "ATTENDANCE_RECORD_CHANGED" as const,
    };
  }

  if (action === "cancel_check_in") {
    if (
      record.status === "leave" ||
      !record.check_in_at ||
      record.check_out_at
    ) {
      return {
        ok: false as const,
        status: 409 as const,
        code: record.check_out_at
          ? ("CHECK_OUT_MUST_BE_CANCELLED_FIRST" as const)
          : ("CHECK_IN_CANNOT_BE_CANCELLED" as const),
      };
    }
    return { ok: true as const, mutation: "delete" as const };
  }

  if (action === "cancel_check_out") {
    if (
      record.status === "leave" ||
      !record.check_in_at ||
      !record.check_out_at
    ) {
      return {
        ok: false as const,
        status: 409 as const,
        code: "CHECK_OUT_CANNOT_BE_CANCELLED" as const,
      };
    }
    return {
      ok: true as const,
      mutation: "update" as const,
      patch: {
        check_out_at: null,
        work_minutes: null,
        early_leave_minutes: 0,
        status: Number(record.late_minutes || 0) > 0 ? "late" : "working",
      },
    };
  }

  if (
    record.status !== "leave" ||
    record.check_in_at ||
    record.check_out_at ||
    record.is_staff_direct_leave !== true
  ) {
    return {
      ok: false as const,
      status: 409 as const,
      code: "DIRECT_LEAVE_CANNOT_BE_CANCELLED" as const,
    };
  }

  return { ok: true as const, mutation: "delete" as const };
}

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
