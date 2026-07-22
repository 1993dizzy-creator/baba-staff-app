"use client";

import {
  ATTENDANCE_RETURN_PATH_KEY,
  saveAttendanceReturnPath,
} from "@/lib/auth/attendance-session-transition";

export const BABA_SESSION_EXPIRED_EVENT = "baba_session_expired";
export const BABA_SESSION_RETURN_PATH_KEY = ATTENDANCE_RETURN_PATH_KEY;

let handlingUnauthorized = false;

export function handleSessionUnauthorized(response: Response) {
  if (response.status !== 401 || handlingUnauthorized) return false;
  handlingUnauthorized = true;

  try {
    const returnPath = `${window.location.pathname}${window.location.search}`;
    saveAttendanceReturnPath(window.sessionStorage, returnPath);
    window.localStorage.removeItem("baba_user");
  } catch {
    // Navigation must still continue when browser storage is unavailable.
  }

  window.dispatchEvent(new Event(BABA_SESSION_EXPIRED_EVENT));
  window.alert(
    "로그인 확인이 필요합니다. 다시 로그인하면 현재 근태 화면으로 돌아옵니다.\n\nCần xác nhận đăng nhập. Sau khi đăng nhập lại, ứng dụng sẽ quay về màn hình chấm công hiện tại."
  );
  window.location.replace("/login");
  return true;
}

export async function attendanceFetch(
  input: RequestInfo | URL,
  init?: RequestInit
) {
  if (handlingUnauthorized) {
    throw new Error("ATTENDANCE_RELOGIN_IN_PROGRESS");
  }
  const response = await fetch(input, init);
  if (response.status === 401) handleSessionUnauthorized(response);
  return response;
}

export function resetSessionUnauthorizedHandlerForTests() {
  handlingUnauthorized = false;
}
