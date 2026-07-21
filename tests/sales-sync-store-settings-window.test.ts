import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const route = readFileSync(
  join(process.cwd(), "app/api/pos/cukcuk/sainvoices/sync-to-sales/route.ts"),
  "utf8"
);

test("resolveSyncWindow uses an explicit businessDate when provided (configured path)", () => {
  assert.match(route, /if \(requestedBusinessDate\) \{/);
  assert.match(route, /loadBusinessTimeSnapshotsForDates\(\[requestedBusinessDate\]\)/);
  assert.match(route, /businessDate: requestedBusinessDate,/);
  assert.match(route, /settingSource: "configured",/);
});

test("resolveSyncWindow resolves the current business date via the adapter when none is provided", () => {
  assert.match(route, /const adapter = await loadBusinessTimeAdapter\(new Date\(\)\);/);
  assert.match(route, /businessDate: adapter\.databaseBusinessDate,/);
});

test("a settings RPC exception falls back to the legacy fixed calculation, not a thrown error", () => {
  assert.match(route, /catch \(error\) \{\s*console\.error\(\s*"\[SALES_SYNC_STORE_SETTING_LOOKUP_FAILED\]"/);
  assert.match(route, /const businessDate = requestedBusinessDate \|\| getBusinessDate\(\);/);
  assert.match(route, /const legacyWindow = getBusinessWindowByBusinessDate\(businessDate\);/);
  assert.match(route, /settingSource: "error_fallback",/);
});

test("mismatch is only logged when legacy and configured windows actually differ, never on the error-fallback path", () => {
  assert.match(route, /if \(resolvedWindow\.settingSource === "configured"\) \{/);
  assert.match(
    route,
    /if \(legacyFromDate !== filterFromDate \|\| legacyToDate !== filterToDate\) \{/
  );
  assert.match(route, /console\.warn\(\s*"\[SALES_SYNC_STORE_SETTINGS_MISMATCH\]"/);
});

test("mismatch log carries only businessDate/window/revision/fallback fields, no secrets", () => {
  const logCallMatch = route.match(
    /console\.warn\(\s*"\[SALES_SYNC_STORE_SETTINGS_MISMATCH\]",\s*JSON\.stringify\(\{([^}]*)\}\)/
  );
  assert.ok(logCallMatch, "mismatch log call not found");
  const fields = logCallMatch![1];
  assert.match(fields, /businessDate,/);
  assert.match(fields, /legacyCollectionFrom:/);
  assert.match(fields, /configuredCollectionFrom:/);
  assert.match(fields, /legacyCollectionTo:/);
  assert.match(fields, /configuredCollectionTo:/);
  assert.match(fields, /revision: resolvedWindow\.revision,/);
  assert.match(fields, /isFallback: resolvedWindow\.isFallback,/);
  assert.doesNotMatch(fields, /accessToken|secretKey|posAdminSecret/i);
});

test("the settings snapshot is fetched once per sync run and reused, never per receipt", () => {
  // resolveSyncWindow is called exactly once per POST, before the invoice
  // list/detail loops, and its result (filterFromDate/filterToDate/businessDate)
  // is reused for the CUKCUK query, filtering, and every saved row — not
  // recomputed inside any per-invoice mapping.
  const resolveCalls = route.match(/await resolveSyncWindow\(/g) ?? [];
  assert.equal(resolveCalls.length, 1);
  assert.doesNotMatch(route, /detailPayloads\.map\([^]*?resolveSyncWindow/);
  assert.doesNotMatch(route, /validDetails\.map\([^]*?resolveSyncWindow/);
});
