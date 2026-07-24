export const ATTENDANCE_ROLES = [
  "owner",
  "master",
  "manager",
  "leader",
  "staff",
] as const;

export type AttendanceRole = (typeof ATTENDANCE_ROLES)[number];
export type AttendanceRecordsScope =
  | "self_day"
  | "self_month"
  | "staff_today"
  | "leave_month"
  | "admin_user_month"
  | "admin_overview";

const ADMIN_ROLES = new Set<string>(["owner", "master"]);
const SCOPES = new Set<AttendanceRecordsScope>([
  "self_day",
  "self_month",
  "staff_today",
  "leave_month",
  "admin_user_month",
  "admin_overview",
]);

export const ATTENDANCE_RECORD_PROJECTIONS: Record<
  AttendanceRecordsScope,
  string
> = {
  self_day:
    "id,user_id,work_date,status,check_in_at,check_out_at,late_minutes,early_leave_minutes,work_minutes,approval_status",
  self_month:
    "id,user_id,work_date,status,check_in_at,check_out_at,late_minutes,early_leave_minutes,work_minutes,approval_status",
  staff_today:
    "id,user_id,work_date,status,check_in_at,check_out_at,late_minutes,early_leave_minutes,work_minutes,approval_status,is_staff_direct_leave",
  leave_month:
    "id,user_id,work_date,status,note,approval_status,created_at",
  admin_user_month:
    "id,user_id,work_date,status,check_in_at,check_out_at,late_minutes,early_leave_minutes,work_minutes,note,approval_status,updated_at",
  admin_overview:
    "id,user_id,work_date,status,check_in_at,check_out_at,late_minutes,early_leave_minutes,work_minutes,approval_status",
};

type PolicyFailure = {
  ok: false;
  status: 400 | 403;
  code:
    | "INVALID_ATTENDANCE_SCOPE"
    | "INVALID_ATTENDANCE_QUERY"
    | "FORBIDDEN";
};

export type AttendanceRecordsPolicy = {
  ok: true;
  scope: AttendanceRecordsScope;
  projection: string;
  userId?: number;
  workDate?: string;
  startDate?: string;
  endDate?: string;
  status?: "leave";
};

function failure(
  status: PolicyFailure["status"],
  code: PolicyFailure["code"]
): PolicyFailure {
  return { ok: false, status, code };
}

export function isAttendanceRole(role: string): role is AttendanceRole {
  return (ATTENDANCE_ROLES as readonly string[]).includes(role);
}

export function isAttendanceAdminRole(role: string) {
  return ADMIN_ROLES.has(role);
}

export function validateLeaveRequestTarget(
  actorId: number,
  requestedUserId: unknown
) {
  return validateAttendanceActorTarget(actorId, requestedUserId);
}

export function parsePositiveUserId(value: string | null) {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function isValidAttendanceDate(value: string | null): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (year < 2000 || year > 2100) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export function getAttendanceMonthRange(monthValue: string | null) {
  if (!monthValue || !/^\d{4}-\d{2}$/.test(monthValue)) return null;
  const [year, month] = monthValue.split("-").map(Number);
  if (year < 2000 || year > 2100 || month < 1 || month > 12) return null;
  const endDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    startDate: `${monthValue}-01`,
    endDate: `${monthValue}-${String(endDay).padStart(2, "0")}`,
  };
}

function hasOnlyAllowedParams(
  searchParams: URLSearchParams,
  allowed: readonly string[]
) {
  const allowedSet = new Set(allowed);
  for (const key of searchParams.keys()) {
    if (!allowedSet.has(key) || searchParams.getAll(key).length !== 1) {
      return false;
    }
  }
  return true;
}

