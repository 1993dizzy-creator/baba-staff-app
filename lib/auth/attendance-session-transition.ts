export const ATTENDANCE_RETURN_PATH_KEY = "baba_session_return_path";

export type AttendanceSessionGateState =
  | { status: "checking" }
  | { status: "authenticated" }
  | { status: "relogin_required" }
  | {
      status: "error";
      reason: "forbidden" | "configuration" | "network" | "server";
    };

type SessionResponseBody = {
  authenticated?: unknown;
  code?: unknown;
} | null;

export function classifyAttendanceSessionResponse(
  status: number,
  body: SessionResponseBody
): AttendanceSessionGateState {
  if (status === 200 && body?.authenticated === true) {
    return { status: "authenticated" };
  }
  if (status === 401 && body?.code === "RELOGIN_REQUIRED") {
    return { status: "relogin_required" };
  }
  if (status === 403) {
    return { status: "error", reason: "forbidden" };
  }
  if (status === 500 && body?.code === "SESSION_CONFIG_ERROR") {
    return { status: "error", reason: "configuration" };
  }
  return { status: "error", reason: "server" };
}

export function isSafeAttendanceReturnPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    return false;
  }
  if (!value.startsWith("/") || value.startsWith("//")) return false;
  if (value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value)) return false;

  try {
    const url = new URL(value, "https://baba.local");
    if (url.origin !== "https://baba.local" || url.hash) return false;
    return url.pathname === "/attendance" || url.pathname.startsWith("/attendance/");
  } catch {
    return false;
  }
}

export function saveAttendanceReturnPath(
  storage: Pick<Storage, "setItem">,
  value: unknown
) {
  if (!isSafeAttendanceReturnPath(value)) return false;
  storage.setItem(ATTENDANCE_RETURN_PATH_KEY, value);
  return true;
}

export function takeAttendanceReturnPath(
  storage: Pick<Storage, "getItem" | "removeItem">
) {
  const value = storage.getItem(ATTENDANCE_RETURN_PATH_KEY);
  storage.removeItem(ATTENDANCE_RETURN_PATH_KEY);
  return isSafeAttendanceReturnPath(value) ? value : null;
}
