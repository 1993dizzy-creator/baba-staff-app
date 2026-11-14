import { BABA_TABLES } from "../sales/baba-table-catalog.ts";
import type { ReservationPermissions } from "./types.ts";

export const reservationTables = BABA_TABLES.map(t => ({ id: t.MapObjectID, name: t.MapObjectName, area: t.displayArea }));
export function permissions(role: string): ReservationPermissions {
  const view = ["owner", "master", "manager", "leader", "staff"].includes(role);
  const manage = ["owner", "master", "manager", "leader"].includes(role);
  return { view, manage, inbox: manage, reveal: manage, confirm: view };
}
export const isId = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
export const isVersion = (v: unknown): v is number => isId(v) && v < 2147483647;
export const isTableId = (v: unknown): v is string => typeof v === "string" && reservationTables.some(t => t.id === v);
export function isDateKey(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && v.slice(0, 4) >= "0001" && Number.isFinite(Date.parse(v + "T12:00:00Z"))
    && new Date(v + "T12:00:00Z").toISOString().slice(0, 10) === v;
}
export function dateRange(from: string | null, to: string | null) {
  return isDateKey(from) && isDateKey(to) && to >= from && (Date.parse(to) - Date.parse(from)) / 86400000 <= 92;
}
export function localVisit(date: string, time: string): string | null {
  if (!isDateKey(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return null;
  return `${date}T${time}:00+07:00`;
}
export function visitParts(at: string) {
  const date = new Date(Date.parse(at) + 7 * 3600000).toISOString();
  return { date: date.slice(0, 10), time: date.slice(11, 16) };
}
export function monthWindow(month: string) {
  const start = `${month}-01`;
  const at = new Date(start + "T12:00:00Z");
  const weekday = (at.getUTCDay() + 6) % 7;
  at.setUTCDate(1 - weekday);
  const days = Array.from({ length: 42 }, (_, i) => new Date(at.getTime() + i * 86400000).toISOString().slice(0, 10));
  return { from: days[0], to: days[41], days };
}
