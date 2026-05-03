export const ATTENDANCE_STATUS = {
  WORKING: "working",
  DONE: "done",
  LATE: "late",
  EARLY_LEAVE: "early_leave",
  LEAVE: "leave",
} as const;

export const APPROVAL_STATUS = {
  PENDING: "pending",
  APPROVED: "approved",
} as const;

export const LEAVE_ACTION = {
  REQUEST: "request",
  CANCEL: "cancel",
  APPROVE: "approve",
  CANCEL_APPROVAL: "cancel-approval",
} as const;

export type AttendanceStatus =
  (typeof ATTENDANCE_STATUS)[keyof typeof ATTENDANCE_STATUS];

export type ApprovalStatus =
  (typeof APPROVAL_STATUS)[keyof typeof APPROVAL_STATUS];

export type LeaveAction =
  (typeof LEAVE_ACTION)[keyof typeof LEAVE_ACTION];