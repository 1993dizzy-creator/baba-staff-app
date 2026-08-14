import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const jsonRoute = read("app/api/inventory/bootstrap/route.ts");
const streamRoute = read("app/api/inventory/bootstrap-stream/route.ts");
const page = read("app/(protected)/inventory/page.tsx");
const helper = read("lib/inventory/bootstrap-server.ts");
const parser = read("lib/inventory/bootstrap-stream.ts");
const itemsRoute = read("app/api/inventory/items/route.ts");
const statusRoute = read("app/api/inventory/items/status/route.ts");
const kegRoute = read("app/api/inventory/keg-progress/route.ts");

test("JSON bootstrap remains compatible while the page uses a dedicated stream", () => {
  assert.match(jsonRoute, /buildInventoryBootstrapResponse/);
  assert.match(jsonRoute, /NextResponse\.json/);
  assert.match(page, /\/api\/inventory\/bootstrap-stream/);
  assert.doesNotMatch(page, /\/api\/inventory\/bootstrap\?/);
  assert.match(streamRoute, /application\/x-ndjson/);
  assert.match(streamRoute, /export const runtime = "nodejs"/);
});

test("both bootstrap routes authenticate once and never call APIs over HTTP", () => {
  for (const route of [jsonRoute, streamRoute]) {
    assert.equal((route.match(/getAuthenticatedActor\(\)/g) || []).length, 1);
    assert.doesNotMatch(route, /fetch\s*\(/);
  }
  assert.match(helper, /fetchInventoryItems\(/);
  assert.match(helper, /fetchInventoryStatusByItemId\(/);
  assert.match(helper, /fetchKegProgressByItemId\(/);
});

test("auth and item failures happen before the streaming response starts", () => {
  const handler = streamRoute.slice(streamRoute.indexOf("export async function GET"));
  const authFailureIndex = handler.indexOf("if (!auth.ok)");
  const baseIndex = handler.indexOf("await fetchInventoryBootstrapBase");
  const streamIndex = handler.indexOf("new ReadableStream");
  assert.ok(authFailureIndex >= 0 && authFailureIndex < baseIndex);
  assert.ok(baseIndex < streamIndex);
  assert.match(handler, /catch \(error\)[\s\S]*inventory_bootstrap_load_failed/);
});

test("items are enqueued before enrichment starts", () => {
  const enqueueIndex = streamRoute.indexOf(
    'controller.enqueue(encodeEvent({ type: "items"'
  );
  const enrichmentIndex = streamRoute.indexOf(
    "void fetchInventoryBootstrapEnrichment"
  );
  assert.ok(enqueueIndex >= 0 && enqueueIndex < enrichmentIndex);
  assert.match(streamRoute, /type: "items", items: initialItems/);
});

test("inventory and mapping stay single-read shared dependencies", () => {
  assert.equal((helper.match(/fetchInventoryItems\(/g) || []).length, 1);
  assert.equal(
    (helper.match(/fetchActiveKegTrackingMappings\(/g) || []).length,
    1
  );
  assert.match(helper, /preloadedMappings: activeMappings/);
  assert.match(helper, /Promise\.all\(\[statusPromise, mappingPromise, kegPromise\]\)/);
});

test("stream protocol emits items, enrichment, complete, and safe errors", () => {
  assert.match(streamRoute, /type: "items"/);
  assert.match(streamRoute, /type: "enrichment"/);
  assert.match(streamRoute, /type: "complete"/);
  assert.match(streamRoute, /type: "error"/);
  assert.match(streamRoute, /stage: "enrichment"/);
  assert.match(streamRoute, /inventory_bootstrap_enrichment_failed/);
  assert.doesNotMatch(streamRoute, /message: error/);
});

test("the stream parser buffers split lines and rejects incomplete streams", () => {
  assert.match(parser, /buffer \+= decoder\.decode/);
  assert.match(parser, /const lines = buffer\.split\("\\n"\)/);
  assert.match(parser, /lines\.forEach\(consumeLine\)/);
  assert.match(parser, /Incomplete inventory bootstrap stream/);
  assert.match(parser, /Out-of-order inventory enrichment stream event/);
});

test("abort and Strict Mode dedupe guards remain active", () => {
  assert.match(page, /inventoryAbortControllerRef/);
  assert.match(page, /controller\.signal/);
  assert.match(page, /inventoryUnmountAbortTimerRef/);
  assert.match(page, /runDedupeRequest/);
  assert.match(page, /bootstrap-stream:includeInactive=/);
  assert.match(parser, /reader\.cancel/);
  assert.match(parser, /signal\?\.throwIfAborted/);
});

test("the initial page still starts exactly stream, recent, and snapshot", () => {
  const initialEffectMatch = page.match(
    /useEffect\(\(\) => \{[\s\S]*?void Promise\.all\(\[[\s\S]*?\}\, \[\]\);/
  );
  const initialEffect = initialEffectMatch?.[0] || "";
  assert.match(initialEffect, /fetchInventory/);
  assert.match(initialEffect, /fetchRecentLogs/);
  assert.match(initialEffect, /fetchLatestSnapshot/);
  assert.doesNotMatch(page, /\/api\/inventory\/items\/status/);
  assert.doesNotMatch(page, /\/api\/inventory\/keg-progress/);
});

test("existing endpoint contracts remain available", () => {
  assert.match(itemsRoute, /export async function GET/);
  assert.match(statusRoute, /export async function POST/);
  assert.match(kegRoute, /export async function GET/);
});

test("stream timing puts only known first-chunk values in headers", () => {
  assert.match(streamRoute, /timing\.header\(\["auth", "items", "first_chunk"\]\)/);
  assert.match(streamRoute, /type: "complete", timing: timing\.snapshot\(\)/);
  assert.doesNotMatch(streamRoute, /Server-Timing[^\n]+status/);
});
