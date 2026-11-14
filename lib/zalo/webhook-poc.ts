/**
 * BABA Zalo Bot webhook.
 *
 * Two modes, chosen by ZALO_BOT_WEBHOOK_MODE:
 *  - "observe" (default, the verified PoC behavior): nothing is persisted; a 200 ACK does NOT
 *    mean the event is stored anywhere.
 *  - "persist" (reservation Phase 1): every authenticated delivery from an allowlisted group
 *    (plus malformed / non-text / private deliveries, quarantined) is stored in the reservation
 *    inbox BEFORE the 200 ACK. A storage failure answers 503 so the delivery is not ACKed.
 *    The webhook never creates or confirms a reservation. Persist mode refuses to run (503)
 *    without a non-empty group allowlist.
 * No Bot API call is made and no reply is sent in either mode. Logs carry only safe metadata:
 * never the message text, sender id/name, phone numbers, Bot Token or webhook secret.
 *
 * Unconfirmed Zalo behavior (not documented, not observed): whether/when Zalo redelivers after a
 * non-2xx or a timeout, whether message_id is unique across chats, and the unit of message.date.
 * Deduplication therefore keys on (chat id, message id) and every redelivery is counted.
 *
 * Payload shape (official docs, bot.zapps.me/docs/webhook, checked 2026-11-13):
 *   { event_name, message: { message_id, date, message_type?, from: { id, display_name,
 *     is_bot }, chat: { id, chat_type: "PRIVATE" | "GROUP" (Beta) }, text? } }
 * The webhook body is flat; getUpdates wraps the same object as { ok, result }, so both
 * are accepted. No mention field is documented, so mention detection is diagnostic only.
 */
import { createHash, timingSafeEqual } from "node:crypto";

type JsonRecord = Record<string, unknown>;

export const ZALO_SECRET_HEADER = "x-bot-api-secret-token";
export const MAX_BODY_BYTES = 64 * 1024;
const LOG_TAG = "[ZALO_WEBHOOK_POC]";

export type ZaloWebhookEnv = {
  ZALO_BOT_WEBHOOK_SECRET?: string;
  ZALO_BOT_WEBHOOK_POC_ALLOWED_GROUP_IDS?: string;
  ZALO_BOT_WEBHOOK_POC_SHOW_GROUP_ID?: string;
  ZALO_BOT_WEBHOOK_MODE?: string;
};

export type ZaloLogger = (tag: string, data: string) => void;

export type ZaloWebhookMode = "observe" | "persist";

export function zaloWebhookMode(env: ZaloWebhookEnv): ZaloWebhookMode {
  return env.ZALO_BOT_WEBHOOK_MODE?.trim().toLowerCase() === "persist" ? "persist" : "observe";
}

export type ZaloQuarantineReason =
  | "invalid_json"
  | "unknown_event_shape"
  | "invalid_group_text"
  | "not_group"
  | "other_event";

/** Row handed to public.reservation_inbox_ingest_v1 (contains personal data: never log it). */
export type ZaloInboxEntry = {
  status: "received" | "quarantined";
  quarantine_reason: ZaloQuarantineReason | null;
  event_name: string | null;
  chat_type: string | null;
  message_type: string | null;
  chat_id: string | null;
  message_id: string | null;
  sender_id: string | null;
  sender_name: string | null;
  message_text: string | null;
  message_at: string | null;
  payload_sha256: string;
} & ({ raw_payload: unknown } | { raw_body: string });

export type ZaloInboxPersistResult = {
  status: "stored" | "duplicate";
  inboxId: number;
  deliveryCount: number;
  payloadMismatch: boolean;
};

export type ZaloInboxPersist = (entry: ZaloInboxEntry) => Promise<ZaloInboxPersistResult>;

/** Thrown by persist adapters; `code` must be a short safe token (never a DB message). */
export class ZaloInboxPersistError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = /^[A-Za-z0-9_]{1,40}$/.test(code) ? code : "unknown";
  }
}

export type ZaloObservation = {
  eventName: string;
  chatType: "GROUP" | "PRIVATE" | "UNKNOWN";
  chatTypeRaw: string | null;
  chatId: string | null;
  messageId: string | null;
  messageType: string | null;
  fromBot: boolean;
  textLength: number | null;
  messageKeys: string[];
  mentionField: boolean;
};

export type ZaloClassification =
  | "group_text_received"
  | "other_group"
  | "not_group"
  | "bot_message"
  | "other_event"
  | "invalid_group_text";

const asRecord = (value: unknown): JsonRecord | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;

