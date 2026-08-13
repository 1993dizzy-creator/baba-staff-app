import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const source = readFileSync(
  join(process.cwd(), "lib/inventory/keg-replacement-summary.ts"),
  "utf8"
);

test("basic Keg summaries use one closed-session read without POS breakdown", () => {
  const basic = source.slice(
    source.indexOf("export async function fetchPreviousKegSessionSummariesByLogId"),
    source.length
  );
  assert.match(basic, /fetchClosedKegSessionsByLogId\(supabase, logIds\)/);
  assert.match(basic, /buildPreviousKegSessionSummary\(row\)/);
  assert.doesNotMatch(basic, /computeKegSalesBreakdown|pos_sales_receipts|pos_sales_receipt_lines/);
});

test("base summary formulas remain shared by lightweight and full paths", () => {
  const builder = source.slice(
    source.indexOf("const buildPreviousKegSessionSummary"),
    source.indexOf("type KegTrackingMappingRow")
  );
  assert.match(builder, /loss_quantity === null[\s\S]*?Math\.max\(capacityMl - soldMl, 0\)/);
  assert.match(builder, /overageMl: Math\.max\(soldMl - capacityMl, 0\)/);
  assert.match(builder, /usagePercent: capacityMl > 0 \? roundDecimal\(\(soldMl \/ capacityMl\) \* 100\) : 0/);
  assert.match(builder, /lossPercent: capacityMl > 0 \? roundDecimal\(\(lossMl \/ capacityMl\) \* 100\) : 0/);
  assert.match(source, /const summary = buildPreviousKegSessionSummary\(row\);[\s\S]*?computeKegSalesBreakdown/);
});

test("full summary still uses the existing POS breakdown and mismatch formula", () => {
  const full = source.slice(
    source.indexOf("export async function fetchPreviousKegSummariesByLogId"),
    source.indexOf("export async function fetchPreviousKegSessionSummariesByLogId")
  );
  assert.match(full, /await computeKegSalesBreakdown\(supabase/);
  assert.match(full, /roundDecimal\(Number\(breakdown\.expectedTotalMl \?\? 0\)\) !==\s*roundDecimal\(summary\.soldMl\)/);
  assert.match(full, /salesBreakdown,\s*salesBreakdownMismatch/);
});

test("empty Keg log sets still skip the closed-session query", () => {
  assert.match(source, /if \(safeLogIds\.length === 0\) return \[\];/);
});
