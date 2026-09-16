import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = name => fs.readFileSync(`supabase/migrations/${name}`, "utf8");

test("owner investment history includes source metadata only on contribution transaction", () => {
  const sql = read("20260916171636_fix_owner_investment_source_metadata.sql");
  assert.match(sql, /source_type, source_snapshot, source_fingerprint, source_synced_at, memo/);
  assert.match(sql, /md5\(v_operation::text\), now\(\)/);
  assert.match(sql, /security definer/i);
  assert.match(sql, /revoke all on function public\.ledger_create_owner_investment_v1/);
});

test("both recurring sync versions skip inactive plans", () => {
  const sql = read("20260916172211_ignore_inactive_recurring_expense_plans.sql");
  assert.match(sql, /ledger_sync_recurring_expenses_v1/);
  assert.match(sql, /ledger_sync_recurring_expenses_v2/);
  assert.match(sql, /and is_active = true/);
  assert.match(sql, /and is_active=true/);
});

test("misclassified rent plan is deactivated by attributes rather than ID", () => {
  const sql = read("20260916172305_deactivate_misclassified_rent_recurring_plan.sql");
  assert.match(sql, /source_key_prefix = 'rent'/);
  assert.match(sql, /effective_from = date '2026-09-01'/);
  assert.match(sql, /amount = 60000000/);
  assert.match(sql, /is_active = true/);
  assert.doesNotMatch(sql, /where id\s*=/i);
});
