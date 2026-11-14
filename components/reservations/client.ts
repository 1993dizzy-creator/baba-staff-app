import type { ReservationCopy } from "@/lib/text/reservations";
export class ReservationRequestError extends Error {
  constructor(readonly status: number, readonly code: string, readonly reservationId?: number) { super(code); }
}
export async function reservationRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch("/api/tables/reservations" + path, { ...init, cache: "no-store",
    signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
    headers: { "Content-Type": "application/json", ...init?.headers } });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.ok) throw new ReservationRequestError(response.status, body?.code ?? "unavailable", body?.reservationId);
  return body as T;
}
export function errorText(error: unknown, t: ReservationCopy) {
  if (!(error instanceof ReservationRequestError)) return t.unavailable;
  if (error.status === 409) return error.code === "source_conflict" ? t.sourceConflict : t.conflict;
  if (error.status === 403) return t.denied;
  if (error.status === 400) return t.invalid;
  return t.unavailable;
}
export const stamp = (v: string | null | undefined, lang: "ko" | "vi") => v && Number.isFinite(Date.parse(v))
  ? new Intl.DateTimeFormat(lang === "ko" ? "ko-KR" : "vi-VN", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(v)) : "—";
export const clock = (v: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(v));