const nonEmptyString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;

/** Only enum-like tokens are echoed into logs; anything else becomes null. */
const safeToken = (value: unknown): string | null =>
  typeof value === "string" && /^[A-Za-z0-9_.]{1,40}$/.test(value) ? value : null;

export function validSecret(configured: string | undefined): string | null {
  const value = configured?.trim();
  return value && value.length >= 8 && value.length <= 256 ? value : null;
}

/** Compare fixed-length SHA-256 digests so header length does not leak via timing. */
export function verifyZaloWebhookSecret(received: string | null, configured: string | undefined): boolean {
  const expected = validSecret(configured);
  const actual = received?.trim();
  if (!expected || !actual || actual.length > 512) return false;
  const a = createHash("sha256").update(actual, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

export function parseZaloObservation(payload: unknown): ZaloObservation | null {
  const root = asRecord(payload);
  if (!root) return null;
  const data = typeof root.event_name === "string" ? root : asRecord(root.result) ?? root;
  const eventName = nonEmptyString(data.event_name);
  const message = asRecord(data.message);
  if (!eventName || !message) return null;
  const chat = asRecord(message.chat);
  const from = asRecord(message.from);
  const rawChatType = chat?.chat_type;
  const messageKeys = Object.keys(message).filter((key) => /^[A-Za-z0-9_]{1,40}$/.test(key)).sort().slice(0, 30);
  return {
    eventName: safeToken(eventName) ?? "unrecognized",
    chatType: rawChatType === "GROUP" || rawChatType === "PRIVATE" ? rawChatType : "UNKNOWN",
    chatTypeRaw: safeToken(rawChatType),
    chatId: nonEmptyString(chat?.id),
    messageId: nonEmptyString(message.message_id),
    messageType: safeToken(message.message_type),
    fromBot: from?.is_bot === true,
    textLength: typeof message.text === "string" ? message.text.length : null,
    messageKeys,
    mentionField: messageKeys.some((key) => /mention|entit/i.test(key)),
  };
}

export function parseAllowedGroupIds(raw: string | undefined): string[] {
  return (raw ?? "").split(",").map((id) => id.trim()).filter(Boolean);
}

/**
 * Empty allowlist = discovery mode (all groups observed). Must be set before real ingestion.
 * Entries may be the raw group id or its logged 16-hex `group_fp`, so the allowlist can be
 * built from routine logs without ever turning on the raw group id toggle.
 */
export function isAllowedGroup(chatId: string, allowed: string[]): boolean {
  if (allowed.length === 0) return true;
  const fp = fingerprint(chatId);
  return allowed.includes(chatId) || (fp !== null && allowed.includes(fp));
}

export function classifyZaloObservation(observation: ZaloObservation, allowed: string[] = []): ZaloClassification {
  if (observation.eventName !== "message.text.received") return "other_event";
  if (observation.fromBot) return "bot_message";
  if (observation.chatType !== "GROUP") return "not_group";
  if (!observation.chatId || !observation.messageId || observation.textLength === null) return "invalid_group_text";
  if (!isAllowedGroup(observation.chatId, allowed)) return "other_group";
  return "group_text_received";
}

/** Short opaque correlation id for logs. */
export function fingerprint(value: string | null): string | null {
  return value ? createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16) : null;
}

const sha256Hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Zalo's message.date unit is undocumented: >= 1e11 is read as epoch ms, else epoch seconds. */
export function parseZaloMessageDate(value: unknown): string | null {
  const n = typeof value === "number" ? value : typeof value === "string" && /^\d{9,16}$/.test(value) ? Number(value) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = n >= 1e11 ? n : n * 1000;
  // 2020-01-01 .. 2100-01-01; anything else is treated as unknown rather than trusted.
  if (ms < 1577836800000 || ms >= 4102444800000) return null;
  return new Date(ms).toISOString();
}

function unwrap(payload: unknown): JsonRecord | null {
  const root = asRecord(payload);
  if (!root) return null;
  return typeof root.event_name === "string" ? root : asRecord(root.result) ?? root;
}

export type ZaloInboxPlan =
  | {
      action: "store";
      classification: ZaloClassification | "unknown_event_shape" | "invalid_json";
      observation: ZaloObservation | null;
      entry: ZaloInboxEntry;
    }
  | { action: "drop"; classification: "other_group" | "bot_message"; observation: ZaloObservation };

/**
 * Persist-mode decision for one authenticated delivery. Shared by the webhook and by inbox
 * reprocessing, so a quarantined row is re-judged by exactly the same rules.
 *  - a chat that is not PRIVATE and not allowlisted -> dropped (never stored)
 *  - the bot's own message -> dropped
 *  - GROUP text from an allowlisted group -> stored as 'received'
 *  - everything else (bad JSON, unknown shape, non-text event, PRIVATE chat, missing ids) ->
 *    stored as 'quarantined' with the reason, so nothing authenticated is silently lost.
 */
export function buildZaloInboxPlan(
  payload: unknown,
  payloadSha256: string,
  allowed: string[],
  rawBody?: string,
): ZaloInboxPlan {
  const blank = {
    event_name: null, chat_type: null, message_type: null, chat_id: null, message_id: null,
    sender_id: null, sender_name: null, message_text: null, message_at: null,
  };
  if (rawBody !== undefined) {
    return {
      action: "store", classification: "invalid_json", observation: null,
      entry: { status: "quarantined", quarantine_reason: "invalid_json", ...blank, payload_sha256: payloadSha256, raw_body: rawBody },
    };
  }
  const observation = parseZaloObservation(payload);
  if (!observation) {
    return {
      action: "store", classification: "unknown_event_shape", observation: null,
      entry: { status: "quarantined", quarantine_reason: "unknown_event_shape", ...blank, payload_sha256: payloadSha256, raw_payload: payload },
    };
  }
  // Group allowlist applies to every event type, and fails closed when the list is empty.
  if (observation.chatId && observation.chatType !== "PRIVATE" &&
      (allowed.length === 0 || !isAllowedGroup(observation.chatId, allowed))) {
    return { action: "drop", classification: "other_group", observation };
  }
  if (observation.fromBot) return { action: "drop", classification: "bot_message", observation };

  const classification = classifyZaloObservation(observation, allowed);
  const message = asRecord(unwrap(payload)?.message) ?? {};
  const from = asRecord(message.from);
  const chat = asRecord(message.chat);
  const entry: ZaloInboxEntry = {
    status: classification === "group_text_received" ? "received" : "quarantined",
    quarantine_reason: classification === "group_text_received" ? null : (classification as ZaloQuarantineReason),
    event_name: nonEmptyString(unwrap(payload)?.event_name),
    chat_type: nonEmptyString(chat?.chat_type),
    message_type: nonEmptyString(message.message_type),
    chat_id: observation.chatId,
    message_id: observation.messageId,
    sender_id: nonEmptyString(from?.id),
    sender_name: nonEmptyString(from?.display_name),
    message_text: typeof message.text === "string" ? message.text : null,
    message_at: parseZaloMessageDate(message.date),
    payload_sha256: payloadSha256,
    raw_payload: payload,
  };
  return { action: "store", classification, observation, entry };
}

class BodyError extends Error {}

/** Authenticated request with no body (possible connectivity probe; Zalo's testWebhook body is undocumented). */
const EMPTY_BODY = Symbol("empty_body");

async function readLimitedBody(req: Request): Promise<Uint8Array | typeof EMPTY_BODY> {
  if (!req.body) return EMPTY_BODY;
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new BodyError("body_too_large");
    }
    parts.push(value);
  }
  if (total === 0) return EMPTY_BODY;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