export function resolveAttendanceRecordsPolicy(input: {
  searchParams: URLSearchParams;
  actorId: number;
  actorRole: string;
}): AttendanceRecordsPolicy | PolicyFailure {
  const scopeValue = input.searchParams.get("scope");
  if (!scopeValue || !SCOPES.has(scopeValue as AttendanceRecordsScope)) {
    return failure(400, "INVALID_ATTENDANCE_SCOPE");
  }

  const scope = scopeValue as AttendanceRecordsScope;
  const isAdmin = ADMIN_ROLES.has(input.actorRole);
  if ((scope === "admin_user_month" || scope === "admin_overview") && !isAdmin) {
    return failure(403, "FORBIDDEN");
  }

  if (scope === "self_day") {
    if (!hasOnlyAllowedParams(input.searchParams, ["scope", "work_date", "user_id"])) {
      return failure(400, "INVALID_ATTENDANCE_QUERY");
    }
    const workDate = input.searchParams.get("work_date");
    if (!isValidAttendanceDate(workDate)) {
      return failure(400, "INVALID_ATTENDANCE_QUERY");
    }
    const requestedUserId = input.searchParams.get("user_id");
    if (requestedUserId !== null) {
      const parsed = parsePositiveUserId(requestedUserId);
      if (parsed !== input.actorId) return failure(403, "FORBIDDEN");
    }
    return {
      ok: true,
      scope,
      projection: ATTENDANCE_RECORD_PROJECTIONS[scope],
      userId: input.actorId,
      workDate,
    };
  }

  if (scope === "staff_today") {
    if (!hasOnlyAllowedParams(input.searchParams, ["scope", "work_date"])) {
      return failure(400, "INVALID_ATTENDANCE_QUERY");
    }
    const workDate = input.searchParams.get("work_date");
    if (!isValidAttendanceDate(workDate)) {
      return failure(400, "INVALID_ATTENDANCE_QUERY");
    }
    return {
      ok: true,
      scope,
      projection: ATTENDANCE_RECORD_PROJECTIONS[scope],
      workDate,
    };
  }

  const allowedParams =
    scope === "admin_user_month" || scope === "self_month"
      ? ["scope", "month", "user_id"]
      : ["scope", "month"];
  if (!hasOnlyAllowedParams(input.searchParams, allowedParams)) {
    return failure(400, "INVALID_ATTENDANCE_QUERY");
  }
  const range = getAttendanceMonthRange(input.searchParams.get("month"));
  if (!range) return failure(400, "INVALID_ATTENDANCE_QUERY");

  if (scope === "self_month") {
    const requestedUserId = input.searchParams.get("user_id");
    if (requestedUserId !== null) {
      const parsed = parsePositiveUserId(requestedUserId);
      if (parsed !== input.actorId) return failure(403, "FORBIDDEN");
    }
    return {
      ok: true,
      scope,
      projection: ATTENDANCE_RECORD_PROJECTIONS[scope],
      userId: input.actorId,
      ...range,
    };
  }

  if (scope === "admin_user_month") {
    const userId = parsePositiveUserId(input.searchParams.get("user_id"));
    if (!userId) return failure(400, "INVALID_ATTENDANCE_QUERY");
    return {
      ok: true,
      scope,
      projection: ATTENDANCE_RECORD_PROJECTIONS[scope],
      userId,
      ...range,
    };
  }

  return {
    ok: true,
    scope,
    projection: ATTENDANCE_RECORD_PROJECTIONS[scope],
    status: scope === "leave_month" ? "leave" : undefined,
    ...range,
  };
}

export function validateAttendanceActorTarget(
  actorId: number,
  requestedUserId: unknown
) {
  if (requestedUserId === undefined || requestedUserId === null || requestedUserId === "") {
    return { ok: true as const, userId: actorId };
  }
  const normalized =
    typeof requestedUserId === "number"
      ? requestedUserId
      : typeof requestedUserId === "string" && /^\d+$/.test(requestedUserId)
        ? Number(requestedUserId)
        : null;
  if (!Number.isSafeInteger(normalized) || normalized !== actorId) {
    return { ok: false as const, status: 403 as const, code: "FORBIDDEN" as const };
  }
  return { ok: true as const, userId: actorId };
}
