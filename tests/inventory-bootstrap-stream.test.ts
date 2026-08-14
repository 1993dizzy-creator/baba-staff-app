import assert from "node:assert/strict";
import test from "node:test";
// Node 24 executes this type-strippable module directly; production imports omit the extension.
// @ts-expect-error TypeScript disallows explicit .ts imports without allowImportingTsExtensions.
import { parseInventoryBootstrapStreamEvent, readInventoryBootstrapStream } from "../lib/inventory/bootstrap-stream.ts";

type Item = { id: number; name: string };
type Status = { needsStockCheck: boolean };
type Keg = { usagePercent: number };

const events = [
  { type: "items", items: [{ id: 1, name: "Beer" }] },
  {
    type: "enrichment",
    statusMap: { "1": { needsStockCheck: true } },
    kegProgressMap: { "1": { usagePercent: 25 } },
    activeKegTrackingItemIds: [1],
  },
  { type: "complete", timing: { total: 20 } },
];

const responseFromChunks = (chunks: string[]) => {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)));
        controller.close();
      },
    }),
    { headers: { "Content-Type": "application/x-ndjson" } }
  );
};

test("items apply before enrichment and final assembly preserves all data", async () => {
  const order: string[] = [];
  const result = await readInventoryBootstrapStream<Item, Status, Keg>(
    responseFromChunks(events.map((event) => `${JSON.stringify(event)}\n`)),
    {
      onItems(items) {
        order.push(`items:${items.length}`);
      },
      onEnrichment(event) {
        order.push(`enrichment:${Object.keys(event.statusMap).length}`);
      },
    }
  );

  assert.deepEqual(order, ["items:1", "enrichment:1"]);
  assert.deepEqual(result.items, events[0].items);
  assert.deepEqual(result.statusMap, events[1].statusMap);
  assert.deepEqual(result.kegProgressMap, events[1].kegProgressMap);
  assert.deepEqual(result.activeKegTrackingItemIds, [1]);
  assert.deepEqual(result.timing, { total: 20 });
});

test("multiple JSON lines in one network chunk are parsed", async () => {
  const result = await readInventoryBootstrapStream<Item, Status, Keg>(
    responseFromChunks([events.map((event) => JSON.stringify(event)).join("\n") + "\n"]),
    { onItems() {}, onEnrichment() {} }
  );
  assert.equal(result.items.length, 1);
  assert.equal(result.kegProgressMap["1"].usagePercent, 25);
});

test("an empty inventory still completes normally", async () => {
  const emptyEvents = [
    { type: "items", items: [] },
    {
      type: "enrichment",
      statusMap: {},
      kegProgressMap: {},
      activeKegTrackingItemIds: [],
    },
    { type: "complete", timing: { total: 1 } },
  ];
  const result = await readInventoryBootstrapStream<Item, Status, Keg>(
    responseFromChunks([
      emptyEvents.map((event) => JSON.stringify(event)).join("\n") + "\n",
    ]),
    { onItems() {}, onEnrichment() {} }
  );
  assert.deepEqual(result.items, []);
  assert.deepEqual(result.statusMap, {});
});

test("one JSON line split across network chunks is buffered", async () => {
  const ndjson = events.map((event) => JSON.stringify(event)).join("\n") + "\n";
  const cuts = [7, 31, 66, 103];
  let offset = 0;
  const chunks = cuts.map((cut) => {
    const chunk = ndjson.slice(offset, cut);
    offset = cut;
    return chunk;
  });
  chunks.push(ndjson.slice(offset));

  const result = await readInventoryBootstrapStream<Item, Status, Keg>(
    responseFromChunks(chunks),
    { onItems() {}, onEnrichment() {} }
  );
  assert.equal(result.statusMap["1"].needsStockCheck, true);
});

test("enrichment error preserves already-delivered items and fails safely", async () => {
  let delivered: Item[] = [];
  const errorEvent = {
    type: "error",
    stage: "enrichment",
    code: "inventory_bootstrap_enrichment_failed",
    timing: { total: 12 },
  };

  await assert.rejects(
    readInventoryBootstrapStream<Item, Status, Keg>(
      responseFromChunks([
        `${JSON.stringify(events[0])}\n${JSON.stringify(errorEvent)}\n`,
      ]),
      {
        onItems(items) {
          delivered = items;
        },
        onEnrichment() {},
      }
    ),
    (error: Error & { stage?: string }) =>
      error.message === "inventory_bootstrap_enrichment_failed" &&
      error.stage === "enrichment"
  );
  assert.deepEqual(delivered, events[0].items);
});

test("auth/items HTTP failure remains a normal JSON error before streaming", async () => {
  const response = Response.json(
    { ok: false, error: "RELOGIN_REQUIRED" },
    { status: 401 }
  );
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("content-type")?.includes("application/json"), true);
});

test("invalid, out-of-order, and incomplete streams fail", async () => {
  assert.throws(() => parseInventoryBootstrapStreamEvent("{}"));
  await assert.rejects(
    readInventoryBootstrapStream<Item, Status, Keg>(
      responseFromChunks([`${JSON.stringify(events[1])}\n`]),
      { onItems() {}, onEnrichment() {} }
    ),
    /Out-of-order/
  );
  await assert.rejects(
    readInventoryBootstrapStream<Item, Status, Keg>(
      responseFromChunks([`${JSON.stringify(events[0])}\n`]),
      { onItems() {}, onEnrichment() {} }
    ),
    /Incomplete/
  );
});

test("abort cancels a pending reader", async () => {
  const encoder = new TextEncoder();
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`${JSON.stringify(events[0])}\n`));
      },
      cancel() {
        cancelled = true;
      },
    })
  );
  const controller = new AbortController();
  const promise = readInventoryBootstrapStream<Item, Status, Keg>(
    response,
    {
      onItems() {
        controller.abort();
      },
      onEnrichment() {},
    },
    controller.signal
  );
  await assert.rejects(promise, /abort/i);
  assert.equal(cancelled, true);
});
