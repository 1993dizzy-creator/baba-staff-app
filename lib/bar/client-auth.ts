"use client";

export async function handleBarApiUnauthorized(response: Response) {
  if (response.status !== 401) return false;
  const result = await response.clone().json().catch(() => null);
  if (result?.code !== "RELOGIN_REQUIRED") return false;
  window.localStorage.removeItem("baba_user");
  window.alert("보안을 위해 다시 로그인해 주세요. / Vui lòng đăng nhập lại để bảo mật.");
  window.location.href = "/login";
  return true;
}
