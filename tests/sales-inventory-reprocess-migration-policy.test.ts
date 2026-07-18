import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const source = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

test("reprocess hotfix is an explicit function definition with a fixed search path", () => {
  const migration = source(
    "supabase/migrations/202607180005_fix_reprocess_modified_sales_inventory_deduction.sql"
  );

  assert.match(migration, /create or replace function public\.reprocess_modified_sales_inventory_deduction_receipt\(/i);
  assert.match(migration, /security definer\s+set search_path = pg_catalog, public/i);
  assert.doesNotMatch(migration, /pg_get_functiondef|execute v_definition|replace\(v_definition/i);
  assert.match(migration, /truncate table pg_temp\.sales_reprocess_active_deductions;/i);
  assert.doesNotMatch(migration, /delete from pg_temp\.sales_reprocess_active_deductions;/i);
});

test("the temporary snapshot is rebuilt only after underlying deduction rows are locked", () => {
  const migration = source(
    "supabase/migrations/202607180005_fix_reprocess_modified_sales_inventory_deduction.sql"
  );
  const lock = migration.indexOf("for update of deduction;");
  const truncate = migration.indexOf("truncate table pg_temp.sales_reprocess_active_deductions;");
  const refill = migration.indexOf("insert into pg_temp.sales_reprocess_active_deductions", truncate);

  assert.ok(lock > 0 && truncate > lock && refill > truncate);
});

test("rollback-only receipts restore active deductions and apply no new candidates", () => {
  const migration = source(
    "supabase/migrations/202607180005_fix_reprocess_modified_sales_inventory_deduction.sql"
  );

  assert.match(migration, /v_rollback_only := v_candidate_count = 0;/);
  assert.match(migration, /if v_active_count = 0 and v_candidate_count = 0 then/);
  assert.match(migration, /for v_active in[\s\S]*v_reversed_count := v_reversed_count \+ 1;/);
  assert.match(migration, /for v_candidate in[\s\S]*v_applied_count := v_applied_count \+ 1;/);
  assert.match(migration, /'rollbackOnly', v_rollback_only/);
});

test("same-fingerprint reprocessing is serialized and rejected after a prior success", () => {
  const migration = source(
    "supabase/migrations/202607180005_fix_reprocess_modified_sales_inventory_deduction.sql"
  );
  const receiptLock = migration.indexOf("from public.pos_sales_receipts receipt");
  const duplicateLookup = migration.indexOf("into v_existing_success_id");

  assert.ok(receiptLock > 0 && duplicateLookup > receiptLock);
  assert.match(migration.slice(receiptLock, duplicateLookup), /for update;/);
  assert.match(migration, /receipt_content_fingerprint\s*=\s*v_batch_receipt\.receipt_content_fingerprint/);
  assert.match(migration, /existing\.status = 'applied'/);
  assert.match(migration, /'result', 'already_processed'/);
});

test("only the server-side service role can execute the reprocess function", () => {
  const migration = source(
    "supabase/migrations/202607180005_fix_reprocess_modified_sales_inventory_deduction.sql"
  );
  const server = source("lib/supabase/server.ts");
  const caller = source("lib/sales/inventory-deduction-reprocess.ts");

  assert.match(migration, /from public, anon, authenticated;/);
  assert.match(migration, /to service_role;/);
  assert.match(server, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(caller, /\.rpc\(\s*"reprocess_modified_sales_inventory_deduction_receipt"/);
});
