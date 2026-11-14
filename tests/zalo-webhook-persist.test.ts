// Persist mode of the Zalo webhook (reservation Phase 1) with an in-memory persist fake.
// The real SQL path is covered by tests/reservation-inbox-db.test.mjs.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  ZaloInboxPersistError,
  buildZaloInboxPlan,
  fingerprint,
  handleZaloWebhook,
  parseZaloMessageDate,
  type ZaloInboxEntry,
  type ZaloInboxPersistResult,
  type ZaloWebhookEnv,
} from "../lib/zalo/webhook-poc.ts";
import { createZaloInboxPersist } from "../lib/reservations/zalo-inbox-store.ts";

// Test-only placeholders; not real credentials or customer data.
const SECRET = "test-webhook-secret-0123456789";
const GROUP_ID = "grp-test-0001";
const OTHER_GROUP = "grp-test-9999";
const SENDER_ID = "sender-test-0001";
const SENDER_NAME = "Khach Test Name";
const TEXT = "@Bot đặt BABA TEST BABA 007 0901234567";
const ENV: ZaloWebhookEnv = {
  ZALO_BOT_WEBHOOK_SECRET: SECRET,
  ZALO_BOT_WEBHOOK_MODE: "persist",
  ZALO_BOT_WEBHOOK_POC_ALLOWED_GROUP_IDS: fingerprint(GROUP_ID)!,
};

function event(o: { chat_type?: string; chat_id?: string; event_name?: string; is_bot?: boolean; message_id?: string; text?: unknown } = {}) {
  return {
    event_name: o.event_name ?? "message.text.received",
    message: {
      message_id: o.message_id ?? "msg-test-0001",
      date: 1794551160000,
      message_type: "CHAT_TEXT",
      from: { id: SENDER_ID, display_name: SENDER_NAME, is_bot: o.is_bot ?? false },
      chat: { id: o.chat_id ?? GROUP_ID, chat_type: o.chat_type ?? "GROUP" },
      ...(o.text === undefined ? { text: TEXT } : o.text === null ? {} : { text: o.text }),
    },
  };
}

const request = (body: string | object | Uint8Array, headers: Record<string, string> = { "x-bot-api-secret-token": SECRET }) =>
  new Request("https://example.test/api/integrations/zalo-bot", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: (typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body)) as BodyInit,
  });

function fakeStore(fail: (() => never) | null = null) {
  const rows = new Map<string, { id: number; entry: ZaloInboxEntry; deliveries: number }>();
  const calls: ZaloInboxEntry[] = [];
  const persist = async (entry: ZaloInboxEntry): Promise<ZaloInboxPersistResult> => {
    calls.push(entry);
    if (fail) fail();
    const key = entry.chat_id && entry.message_id ? `${entry.chat_id}\n${entry.message_id}` : `payload:${entry.payload_sha256}`;
    const hit = rows.get(key);
    if (hit) {
      hit.deliveries += 1;
      return { status: "duplicate", inboxId: hit.id, deliveryCount: hit.deliveries, payloadMismatch: hit.entry.payload_sha256 !== entry.payload_sha256 };
    }
    rows.set(key, { id: rows.size + 1, entry, deliveries: 1 });
    return { status: "stored", inboxId: rows.size, deliveryCount: 1, payloadMismatch: false };
  };
  return { rows, calls, persist };
}

async function call(req: Request, store = fakeStore(), env: ZaloWebhookEnv = ENV) {
  const logs: string[] = [];
  const res = await handleZaloWebhook(req, env, (tag, data) => logs.push(`${tag} ${data}`), store.persist);
  const body = (await res.json()) as Record<string, unknown>;
  const entries = logs.map((line) => JSON.parse(line.slice(line.indexOf(" ") + 1)) as Record<string, unknown>);
  return { status: res.status, body, logs, entries, store };
}

function assertNoSensitive(logs: string[]) {
  const all = logs.join("\n");
  for (const value of [SECRET, SENDER_ID, SENDER_NAME, TEXT, "0901234567", "TEST BABA", GROUP_ID, OTHER_GROUP]) {
    assert.ok(!all.includes(value), `log leaked ${value}`);
  }
}

test("allowlisted GROUP text is stored as 'received' before the 200 ACK", async () => {
  const r = await call(request(event()));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, observed: true, stored: true, duplicate: false });
  assert.equal(r.store.calls.length, 1);
  const entry = r.store.calls[0];
  assert.equal(entry.status, "received");
  assert.equal(entry.quarantine_reason, null);
  assert.equal(entry.chat_id, GROUP_ID);
  assert.equal(entry.message_text, TEXT);
  assert.equal(entry.sender_name, SENDER_NAME);
  assert.equal(entry.message_at, "2026-11-13T06:26:00.000Z");
  assert.ok("raw_payload" in entry && !("raw_body" in entry));
  const log = r.entries[0];
  assert.equal(log.mode, "persist");
  assert.equal(log.result, "group_text_received");
  assert.equal(log.stored, true);
  assert.equal(log.inbox_status, "received");
  assert.equal(log.group_fp, fingerprint(GROUP_ID));
  assertNoSensitive(r.logs);
});

