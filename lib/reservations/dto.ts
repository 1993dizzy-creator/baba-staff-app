import { isTableId } from "./policy.ts";
import { reservationStatuses, inboxStatuses, type Reservation, type ReservationDetail, type ReservationPermissions,
  type InboxItem } from "./types.ts";

type Row = Record<string, unknown>;
export const record = (v: unknown): Row => v && typeof v === "object" && !Array.isArray(v) ? v as Row : {};
const text = (v: unknown) => typeof v === "string" ? v : null;
const number = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) ? v : null;
const array = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const mask = (v: unknown) => {
  if (typeof v !== "string") return null;
  const digits = v.replace(/\D/g, "");
  return v.startsWith("***") && /^\*{3}(\d{3})?$/.test(v) ? v : digits.length >= 4 ? "***" + digits.slice(-3) : "***";
};
export function reservationDto(value: unknown, p: ReservationPermissions, detail = false, reveal = false): Reservation {
  const r = record(value);
  if (!number(r.id) || !reservationStatuses.includes(r.status as Reservation["status"]) || !number(r.version)
    || !number(r.partySize) || !text(r.reservedAt) || !text(r.businessDate)
    || !Number.isFinite(Date.parse(String(r.reservedAt)))) throw Error("bad_rpc_result");
  const out: Reservation = {
    id: r.id as number, status: r.status as Reservation["status"], partySize: r.partySize as number,
    reservedAt: r.reservedAt as string, businessDate: r.businessDate as string, version: r.version as number,
    durationMinutes: number(r.durationMinutes) ?? 120, confirmedBy: number(r.confirmedBy), confirmedAt: text(r.confirmedAt),
    piiPurged: r.piiPurged === true, tables: array(r.tables).flatMap(v => {
      const t = record(v); return number(t.linkId) && isTableId(t.tableId) ? [{ linkId: t.linkId as number, tableId: t.tableId }] : [];
    }),
  };
  if (p.manage) {
    out.customerName = text(r.customerName) ?? "";
    if (detail) {
      out.customerContact = reveal && p.reveal ? text(r.customerContact) : mask(r.customerContact);
      out.contactMasked = !reveal && r.customerContact != null;
      out.note = text(r.note); out.cancelReason = text(r.cancelReason);
    }
  }
  return out;
}
const safeChanges = (v: unknown) => {
  const r = record(v); const out: Row = {};
  for (const k of ["partySize", "durationMinutes", "releasedTables", "deliveryCount", "linkId", "sourceInboxId", "reservationId", "duplicateOf"]) {
    if (number(r[k]) != null) out[k] = r[k];
  }
  for (const k of ["hasReason", "hasContact", "payloadMismatch"]) if (typeof r[k] === "boolean") out[k] = r[k];
  if (typeof r.confirmedAt === "string" && Number.isFinite(Date.parse(r.confirmedAt))) out.confirmedAt = r.confirmedAt;
  const fields = array(r.fields).filter(v => ["customerName", "customerContact", "note", "partySize", "reservedAt", "durationMinutes"].includes(String(v)));
  if (fields.length) out.fields = fields;
  return out;
};
export function detailDto(value: unknown, p: ReservationPermissions, reveal = false): ReservationDetail {
  const r = record(value);
  return { reservation: reservationDto(r.reservation, p, true, reveal), events: array(r.events).map(v => {
    const e = record(v);
    return { id: number(e.id) ?? 0, type: text(e.type) ?? "", fromStatus: text(e.fromStatus), toStatus: text(e.toStatus),
      actorUserId: number(e.actorUserId), createdAt: text(e.createdAt) ?? "", changes: p.manage ? safeChanges(e.changes) : {} };
  }), tableHistory: array(r.tableHistory).flatMap(v => {
    const l = record(v); if (!isTableId(l.tableId)) return [];
    return [{ linkId: number(l.linkId) ?? 0, tableId: l.tableId, plannedFrom: text(l.plannedFrom) ?? "",
      plannedTo: text(l.plannedTo) ?? "", linkedAt: text(l.linkedAt) ?? "", releasedAt: text(l.releasedAt),
      ...(p.manage ? { releaseReason: text(l.releaseReason) } : {}) }];
  }) };
}
export function inboxDto(value: unknown, detail = false): InboxItem {
  const r = record(value);
  if (!number(r.id) || !inboxStatuses.includes(r.status as InboxItem["status"])) throw Error("bad_rpc_result");
  const originalText = detail ? text(r.messageText) ?? text(r.rawBody)
    ?? (r.rawPayload == null ? null : JSON.stringify(r.rawPayload)) : null;
  return { id: r.id as number, status: r.status as InboxItem["status"], quarantineReason: text(r.quarantineReason),
    messageAt: text(r.messageAt), receivedAt: text(r.receivedAt) ?? "", businessDate: text(r.businessDate) ?? "",
    deliveryCount: number(r.deliveryCount) ?? 1, payloadMismatchCount: number(r.payloadMismatchCount) ?? 0,
    reprocessCount: number(r.reprocessCount) ?? 0, piiPurged: r.piiPurged === true,
    reservationIds: array(r.reservationIds).filter(v => number(v) != null) as number[],
    ...(detail ? { senderName: text(r.senderName), messageText: text(r.messageText),
      originalText, reviewNote: text(r.reviewNote) } : {}) };
}
