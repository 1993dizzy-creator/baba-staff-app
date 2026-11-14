import "server-only";
import { NextResponse } from "next/server";
import { getAuthenticatedActor } from "@/lib/auth/server-auth";
import { supabaseServer } from "@/lib/supabase/server";
import { getBusinessDate } from "@/lib/common/business-time";
import { buildZaloInboxPlan, parseAllowedGroupIds } from "@/lib/zalo/webhook-poc";
import { permissions, reservationTables, isId, isVersion, isTableId, isDateKey, dateRange } from "./policy.ts";
import { record, reservationDto, detailDto, inboxDto } from "./dto.ts";
import { inboxStatuses, reservationStatuses } from "./types.ts";

export type ReservationContext = { params: Promise<{ id: string }> };
export type ReservationAction = "list" | "create" | "detail" | "update" | "transition" | "assign" | "release"
  | "inboxList" | "inboxDetail" | "dismiss" | "reprocess";
const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
const reply = (data: unknown, status = 200) => NextResponse.json(data, { status, headers });
class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, readonly metadata: Record<string, number> = {}) { super(code); }
}
const invalid = () => { throw new ApiError(400, "invalid_input"); };
const assertId = (value: string | undefined) => {
  if (!value || !/^[1-9]\d*$/.test(value) || !isId(Number(value))) return invalid();
  return Number(value);
};
async function body(req: Request) {
  if (Number(req.headers.get("content-length")) > 8192) return invalid();
  const reader = req.body?.getReader(); if (!reader) return invalid();
  const chunks: Uint8Array[] = []; let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    bytes += value.length;
    if (bytes > 8192) { await reader.cancel(); return invalid(); }
    chunks.push(value);
  }
  const merged = new Uint8Array(bytes); let at = 0;
  for (const chunk of chunks) { merged.set(chunk, at); at += chunk.length; }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(merged));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return invalid();
    return record(parsed);
  } catch { return invalid(); }
}
const version = (v: unknown) => isVersion(v) ? v : invalid();
const uuid = (v: unknown) => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
function reservationInput(raw: Record<string, unknown>, create: boolean) {
  const out: Record<string, unknown> = {};
  for (const [key, max, required] of [["customerName", 120, true], ["customerContact", 120, false], ["note", 1000, false]] as const) {
    if (!(key in raw) && !(create && required)) continue;
    if (typeof raw[key] !== "string" || (raw[key] as string).length > max || (required && !(raw[key] as string).trim())) return invalid();
    out[key] = (raw[key] as string).trim();
  }
  for (const [key, min, max] of [["partySize", 1, 200], ["durationMinutes", 15, 720]] as const) {
    if (!(key in raw) && !(create && key === "partySize")) continue;
    const n = raw[key]; if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) return invalid();
    out[key] = n;
  }
  if (create || "reservedAt" in raw) {
    const s = raw.reservedAt;
    if (typeof s !== "string" || !isDateKey(s.slice(0, 10))
      || !/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(s)
      || !Number.isFinite(Date.parse(s))) return invalid();
    out.reservedAt = s;
  }
  if (create) {
    if (!uuid(raw.requestKey)) return invalid(); out.requestKey = raw.requestKey;
    if (raw.sourceInboxId != null) {
      if (!isId(raw.sourceInboxId)) return invalid(); out.sourceInboxId = raw.sourceInboxId;
    }
  }
  return out;
}
function statuses(raw: string | null, allowed: readonly string[]) {
  if (!raw) return null;
  const values = raw.split(","); if (values.some(s => !allowed.includes(s))) return invalid();
  return values;
}
async function call(fn: string, args: Record<string, unknown>) {
  const { data, error } = await supabaseServer.rpc(fn, args);
  if (error) {
    if (["23505", "23P01", "40001", "40P01"].includes(error.code)) throw new ApiError(409, "conflict");
    throw new ApiError(503, "unavailable");
  }
  const result = record(data);
  if (!["ok", "duplicate"].includes(String(result.status))) {
    const code = String(result.status);
    const status = ({ forbidden: 403, not_found: 404, invalid_input: 400, reason_required: 400, invalid_source: 400,
      version_conflict: 409, table_conflict: 409, source_conflict: 409, invalid_transition: 409 } as Record<string, number>)[code];
    const meta: Record<string, number> = {};
    for (const key of ["currentVersion", "conflictReservationId", "reservationId"]) if (isId(result[key])) meta[key] = result[key];
    if (status) throw new ApiError(status, code, meta);
    throw new ApiError(503, "unavailable");
  }
  return result;
}

