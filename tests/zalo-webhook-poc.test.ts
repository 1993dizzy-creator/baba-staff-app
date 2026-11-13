import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  MAX_BODY_BYTES,
  classifyZaloObservation,
  fingerprint,
  handleZaloWebhook,
  parseAllowedGroupIds,
  parseZaloObservation,
  verifyZaloWebhookSecret,
  type ZaloWebhookEnv,
} from "../lib/zalo/webhook-poc.ts";

// Test-only placeholders; not real credentials.
const SECRET = "test-webhook-secret-0123456789";
const GROUP_ID = "grp-test-0001";
const SENDER_ID = "sender-test-0001";
const SENDER_NAME = "Khach Test Name";
const TEXT = "@Bot đặt BABA TEST BABA 002 0901234567";

// Shape from the official webhook sample (flat, is_bot, chat_type).
function event(overrides: { chat_type?: string; chat_id?: string; event_name?: string; is_bot?: boolean; extra?: Record<string, unknown> } = {}) {
  return {
    event_name: overrides.event_name ?? "message.text.received",
    message: {
      message_id: "msg-test-0001",
      date: 1794551160000,
      message_type: "CHAT_TEXT",
      from: { id: SENDER_ID, display_name: SENDER_NAME, is_bot: overrides.is_bot ?? false },
      chat: { id: overrides.chat_id ?? GROUP_ID, chat_type: overrides.chat_type ?? "GROUP" },
      text: TEXT,
      ...overrides.extra,
    },
  };
}

function request(body: string | object, headers: Record<string, string> = { "x-bot-api-secret-token": SECRET }) {
  return new Request("https://example.test/api/integrations/zalo-bot", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function call(req: Request, env: ZaloWebhookEnv = { ZALO_BOT_WEBHOOK_SECRET: SECRET }) {
  const logs: string[] = [];
  const res = await handleZaloWebhook(req, env, (tag, data) => logs.push(`${tag} ${data}`));
  const body = (await res.json()) as Record<string, unknown>;
  const entries = logs.map((line) => JSON.parse(line.slice(line.indexOf(" ") + 1)) as Record<string, unknown>);
  return { status: res.status, body, logs, entries };
}

function assertNoSensitive(logs: string[]) {
  const all = logs.join("\n");
  for (const value of [SECRET, SENDER_ID, SENDER_NAME, TEXT, "0901234567", "TEST BABA", GROUP_ID]) {
    assert.ok(!all.includes(value), `log leaked ${value}`);
  }
}

test("1/8 valid secret + GROUP text is observed with safe metadata only", async () => {
  const r = await call(request(event()));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, observed: true });
  assert.equal(r.entries.length, 1);
  const log = r.entries[0];
  assert.equal(log.result, "group_text_received");
  assert.equal(log.chat_type, "GROUP");
  assert.equal(log.event, "message.text.received");
  assert.equal(log.message_type, "CHAT_TEXT");
  assert.equal(log.group_fp, fingerprint(GROUP_ID));
  assert.equal(log.text_length, TEXT.length);
  assert.equal(log.allowlist, "unset");
  assert.equal("group_id" in log, false);
  assertNoSensitive(r.logs);
});

test("getUpdates-style { ok, result } wrapper parses the same as the flat webhook body", () => {
  assert.deepEqual(parseZaloObservation({ ok: true, result: event() }), parseZaloObservation(event()));
});

test("2 missing secret header -> 401, body never parsed", async () => {
  const r = await call(request("{not json", {}));
  assert.equal(r.status, 401);
  assert.equal(r.entries[0].reason, "missing");
  assertNoSensitive(r.logs);
});

test("3 wrong secret -> 401", async () => {
  const r = await call(request(event(), { "x-bot-api-secret-token": "wrong-secret-value" }));
  assert.equal(r.status, 401);
  assert.equal(r.entries[0].reason, "mismatch");
  assert.ok(!r.logs.join("").includes("wrong-secret-value"));
  assertNoSensitive(r.logs);
});

