import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

const salesTime = read("lib/sales/admin-sales-business-time.ts");
const adapter = read("lib/store-settings/business-time-adapter.ts");
const todayApi = read("app/api/admin/sales/today/route.ts");
const monthlyApi = read("app/api/admin/sales/monthly/route.ts");
const receiptsApi = read("app/api/admin/sales/receipts/route.ts");

// Isolate resolveConfiguredBusinessDate's own body (up to the next export)
// so assertions about which RPCs it calls can't accidentally match
// loadBusinessTimeAdapter's body further down the same file.
function extractFunctionBody(source: string, signature: string) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `expected to find "${signature}"`);
  const nextExport = source.indexOf("\nexport ", start + signature.length);
  return source.slice(start, nextExport === -1 ? source.length : nextExport);
}

test("explicit businessDate never triggers a configured lookup of any kind", () => {
  assert.match(
    salesTime,
    /if \(explicit\) \{\s*return \{ businessDate: explicit, source: "explicit" \};\s*\}/
  );
  // The explicit branch returns before either resolveConfiguredBusinessDate
  // or getBusinessDate() is reachable.
  const explicitBranch = salesTime.slice(
    salesTime.indexOf("export async function resolveAdminSalesBusinessDate"),
    salesTime.indexOf("try {")
  );
  assert.doesNotMatch(explicitBranch, /resolveConfiguredBusinessDate/);
});

test("automatic businessDate resolution calls the date-only configured resolver, not the full adapter", () => {
  assert.match(salesTime, /resolveConfiguredBusinessDate\(new Date\(\)\)/);
  // Not imported and never called — a bare-word check would also flag this
  // file's own explanatory comments about why loadBusinessTimeAdapter is no
  // longer used, so check the import list and call sites specifically.
  const importBlock = salesTime.slice(0, salesTime.indexOf("export type ResolvedBusinessDate"));
  assert.doesNotMatch(importBlock, /loadBusinessTimeAdapter/);
  assert.doesNotMatch(salesTime, /loadBusinessTimeAdapter\(/);
});

test("resolveConfiguredBusinessDate calls store_business_date_for_timestamp_v1 only, never the overview RPC", () => {
  const body = extractFunctionBody(
    adapter,
    "export async function resolveConfiguredBusinessDate(timestamp: Date | string) {"
  );
  assert.match(body, /store_business_date_for_timestamp_v1/);
  assert.doesNotMatch(body, /store_get_settings_overview_v1/);
  // Same ISO handling and invalid-timestamp guard as the full adapter.
  assert.match(body, /value\.toISOString\(\)/);
  assert.match(body, /Invalid business-time timestamp/);
  // Returns the RPC's raw value directly — no post-processing that could
  // diverge from what loadBusinessTimeAdapter exposes as databaseBusinessDate.
  assert.match(body, /return databaseBusinessDate;/);
});

test("loadBusinessTimeAdapter is untouched: still calls both RPCs and still derives databaseBusinessDate from the date RPC alone", () => {
  const body = extractFunctionBody(
    adapter,
    "export async function loadBusinessTimeAdapter(timestamp: Date | string) {"
  );
  assert.match(body, /store_business_date_for_timestamp_v1/);
  assert.match(body, /store_get_settings_overview_v1/);
  // databaseBusinessDate is assigned from the date RPC's response and
  // returned unchanged — the overview RPC only feeds snapshot/context.
  assert.match(
    body,
    /const \{ data: databaseBusinessDate, error: dateError \} = await supabaseServer\.rpc\(\s*"store_business_date_for_timestamp_v1"/
  );
  assert.match(body, /databaseBusinessDate,\s*\n\s*\};/);
});

test("loadBusinessTimeSnapshotsForDates (used by resolveAdminSalesCutoffHour) is untouched", () => {
  const body = extractFunctionBody(
    adapter,
    "export async function loadBusinessTimeSnapshotsForDates(businessDates: string[]) {"
  );
  assert.match(body, /store_get_settings_overview_v1/);
});

test("a date-RPC failure still falls back to getBusinessDate() with source error_fallback, unchanged", () => {
  const fn = salesTime.slice(
    salesTime.indexOf("export async function resolveAdminSalesBusinessDate")
  );
  assert.match(fn, /catch \(error\) \{\s*logLookupFailed\(error\);\s*return \{ businessDate: getBusinessDate\(\), source: "error_fallback" \};/);
});

test("today/monthly/receipts still resolve their default date through the same shared helper, exactly once per request", () => {
  assert.match(todayApi, /resolveAdminSalesBusinessDate\(/);
  assert.match(receiptsApi, /resolveAdminSalesBusinessDate\(/);
  assert.match(monthlyApi, /resolveAdminSalesMonth\(/);
  assert.equal((todayApi.match(/resolveAdminSalesBusinessDate\(/g) ?? []).length, 1);
  assert.equal((receiptsApi.match(/resolveAdminSalesBusinessDate\(/g) ?? []).length, 1);
  assert.equal((monthlyApi.match(/resolveAdminSalesMonth\(/g) ?? []).length, 1);
});

test("resolveAdminSalesCutoffHour keeps sourcing cutoff/revision data from the overview RPC via loadBusinessTimeSnapshotsForDates, unaffected by this change", () => {
  const fn = salesTime.slice(
    salesTime.indexOf("export async function resolveAdminSalesCutoffHour")
  );
  assert.match(fn, /loadBusinessTimeSnapshotsForDates\(\[businessDate\]\)/);
});