test("redelivery of the same Zalo message is ACKed as duplicate and never stored twice", async () => {
  const store = fakeStore();
  const first = await call(request(event()), store);
  const again = await call(request(event()), store);
  const edited = await call(request(event({ text: "@Bot đặt BABA edited" })), store);
  assert.deepEqual([first.body.duplicate, again.body.duplicate, edited.body.duplicate], [false, true, true]);
  assert.equal(store.rows.size, 1);
  assert.equal(again.entries[0].delivery_count, 2);
  assert.equal(again.entries[0].payload_mismatch, false);
  assert.equal(edited.entries[0].payload_mismatch, true, "same message id, different payload is flagged");
  const other = await call(request(event({ message_id: "msg-test-0002" })), store);
  assert.equal(other.body.duplicate, false);
  assert.equal(store.rows.size, 2);
});

test("storage failure answers 503 (not ACKed) and logs only a safe error code", async () => {
  const store = fakeStore(() => { throw new ZaloInboxPersistError("pg_08006"); });
  const r = await call(request(event()), store);
  assert.equal(r.status, 503);
  assert.deepEqual(r.body, { ok: false, error: "persist_failed" });
  assert.equal(r.entries[0].result, "persist_failed");
  assert.equal(r.entries[0].error_code, "pg_08006");
  assert.equal(r.entries[0].message_fp, fingerprint("msg-test-0001"), "operators can match the lost message");
  assertNoSensitive(r.logs);
  const weird = await call(request(event()), fakeStore(() => { throw new Error(`boom ${TEXT}`); }));
  assert.equal(weird.status, 503);
  assert.equal(weird.entries[0].error_code, "unknown");
  assertNoSensitive(weird.logs);
  assert.equal(new ZaloInboxPersistError("bad code with spaces").code, "unknown");
});

test("a failed delivery that Zalo (or an operator) retries is stored exactly once", async () => {
  let down = true;
  const store = fakeStore();
  const flaky = { ...store, persist: async (e: ZaloInboxEntry) => { if (down) throw new ZaloInboxPersistError("pg_57P01"); return store.persist(e); } };
  assert.equal((await call(request(event()), flaky as typeof store)).status, 503);
  down = false;
  const retry = await call(request(event()), flaky as typeof store);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.duplicate, false);
  assert.equal((await call(request(event()), flaky as typeof store)).body.duplicate, true);
  assert.equal(store.rows.size, 1);
});

test("other groups are dropped for every event type and never reach storage", async () => {
  for (const e of [event({ chat_id: OTHER_GROUP }), event({ chat_id: OTHER_GROUP, event_name: "message.sticker.received" }),
    event({ chat_id: OTHER_GROUP, chat_type: "GROUP_CHAT" }), event({ chat_id: OTHER_GROUP, text: null })]) {
    const r = await call(request(e));
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, observed: false, stored: false });
    assert.equal(r.entries[0].result, "other_group");
    assert.equal(r.store.calls.length, 0);
    assertNoSensitive(r.logs);
  }
});

test("the bot's own messages are dropped", async () => {
  const r = await call(request(event({ is_bot: true })));
  assert.equal(r.entries[0].result, "bot_message");
  assert.equal(r.store.calls.length, 0);
});

test("malformed or unexpected authenticated deliveries are quarantined, not lost", async () => {
  const cases: Array<[string | object | Uint8Array, string]> = [
    ["{\"event_name\":", "invalid_json"],
    [new Uint8Array([0x7b, 0xff, 0x7d]), "invalid_json"],
    [{ hello: "world" }, "unknown_event_shape"],
    [[1, 2], "unknown_event_shape"],
    [event({ event_name: "message.image.received" }), "other_event"],
    [event({ text: null }), "invalid_group_text"],
    [event({ text: 42 }), "invalid_group_text"],
    [event({ chat_type: "PRIVATE", chat_id: SENDER_ID }), "not_group"],
    [event({ chat_type: "GROUP_CHAT" }), "not_group"],
  ];
  for (const [body, reason] of cases) {
    const r = await call(request(body));
    assert.equal(r.status, 200, reason);
    assert.equal(r.body.stored, true, reason);
    assert.equal(r.body.observed, false, reason);
    const entry = r.store.calls[0];
    assert.equal(entry.status, "quarantined", reason);
    assert.equal(entry.quarantine_reason, reason);
    assert.match(entry.payload_sha256, /^[0-9a-f]{64}$/);
    if (reason === "invalid_json") assert.ok("raw_body" in entry && typeof entry.raw_body === "string");
    else assert.ok("raw_payload" in entry);
    assertNoSensitive(r.logs);
  }
  const raw = "{\"event_name\":";
  const r = await call(request(raw));
  assert.equal(r.store.calls[0].payload_sha256, createHash("sha256").update(raw).digest("hex"), "hash of the exact bytes received");
});

