"use client";

type BarClientActor = { id?: unknown; username?: unknown };

function readBarClientActor(): BarClientActor | null {
  try {
    const raw = window.localStorage.getItem("baba_user");
    return raw ? JSON.parse(raw) as BarClientActor : null;
  } catch {
    return null;
  }
}

export function barActorHeaders(initial?: HeadersInit) {
  const headers = new Headers(initial);
  const actor = readBarClientActor();
  if (actor?.id != null) headers.set("x-baba-actor-id", String(actor.id));
  if (typeof actor?.username === "string") headers.set("x-baba-actor-username", actor.username);
  return headers;
}

export function fetchBarApi(input: RequestInfo | URL, init: RequestInit = {}) {
  return fetch(input, { ...init, headers: barActorHeaders(init.headers) });
}

export async function handleBarApiUnauthorized(response: Response) {
  if (response.status !== 401) return false;
  const result = await response.clone().json().catch(() => null);
  if (result?.code !== "RELOGIN_REQUIRED") return false;
  window.localStorage.removeItem("baba_user");
  window.alert("보안을 위해 다시 로그인해 주세요. / Vui lòng đăng nhập lại để bảo mật.");
  window.location.href = "/login";
  return true;
}
