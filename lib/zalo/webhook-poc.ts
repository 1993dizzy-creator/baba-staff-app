/**
 * BABA Zalo Bot webhook — receive-only PoC.
 *
 * Purpose: prove that authenticated Zalo GROUP message events reach this server.
 * Nothing is persisted, no Bot API call is made, no reply is sent. Logs carry only
 * safe metadata: never the message text, sender id/name, phone numbers, Bot Token or
 * webhook secret. A 200 ACK here does NOT mean the event is stored anywhere.
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
};

export type ZaloLogger = (tag: string, data: string) => void;

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

class BodyError extends Error {}

/** Authenticated request with no body (possible connectivity probe; Zalo's testWebhook body is undocumented). */
const EMPTY_BODY = Symbol("empty_body");

async function readLimitedJson(req: Request): Promise<unknown> {
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
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  if (total === 0) return EMPTY_BODY;
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new BodyError("invalid_json");
  }
}

const json = (body: JsonRecord, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

/**
 * Response policy: Zalo documents no retry rule; its testWebhook treats any 2xx as success.
 * Authenticated, well-formed events are ACKed with 200 even when ignored, so Zalo has no
 * reason to redeliver. Config/auth/body failures return non-2xx and are never ACKed.
 */
export async function handleZaloWebhook(
  req: Request,
  env: ZaloWebhookEnv,
  log: ZaloLogger = (tag, data) => console.info(tag, data),
): Promise<Response> {
  // x-vercel-id looks like "sin1::iad1::abcd1-1700000000000-0123abcd"; only its charset is allowed through.
  const vercelId = req.headers.get("x-vercel-id");
  const requestId = vercelId && /^[A-Za-z0-9_.:-]{1,120}$/.test(vercelId) ? vercelId : null;
  // Zalo's documented WAF hint names a "Java/<version>" User-Agent; only the family is logged.
  const userAgent = req.headers.get("user-agent");
  const uaFamily = !userAgent ? null : /^Java\//.test(userAgent) ? "java" : "other";
  const emit = (data: JsonRecord) =>
    log(LOG_TAG, JSON.stringify({ request_id: requestId, ua: uaFamily, ...data }));

  if (!validSecret(env.ZALO_BOT_WEBHOOK_SECRET)) {
    emit({ result: "misconfigured" });
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

  let payload: unknown;
  try {
    payload = await readLimitedJson(req);
  } catch (error) {
    const code = error instanceof BodyError ? error.message : "invalid_json";
    emit({ result: code });
    return json({ ok: false, error: code }, code === "body_too_large" ? 413 : 400);
  }

  if (payload === EMPTY_BODY) {
    emit({ result: "empty_body" });
    return json({ ok: true, observed: false });
  }

  const observation = parseZaloObservation(payload);
  if (!observation) {
    emit({ result: "unknown_event_shape" });
    return json({ ok: true, observed: false });
  }

  const allowed = parseAllowedGroupIds(env.ZALO_BOT_WEBHOOK_POC_ALLOWED_GROUP_IDS);
  const classification = classifyZaloObservation(observation, allowed);
  const logData: JsonRecord = {
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
    logData.group_id = observation.chatId;
  }
  emit(logData);

  return json({ ok: true, observed: classification === "group_text_received" });
}