test("4 secret env unset/blank/too short -> 503 fail-closed, even with a header", async () => {
  for (const configured of [undefined, "", "   ", "short"]) {
    const r = await call(request(event(), { "x-bot-api-secret-token": configured ?? "" }), { ZALO_BOT_WEBHOOK_SECRET: configured });
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "misconfigured");
  }
  assert.equal(verifyZaloWebhookSecret("short", "short"), false);
  assert.equal(verifyZaloWebhookSecret(null, SECRET), false);
  assert.equal(verifyZaloWebhookSecret(SECRET, SECRET), true);
});

test("5 malformed JSON / invalid UTF-8 -> 400", async () => {
  assert.equal((await call(request("{\"event_name\":"))).status, 400);
  const badUtf8 = new Request("https://example.test/x", {
    method: "POST",
    headers: { "x-bot-api-secret-token": SECRET },
    body: new Uint8Array([0x7b, 0xff, 0x7d]),
  });
  const r = await call(badUtf8);
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "invalid_json");
});

test("6 unsupported event types are ACKed but not observed", async () => {
  for (const name of ["message.image.received", "message.sticker.received", "message.unsupported.received"]) {
    const r = await call(request(event({ event_name: name })));
    assert.equal(r.status, 200);
    assert.equal(r.body.observed, false);
    assert.equal(r.entries[0].result, "other_event");
  }
  const unknown = await call(request({ hello: "world" }));
  assert.equal(unknown.status, 200);
  assert.equal(unknown.entries[0].result, "unknown_event_shape");
  const arr = await call(request([1, 2]));
  assert.equal(arr.entries[0].result, "unknown_event_shape");
});

test("7 PRIVATE message is not_group and never logs the chat id", async () => {
  const r = await call(request(event({ chat_type: "PRIVATE", chat_id: SENDER_ID })), {
    ZALO_BOT_WEBHOOK_SECRET: SECRET,
    ZALO_BOT_WEBHOOK_POC_SHOW_GROUP_ID: "true",
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.observed, false);
  assert.equal(r.entries[0].result, "not_group");
  assert.equal(r.entries[0].group_fp, null);
  assertNoSensitive(r.logs);
});

test("8b unexpected chat_type value is reported as UNKNOWN with the raw enum only", async () => {
  const r = await call(request(event({ chat_type: "GROUP_CHAT" })));
  assert.equal(r.entries[0].result, "not_group");
  assert.equal(r.entries[0].chat_type, "UNKNOWN");
  assert.equal(r.entries[0].chat_type_raw, "GROUP_CHAT");
});

test("bot's own messages are ignored", async () => {
  const r = await call(request(event({ is_bot: true })));
  assert.equal(r.entries[0].result, "bot_message");
  assert.equal(r.body.observed, false);
});

test("9 allowlist: other group ignored, listed group observed, group id shown only with toggle", async () => {
  const other = await call(request(event()), { ZALO_BOT_WEBHOOK_SECRET: SECRET, ZALO_BOT_WEBHOOK_POC_ALLOWED_GROUP_IDS: "grp-other" });
  assert.equal(other.entries[0].result, "other_group");
  assert.equal(other.body.observed, false);
  assert.equal(other.entries[0].allowlist, "set");

  const listed = await call(request(event()), { ZALO_BOT_WEBHOOK_SECRET: SECRET, ZALO_BOT_WEBHOOK_POC_ALLOWED_GROUP_IDS: ` grp-other , ${GROUP_ID} ` });
  assert.equal(listed.entries[0].result, "group_text_received");

  const shown = await call(request(event()), { ZALO_BOT_WEBHOOK_SECRET: SECRET, ZALO_BOT_WEBHOOK_POC_SHOW_GROUP_ID: "true" });
  assert.equal(shown.entries[0].group_id, GROUP_ID);
  assert.deepEqual(parseAllowedGroupIds(" a, ,b "), ["a", "b"]);
});

test("10 mention: no documented field -> still observed, mention_field=false; unexpected field is flagged by key name only", async () => {
  const none = await call(request(event()));
  assert.equal(none.entries[0].result, "group_text_received");
  assert.equal(none.entries[0].mention_field, false);
  assert.deepEqual(none.entries[0].message_keys, ["chat", "date", "from", "message_id", "message_type", "text"]);

  const secretMention = "MENTION_VALUE_SHOULD_NOT_LOG";
  const odd = await call(request(event({ extra: { mentions: [{ uid: secretMention }], "bad key!": 1 } })));
  assert.equal(odd.entries[0].result, "group_text_received");
  assert.equal(odd.entries[0].mention_field, true);
  assert.ok((odd.entries[0].message_keys as string[]).includes("mentions"));
  assert.ok(!odd.logs.join("").includes(secretMention));
  assert.ok(!odd.logs.join("").includes("bad key!"));

  const noText = parseZaloObservation({ event_name: "message.text.received", message: { message_id: "m", chat: { id: "g", chat_type: "GROUP" } } })!;
  assert.equal(classifyZaloObservation(noText), "invalid_group_text");
});

test("11 oversized body -> 413 (declared length and streamed length)", async () => {
  const big = JSON.stringify({ event_name: "x", pad: "a".repeat(MAX_BODY_BYTES) });
  const declared = await call(request(big, { "x-bot-api-secret-token": SECRET, "content-length": String(big.length) }));
  assert.equal(declared.status, 413);

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < 5; i += 1) controller.enqueue(new Uint8Array(20 * 1024).fill(0x20));
      controller.close();
    },
  });
  const streamed = new Request("https://example.test/x", {
    method: "POST",
    headers: { "x-bot-api-secret-token": SECRET },
    body: stream,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  const r = await call(streamed);
  assert.equal(r.status, 413);
});