function decodeJson(bytes: Uint8Array): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) };
  } catch {
    return { ok: false };
  }
}

const json = (body: JsonRecord, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

function observationLog(observation: ZaloObservation, classification: string, allowed: string[], env: ZaloWebhookEnv): JsonRecord {
  const data: JsonRecord = {
    result: classification,
    event: observation.eventName,
    chat_type: observation.chatType,
    chat_type_raw: observation.chatTypeRaw,
    message_type: observation.messageType,
    group_fp: observation.chatType === "GROUP" ? fingerprint(observation.chatId) : null,
    message_fp: fingerprint(observation.messageId),
    text_length: observation.textLength,
    message_keys: observation.messageKeys,
    mention_field: observation.mentionField,
    allowlist: allowed.length ? "set" : "unset",
  };
  if (
    observation.chatType === "GROUP" &&
    observation.chatId &&
    env.ZALO_BOT_WEBHOOK_POC_SHOW_GROUP_ID?.trim() === "true"
  ) {
    // Short-lived discovery toggle for building the allowlist. Keep OFF by default.
    data.group_id = observation.chatId;
  }
  return data;
}

/**
 * Response policy: Zalo documents no retry rule; its testWebhook treats any 2xx as success.
 * Observe mode: authenticated, well-formed events are ACKed with 200 even when ignored.
 * Persist mode: 200 only after the inbox row is committed (or the event is intentionally
 * dropped: other group / bot's own message); a storage failure answers 503 and is never ACKed.
 * Config/auth/size failures return non-2xx in both modes.
 */
export async function handleZaloWebhook(
  req: Request,
  env: ZaloWebhookEnv,
  log: ZaloLogger = (tag, data) => console.info(tag, data),
  persist?: ZaloInboxPersist,
): Promise<Response> {
  // x-vercel-id looks like "sin1::iad1::abcd1-1700000000000-0123abcd"; only its charset is allowed through.
  const vercelId = req.headers.get("x-vercel-id");
  const requestId = vercelId && /^[A-Za-z0-9_.:-]{1,120}$/.test(vercelId) ? vercelId : null;
  // Zalo's documented WAF hint names a "Java/<version>" User-Agent; only the family is logged.
  const userAgent = req.headers.get("user-agent");
  const uaFamily = !userAgent ? null : /^Java\//.test(userAgent) ? "java" : "other";
  const mode = zaloWebhookMode(env);
  const emit = (data: JsonRecord) =>
    log(LOG_TAG, JSON.stringify({ request_id: requestId, ua: uaFamily, ...(mode === "persist" ? { mode } : {}), ...data }));

  if (!validSecret(env.ZALO_BOT_WEBHOOK_SECRET)) {
    emit({ result: "misconfigured" });
    return json({ ok: false, error: "misconfigured" }, 503);
  }
  const allowed = parseAllowedGroupIds(env.ZALO_BOT_WEBHOOK_POC_ALLOWED_GROUP_IDS);
  if (mode === "persist" && (allowed.length === 0 || !persist)) {
    emit({ result: "misconfigured", reason: allowed.length === 0 ? "allowlist_unset" : "persist_unavailable" });
    return json({ ok: false, error: "misconfigured" }, 503);
  }
  const header = req.headers.get(ZALO_SECRET_HEADER);
  if (!verifyZaloWebhookSecret(header, env.ZALO_BOT_WEBHOOK_SECRET)) {
    emit({ result: "unauthorized", reason: header ? "mismatch" : "missing" });
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  const declaredLength = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    emit({ result: "body_too_large" });
    return json({ ok: false, error: "body_too_large" }, 413);
  }

  let body: Uint8Array | typeof EMPTY_BODY;
  try {
    body = await readLimitedBody(req);
  } catch {
    emit({ result: "body_too_large" });
    return json({ ok: false, error: "body_too_large" }, 413);
  }

  if (body === EMPTY_BODY) {
    emit({ result: "empty_body" });
    return json({ ok: true, observed: false });
  }

  const decoded = decodeJson(body);

  if (mode === "observe") {
    if (!decoded.ok) {
      emit({ result: "invalid_json" });
      return json({ ok: false, error: "invalid_json" }, 400);
    }
    const observation = parseZaloObservation(decoded.value);
    if (!observation) {
      emit({ result: "unknown_event_shape" });
      return json({ ok: true, observed: false });
    }
    const classification = classifyZaloObservation(observation, allowed);
    emit(observationLog(observation, classification, allowed, env));
    return json({ ok: true, observed: classification === "group_text_received" });
  }

  // Persist mode.
  const sha = sha256Hex(body);
  const plan = decoded.ok
    ? buildZaloInboxPlan(decoded.value, sha, allowed)
    : buildZaloInboxPlan(null, sha, allowed, new TextDecoder("utf-8").decode(body));
  const base: JsonRecord = plan.observation
    ? observationLog(plan.observation, plan.classification, allowed, env)
    : { result: plan.classification, allowlist: "set" };
  const observed = plan.classification === "group_text_received";

  if (plan.action === "drop") {
    emit({ ...base, stored: false });
    return json({ ok: true, observed: false, stored: false });
  }

  let saved: ZaloInboxPersistResult;
  try {
    saved = await persist!(plan.entry);
  } catch (error) {
    const code = error instanceof ZaloInboxPersistError ? error.code : "unknown";
    emit({ ...base, result: "persist_failed", classification: plan.classification, error_code: code, stored: false });
    return json({ ok: false, error: "persist_failed" }, 503);
  }
  emit({
    ...base,
    stored: true,
    inbox_status: plan.entry.status,
    inbox_id: saved.inboxId,
    duplicate: saved.status === "duplicate",
    delivery_count: saved.deliveryCount,
    payload_mismatch: saved.payloadMismatch,
  });
  return json({ ok: true, observed, stored: true, duplicate: saved.status === "duplicate" });
}