test("persist mode is fail-closed without an allowlist or a persist adapter; auth and size limits unchanged", async () => {
  const noList = await call(request(event()), fakeStore(), { ...ENV, ZALO_BOT_WEBHOOK_POC_ALLOWED_GROUP_IDS: " , " });
  assert.equal(noList.status, 503);
  assert.equal(noList.entries[0].reason, "allowlist_unset");
  assert.equal(noList.store.calls.length, 0);
  const res = await handleZaloWebhook(request(event()), ENV, () => {});
  assert.equal(res.status, 503);
  assert.equal((await call(request(event(), {}))).status, 401);
  assert.equal((await call(request(event(), { "x-bot-api-secret-token": "wrong-secret-value" }))).status, 401);
  assert.equal((await call(request(event()), fakeStore(), { ...ENV, ZALO_BOT_WEBHOOK_SECRET: "short" })).status, 503);
  const big = JSON.stringify({ pad: "a".repeat(70 * 1024) });
  const tooBig = await call(request(big));
  assert.equal(tooBig.status, 413);
  assert.equal(tooBig.store.calls.length, 0);
  const empty = await call(new Request("https://example.test/x", { method: "POST", headers: { "x-bot-api-secret-token": SECRET } }));
  assert.deepEqual([empty.status, empty.store.calls.length], [200, 0]);
  // Raw group id works in the allowlist too.
  const byRaw = await call(request(event()), fakeStore(), { ...ENV, ZALO_BOT_WEBHOOK_POC_ALLOWED_GROUP_IDS: GROUP_ID });
  assert.equal(byRaw.body.stored, true);
});

test("message.date: epoch ms or seconds within 2020..2100, anything else unknown", () => {
  assert.equal(parseZaloMessageDate(1794551160000), "2026-11-13T06:26:00.000Z");
  assert.equal(parseZaloMessageDate(1794551160), "2026-11-13T06:26:00.000Z");
  assert.equal(parseZaloMessageDate("1794551160000"), "2026-11-13T06:26:00.000Z");
  for (const bad of [null, undefined, "", "2026-11-13", -1, 0, 1e18, 99, "12ab", Number.NaN]) assert.equal(parseZaloMessageDate(bad), null, String(bad));
});

test("reprocessing uses the same plan builder: a quarantined payload is re-judged by the current rules", () => {
  const sha = "f".repeat(64);
  assert.equal(buildZaloInboxPlan(event(), sha, [GROUP_ID]).action, "store");
  const plan = buildZaloInboxPlan(event(), sha, [fingerprint(GROUP_ID)!]);
  assert.equal(plan.action === "store" && plan.entry.status, "received");
  assert.equal(buildZaloInboxPlan(event(), sha, []).action, "drop", "empty allowlist drops in persist rules");
  assert.equal(buildZaloInboxPlan(event({ chat_id: OTHER_GROUP }), sha, [GROUP_ID]).classification, "other_group");
});

test("persist adapter maps RPC answers and hides DB error details", async () => {
  const client = (answer: { data: unknown; error: { code?: string; message?: string } | null } | Error) => async () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      assert.equal(fn, "reservation_inbox_ingest_v1");
      assert.ok(args.p_entry);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  });
  const plan = buildZaloInboxPlan(event(), "e".repeat(64), [GROUP_ID]);
  assert.equal(plan.action, "store");
  if (plan.action !== "store") return;
  const ok = await createZaloInboxPersist(client({ data: { status: "duplicate", inboxId: 7, deliveryCount: 3, payloadMismatch: false }, error: null }))(plan.entry);
  assert.deepEqual(ok, { status: "duplicate", inboxId: 7, deliveryCount: 3, payloadMismatch: false });
  const codeOf = async (answer: Parameters<typeof client>[0]) => {
    try { await createZaloInboxPersist(client(answer))(plan.entry); return "no-throw"; }
    catch (e) { assert.ok(e instanceof ZaloInboxPersistError); return (e as ZaloInboxPersistError).code; }
  };
  assert.equal(await codeOf({ data: null, error: { code: "42883", message: `function missing ${TEXT}` } }), "pg_42883");
  assert.equal(await codeOf({ data: null, error: { message: "x" } }), "rpc_error");
  assert.equal(await codeOf({ data: { status: "invalid_input" }, error: null }), "rpc_invalid_input");
  assert.equal(await codeOf({ data: { status: "stored", inboxId: "nope" }, error: null }), "rpc_bad_id");
  assert.equal(await codeOf(new Error("network down")), "rpc_unreachable");
  const failingClient = createZaloInboxPersist(async () => { throw new Error("Missing env"); });
  await assert.rejects(failingClient(plan.entry), (e: unknown) => e instanceof ZaloInboxPersistError && e.code === "client_unavailable");
});
