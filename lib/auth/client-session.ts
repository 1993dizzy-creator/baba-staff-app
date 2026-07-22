"use client";

export const BABA_SESSION_EXPIRED_EVENT = "baba_session_expired";
export const BABA_SESSION_RETURN_PATH_KEY = "baba_session_return_path";

let handlingUnauthorized = false;

export function handleSessionUnauthorized(response: Response) {
  if (response.status !== 401 || handlingUnauthorized) return false;
  handlingUnauthorized = true;

  try {
    const returnPath = `${window.location.pathname}${window.location.search}`;
    window.sessionStorage.setItem(BABA_SESSION_RETURN_PATH_KEY, returnPath);
    window.localStorage.removeItem("baba_user");
  } catch {
    // Navigation must still continue when browser storage is unavailable.
  }

  window.dispatchEvent(new Event(BABA_SESSION_EXPIRED_EVENT));
  window.alert(
    "로그인이 만료되었습니다. 다시 로그인해 주세요. / Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại."
  );
  window.location.replace("/login");
  return true;
}

export function resetSessionUnauthorizedHandlerForTests() {
  handlingUnauthorized = false;
}
