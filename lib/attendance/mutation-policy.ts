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
