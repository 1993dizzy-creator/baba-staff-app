import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const sql = readFileSync(
  join(process.cwd(), "supabase/migrations/202607170001_add_sales_receipt_financial_overrides.sql"),
  "utf8"
);

test("financial columns are nullable and legacy rows are not backfilled", () => {
  assert.match(sql, /tax_override_mode text null/i);
  assert.match(sql, /calculated_vat_amount numeric\(14,2\) null/i);
  assert.match(sql, /calculated_final_amount numeric\(14,2\) null/i);
  assert.match(sql, /final_amount_override numeric\(14,2\) null/i);
  assert.doesNotMatch(sql, /update\s+public\.pos_sales_receipts\s+set\s+tax_override_mode/i);
});

test("atomic RPC locks, checks revision and writes receipt/payment/audit", () => {
  assert.match(sql, /for update/i);
  assert.match(sql, /receipt_revision_conflict/i);
  assert.match(sql, /delete from public\.pos_sales_receipt_payments/i);
  assert.match(sql, /insert into public\.pos_sales_receipt_payments/i);
  assert.match(sql, /insert into public\.pos_sales_receipt_modifications/i);
  assert.match(sql, /original_tax_summary=coalesce\(original_tax_summary,v_original_tax_summary\)/i);
  assert.match(sql, /original_amount_summary=coalesce\(original_amount_summary,v_original_amount_summary\)/i);
  assert.match(sql, /amount,raw_json[\s\S]*v_final/i);
});

test("RPC is invoker-only and browser roles cannot execute it", () => {
  assert.match(sql, /security invoker/i);
  assert.match(sql, /set search_path = pg_catalog, public/i);
  assert.match(sql, /from public, anon, authenticated/i);
  assert.match(sql, /to service_role/i);
});

test("financial-only changes do not decide inventory reprocessing", () => {
  assert.match(sql, /v_inventory_changed := exists/i);
  assert.match(sql, /current_line\.quantity = \(item->>'quantity'\)::numeric/i);
  assert.match(sql, /inventory_deduction_reprocess_required=v_inventory_changed/i);
});
