import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

function source(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

test("cron selects explicit eligibility across business dates", () => {
  const cron = source("app/api/cron/sales-deductions/route.ts");
  assert.match(
    cron,
    /not\("inventory_deduction_auto_eligible_at", "is", null\)/
  );
  assert.doesNotMatch(cron, /\.eq\("business_date", businessDate\)/);
  assert.match(cron, /\.limit\(200\)/);
});

test("not-ready candidates retain eligibility and are retry-throttled", () => {
  const cron = source("app/api/cron/sales-deductions/route.ts");
  assert.match(cron, /inventory_deduction_last_checked_at/);
  assert.match(cron, /terminal: receiptPreview\.operationType === "no_op"/);
  assert.match(cron, /Date\.now\(\) - 15 \* 60 \* 1000/);
});

test("admin edit errors release pause and interrupted leases are recovered", () => {
  const edit = source("app/api/admin/sales/receipts/[id]/route.ts");
  const cron = source("app/api/cron/sales-deductions/route.ts");
  assert.match(edit, /inventory_deduction_processing_paused: false/);
  assert.match(edit, /inventory_deduction_processing_error: "admin_edit_failed"/);
  assert.match(cron, /recoverStaleReceiptEditPauses/);
  assert.match(cron, /inventory_deduction_processing_error: "stale_admin_edit"/);
});

test("authoritative POS detail IDs allow deleted applied lines to be excluded", () => {
  const sync = source("lib/pos/cukcuk/sales-receipt-sync.ts");
  assert.match(sync, /hasAuthoritativeDetailIds/);
  assert.match(sync, /deduction_linked_without_authoritative_ids/);
  assert.doesNotMatch(sync, /return "deduction_linked";/);
});
