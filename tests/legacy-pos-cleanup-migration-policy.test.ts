import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migrationPath =
  "supabase/migrations/202607190002_archive_cleanup_legacy_pos_processed_lines.sql";
const migration = readFileSync(migrationPath, "utf8");
const batchWriter = readFileSync("lib/sales/inventory-deduction-batches.ts", "utf8");
const reprocessWriter = readFileSync("lib/sales/inventory-deduction-reprocess.ts", "utf8");

test("cleanup migration archives both legacy entity sets with restricted access", () => {
  assert.match(migration, /create table public\.legacy_pos_processed_line_archive/i);
  assert.match(migration, /create table public\.legacy_pos_inventory_deduction_archive/i);
  assert.match(migration, /enable row level security/i);
  assert.match(migration, /revoke all[\s\S]*from public, anon, authenticated, service_role/i);
  assert.match(migration, /grant select[\s\S]*to service_role/i);
  assert.doesNotMatch(migration, /source_payload|dry_run_result/i);
});

test("cleanup is fail-closed around the confirmed legacy data state", () => {
  assert.match(migration, /expected 319 processed lines/i);
  assert.match(migration, /expected 42 legacy deductions/i);
  assert.match(migration, /expected 1 applied legacy deduction/i);
  assert.match(migration, /expected 41 failed legacy deductions/i);
  assert.match(migration, /applied legacy inventory-log link is not exact/i);
  assert.match(migration, /definition changed/i);
});

test("only legacy deductions and processed-line schema are removed", () => {
  assert.match(migration, /delete from public\.pos_inventory_deductions where processed_line_id is not null/i);
  assert.doesNotMatch(migration, /delete from public\.pos_inventory_deductions\s*(?:;|where\s+receipt_id)/i);
  assert.match(migration, /drop column processed_line_id/i);
  assert.match(migration, /drop table public\.pos_processed_invoice_lines/i);
  assert.doesNotMatch(migration, /drop table public\.pos_inventory_deductions/i);
  assert.doesNotMatch(migration, /drop[\s\S]{0,20}cascade/i);
});

test("constraint-owned legacy index is removed through its unique constraint", () => {
  assert.match(
    migration,
    /alter table public\.pos_inventory_deductions\s+drop constraint pos_inventory_deductions_unique_item/i,
  );
  assert.doesNotMatch(
    migration,
    /drop index(?:\s+if exists)?\s+(?:public\.)?pos_inventory_deductions_unique_item/i,
  );
  assert.match(migration, /constraint_row\.conindid = index_relation\.oid/i);
  assert.match(migration, /constraint_row\.contype = 'u'/i);
  assert.match(migration, /UNIQUE \(processed_line_id, inventory_item_id\)/i);
});

test("receipt idempotency and reversal indexes are explicitly preserved", () => {
  for (const indexName of [
    "pos_inventory_deductions_idempotency_uidx",
    "pos_inventory_deductions_success_reversal_uidx",
    "pos_inventory_deductions_receipt_id_idx",
  ]) {
    assert.match(migration, new RegExp(`to_regclass\\('public\\.${indexName}'\\)`, "i"));
    assert.doesNotMatch(
      migration,
      new RegExp(`drop\\s+(?:index|constraint)[\\s\\S]{0,80}${indexName}`, "i"),
    );
  }
});

test("legacy RPC is removed and current lifecycle functions remain service-only", () => {
  assert.match(migration, /drop function public\.apply_pos_direct_inventory_deductions/i);
  assert.match(migration, /reprocess_modified_sales_inventory_deduction_receipt/i);
  assert.match(migration, /rollback_canceled_sales_inventory_deduction_receipt/i);
  assert.match(migration, /grant execute[\s\S]*reprocess_modified[\s\S]*to service_role/i);
  assert.match(migration, /grant execute[\s\S]*rollback_canceled[\s\S]*to service_role/i);
});

test("migration never mutates inventory quantities or deletes inventory logs", () => {
  assert.doesNotMatch(migration, /update\s+public\.inventory\b/i);
  assert.doesNotMatch(migration, /delete\s+from\s+public\.inventory_logs\b/i);
  assert.doesNotMatch(migration, /insert\s+into\s+public\.inventory_logs\b/i);
  assert.match(migration, /inventory_quantity_checksum/i);
  assert.match(migration, /receipt deduction ID or state changed/i);
});

test("current receipt writers do not send the removed legacy column", () => {
  assert.doesNotMatch(batchWriter, /processed_line_id/);
  assert.doesNotMatch(reprocessWriter, /processed_line_id/);
});
