import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

function source(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

// The candidate-selection and deduction loop used to live directly in
// app/api/cron/sales-deductions/route.ts. It now lives in the shared module
// so /api/cron/sales-deductions (current business date) and
// /api/cron/sales-deductions-final (previous business date) can reuse the
// same implementation instead of duplicating it.
test("cron selects explicit eligibility across business dates", () => {
  const shared = source("lib/sales/sales-deduction-cron-shared.ts");
  assert.match(
    shared,
    /not\("inventory_deduction_auto_eligible_at", "is", null\)/
  );
  assert.doesNotMatch(shared, /\.eq\("business_date", businessDate\)/);
  assert.match(shared, /\.limit\(200\)/);
});

test("not-ready candidates retain eligibility and are retry-throttled", () => {
  const shared = source("lib/sales/sales-deduction-cron-shared.ts");
  assert.match(shared, /inventory_deduction_last_checked_at/);
  assert.match(shared, /terminal: receiptPreview\.operationType === "no_op"/);
  assert.match(shared, /Date\.now\(\) - 15 \* 60 \* 1000/);
});

test("admin edit errors release pause and interrupted leases are recovered", () => {
  const edit = source("app/api/admin/sales/receipts/[id]/route.ts");
  const shared = source("lib/sales/sales-deduction-cron-shared.ts");
  assert.match(edit, /inventory_deduction_processing_paused: false/);
  assert.match(edit, /inventory_deduction_processing_error: "admin_edit_failed"/);
  assert.match(shared, /recoverStaleReceiptEditPauses/);
  assert.match(shared, /inventory_deduction_processing_error: "stale_admin_edit"/);
});

test("authoritative POS detail IDs allow deleted applied lines to be excluded", () => {
  const sync = source("lib/pos/cukcuk/sales-receipt-sync.ts");
  assert.match(sync, /hasAuthoritativeDetailIds/);
  assert.match(sync, /deduction_linked_without_authoritative_ids/);
  assert.doesNotMatch(sync, /return "deduction_linked";/);
});
