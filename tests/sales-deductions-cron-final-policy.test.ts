import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const shared = read("lib/sales/sales-deduction-cron-shared.ts");
const normal = read("app/api/cron/sales-deductions/route.ts");
const final = read("app/api/cron/sales-deductions-final/route.ts");

test("normal and final deduction crons share one core loop, not duplicated ones", () => {
  for (const route of [normal, final]) {
    assert.match(route, /from "@\/lib\/sales\/sales-deduction-cron-shared"/);
    assert.match(route, /authorizeCron\(req\)/);
    assert.match(route, /getCronActor\(\)/);
    assert.match(route, /runSalesDeductionCron\(/);
    assert.doesNotMatch(route, /function applyReceiptDeduction/);
    assert.doesNotMatch(route, /function getDeductionCandidateReceiptIds/);
  }
  assert.match(shared, /export async function runSalesDeductionCron/);
  assert.match(shared, /export async function getCronActor/);
});

test("the normal cron uses the current business date", () => {
  assert.match(normal, /const businessDate = getBusinessDate\(\);/);
});

test("the final cron resolves and uses the previous business date, not the current one", () => {
  assert.match(final, /loadBusinessTimeAdapter\(new Date\(\)\)/);
  assert.match(final, /addStoreDays\(adapter\.databaseBusinessDate, -1\)/);
  assert.match(final, /businessDate: resolved\.targetBusinessDate/);
  assert.doesNotMatch(final, /businessDate: resolved\.currentBusinessDate/);
});

test("the final cron falls back to the legacy business date calculation if the settings lookup throws", () => {
  assert.match(final, /catch \(error\) \{/);
  assert.match(final, /getBusinessDate\(\)/);
  assert.match(final, /SALES_DEDUCTIONS_FINAL_STORE_SETTING_LOOKUP_FAILED/);
});

test("the final cron logs its resolved target before running the shared deduction loop", () => {
  assert.match(final, /SALES_DEDUCTIONS_FINAL_TARGET/);
  assert.match(final, /revision: resolved\.revision/);
  assert.match(final, /isFallback: resolved\.isFallback/);
});

test("candidate selection stays receipt-flag driven, not business-date driven, in the shared loop", () => {
  assert.match(shared, /inventory_deduction_auto_eligible_at/);
  assert.match(shared, /inventory_deduction_processing_paused/);
  assert.doesNotMatch(shared, /\.eq\("business_date"/);
});

test("deduction policy itself is untouched: reprocess, rollback, and duplicate-apply protections stay in place", () => {
  assert.match(shared, /buildUnifiedInventoryDeductionPreview/);
  assert.match(shared, /executeUnifiedInventoryDeductions/);
  assert.match(shared, /already_processed/);
  assert.match(shared, /needs_check/);
  assert.match(shared, /stale_preview/);
});