export async function reservationsApi(req: Request, context: ReservationContext | undefined, action: ReservationAction) {
  try {
    const auth = await getAuthenticatedActor();
    if (!auth.ok) return reply({ ok: false, code: auth.code }, auth.status);
    const p = permissions(auth.actor.role);
    if (!p.view || (!["list", "detail"].includes(action) && !p.manage)) throw new ApiError(403, "forbidden");
    const actor = { p_actor_user_id: auth.actor.id };
    const url = new URL(req.url);
    const id = context ? assertId((await context.params).id) : undefined;
    const today = getBusinessDate();
    if (action === "list" || action === "inboxList") {
      const from = url.searchParams.get("from") ?? today, to = url.searchParams.get("to") ?? from;
      if (!dateRange(from, to)) return invalid();
      const filter = statuses(url.searchParams.get("status"), action === "list" ? reservationStatuses : inboxStatuses);
      const args = { ...actor, p_business_date_from: from, p_business_date_to: to, p_statuses: filter };
      if (action === "inboxList") {
        const data = await call("reservation_inbox_list_v1", { ...args, p_limit: 500 });
        const items = Array.isArray(data.items) ? data.items : [];
        return reply({ ok: true, items: items.map(v => inboxDto(v)), truncated: items.length >= 500 });
      }
      const data = await call("reservation_list_v1", args);
      const items = Array.isArray(data.items) ? data.items : [];
      const current = from === today && to === today && !filter ? data : await call("reservation_list_v1", {
        ...actor, p_business_date_from: today, p_business_date_to: today, p_statuses: null,
      });
      const todays = (Array.isArray(current.items) ? current.items : []).map(v => reservationDto(v, p));
      return reply({ ok: true, items: items.map(v => reservationDto(v, p)), today, permissions: p, tables: reservationTables,
        truncated: items.length >= 1000 || todays.length >= 1000, summary: { total: todays.length, pending: todays.filter(r => r.status === "pending").length,
          guests: todays.filter(r => ["pending", "confirmed", "arrived"].includes(r.status)).reduce((sum, r) => sum + r.partySize, 0) } });
    }
    if (action === "detail") {
      const reveal = url.searchParams.get("reveal") === "1";
      if (reveal && !p.reveal) throw new ApiError(403, "forbidden");
      const data = await call("reservation_get_v1", { ...actor, p_reservation_id: id, p_reveal_contact: reveal });
      return reply({ ok: true, ...detailDto(data, p, reveal), permissions: p });
    }
    if (action === "inboxDetail") {
      const data = await call("reservation_inbox_get_v1", { ...actor, p_inbox_id: id });
      const item = inboxDto(data.item, true);
      const linkedReservations = [];
      // Phase 1 permits at most one; keep reads bounded even if legacy rows violate that policy.
      for (const reservationId of item.reservationIds.slice(0, 1)) {
        linkedReservations.push(detailDto(await call("reservation_get_v1", { ...actor,
          p_reservation_id: reservationId, p_reveal_contact: false }), p));
      }
      return reply({ ok: true, item, linkedReservations, processingHistoryAvailable: false });
    }
    if (action === "reprocess") {
      const allowed = parseAllowedGroupIds(process.env.ZALO_BOT_WEBHOOK_POC_ALLOWED_GROUP_IDS);
      if (!allowed.length) throw new ApiError(503, "allowlist_unset");
      const current = record((await call("reservation_inbox_get_v1", { ...actor, p_inbox_id: id })).item);
      if (current.piiPurged || current.status !== "quarantined") throw new ApiError(409, "invalid_transition");
      const plan = buildZaloInboxPlan(current.rawPayload, String(current.payloadSha256), allowed,
        typeof current.rawBody === "string" ? current.rawBody : undefined);
      const data = plan.action === "drop" ? await call("reservation_inbox_dismiss_v1", { ...actor,
        p_inbox_id: id, p_note: "parser_dropped" }) : await call("reservation_inbox_reprocess_v1", { ...actor,
        p_inbox_id: id, p_entry: plan.entry });
      return reply({ ok: true, item: inboxDto(data.item, true), duplicate: data.status === "duplicate" });
    }
    const raw = await body(req);
    if (action === "dismiss") {
      if (typeof raw.note !== "string" || raw.note.length > 500) return invalid();
      const data = await call("reservation_inbox_dismiss_v1", { ...actor, p_inbox_id: id, p_note: raw.note });
      return reply({ ok: true, item: inboxDto(data.item, true) });
    }
    let data: Record<string, unknown>;
    if (action === "create") {
      data = await call("reservation_create_v1", { ...actor, p_input: reservationInput(raw, true) });
    } else {
      const common = { ...actor, p_reservation_id: id, p_expected_version: version(raw.expectedVersion) };
      if (action === "update") data = await call("reservation_update_v1", { ...common, p_input: reservationInput(raw, false) });
      else if (action === "transition") {
        if (typeof raw.toStatus !== "string" || !["pending", "arrived", "completed", "cancelled", "no_show"].includes(raw.toStatus)
          || typeof raw.reason !== "string" || raw.reason.length > 500) return invalid();
        data = await call("reservation_transition_v1", { ...common, p_to_status: raw.toStatus, p_reason: raw.reason });
      } else if (action === "assign") {
        if (!isTableId(raw.tableId)) return invalid();
        data = await call("reservation_link_table_v1", { ...common, p_table_id: raw.tableId });
      } else {
        if (!isId(raw.linkId) || typeof raw.reason !== "string" || raw.reason.length > 200) return invalid();
        data = await call("reservation_release_table_v1", { ...common, p_link_id: raw.linkId, p_reason: raw.reason });
      }
    }
    return reply({ ok: true, reservation: reservationDto(data.reservation, p), duplicateRequest: data.duplicateRequest === true });
  } catch (error) {
    if (error instanceof ApiError) return reply({ ok: false, code: error.code, ...error.metadata }, error.status);
    return reply({ ok: false, code: "unavailable" }, 503);
  }
}