test("testWebhook-style probes: authenticated empty body -> 200; unauthenticated empty body -> 401", async () => {
  const empty = new Request("https://example.test/x", { method: "POST", headers: { "x-bot-api-secret-token": SECRET } });
  const r = await call(empty);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, observed: false });
  assert.equal(r.entries[0].result, "empty_body");

  const zeroBytes = await call(request(""));
  assert.equal(zeroBytes.status, 200);
  assert.equal(zeroBytes.entries[0].result, "empty_body");

  const noAuth = await call(new Request("https://example.test/x", { method: "POST" }));
  assert.equal(noAuth.status, 401);
  assert.equal(noAuth.entries[0].reason, "missing");
});

test("allowlist accepts the logged group fingerprint instead of the raw id", async () => {
  const fp = fingerprint(GROUP_ID)!;
  const byFp = await call(request(event()), { ZALO_BOT_WEBHOOK_SECRET: SECRET, ZALO_BOT_WEBHOOK_POC_ALLOWED_GROUP_IDS: fp });
  assert.equal(byFp.entries[0].result, "group_text_received");
  const otherFp = await call(request(event({ chat_id: "grp-test-9999" })), { ZALO_BOT_WEBHOOK_SECRET: SECRET, ZALO_BOT_WEBHOOK_POC_ALLOWED_GROUP_IDS: fp });
  assert.equal(otherFp.entries[0].result, "other_group");
  assertNoSensitive(byFp.logs);
});

test("request id and user-agent family are logged; unsafe header values are dropped", async () => {
  const vercelId = "sin1::iad1::abcd1-1794551160000-0123abcdef";
  const ok = await call(request(event(), { "x-bot-api-secret-token": SECRET, "x-vercel-id": vercelId, "user-agent": "Java/17.0.2" }));
  assert.equal(ok.entries[0].request_id, vercelId);
  assert.equal(ok.entries[0].ua, "java");
  const bad = await call(request(event(), { "x-bot-api-secret-token": SECRET, "x-vercel-id": "x\"} injected", "user-agent": "Mozilla/5.0 secret-ua" }));
  assert.equal(bad.entries[0].request_id, null);
  assert.equal(bad.entries[0].ua, "other");
  assert.ok(!bad.logs.join("").includes("secret-ua"));
});

test("12 module performs no DB / network / reply calls", () => {
  const source = readFileSync("lib/zalo/webhook-poc.ts", "utf8");
  const route = readFileSync("app/api/integrations/zalo-bot/route.ts", "utf8");
  for (const text of [source, route]) {
    assert.doesNotMatch(text, /supabase|fetch\(|bot-api\.zaloplatforms|sendMessage|BOT_TOKEN/i);
  }
  assert.match(route, /export async function POST/);
  assert.doesNotMatch(route, /export async function (GET|PUT|DELETE|PATCH)/);
});
