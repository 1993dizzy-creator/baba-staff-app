import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const sql = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/202607130001_complete_sales_receipt_inventory_deduction_lifecycle.sql"
  ),
  "utf8"
);

test("cancellation rollback function is security-definer with a fixed search path", () => {
  assert.match(
    sql,
    /rollback_canceled_sales_inventory_deduction_receipt[\s\S]*security definer[\s\S]*set search_path = public/i
  );
  assert.match(sql, /revoke all on function[\s\S]*from public/i);
  assert.match(sql, /grant execute on function[\s\S]*to service_role/i);
});

test("rollback restores exact ledger quantity and writes a positive inventory log", () => {
  assert.match(
    sql,
    /v_new_quantity := v_previous_quantity \+ v_active\.deduct_quantity_total/i
  );
  assert.match(
    sql,
    /change_quantity[\s\S]*v_active\.deduct_quantity_total/i
  );
  assert.match(sql, /reversal_of_deduction_id/i);
  assert.match(sql, /rollback_canceled:%s:%s:revert:%s/i);
});

test("workflow constraint and historical eligibility guard are present", () => {
  assert.match(sql, /workflow_type in \([\s\S]*'rollback_canceled'/i);
  assert.match(
    sql,
    /inventory_deduction_auto_eligible_at timestamptz null/i
  );
  assert.doesNotMatch(
    sql,
    /update\s+public\.pos_sales_receipts\s+set\s+inventory_deduction_auto_eligible_at/i
  );
});
