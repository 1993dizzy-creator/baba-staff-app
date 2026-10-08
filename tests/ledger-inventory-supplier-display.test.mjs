import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const code = ts.transpileModule(readFileSync("lib/ledger/inventory-display.ts", "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

test("confirmed inventory display reads current supplier without changing source evidence", async () => {
  const calls = [];
  const db = {
    from(table) {
      return {
        select(columns) {
          const call = { table, columns, ids: [] };
          calls.push(call);
          const query = {
            eq() { return query; },
            in(_column, ids) {
              call.ids = ids;
              return Promise.resolve({ data: table === "inventory_logs"
                ? [{ id: 10423, new_supplier: "Shopee" }] : [], error: null });
            },
          };
          return query;
        },
      };
    },
  };
  const testModule = { exports: {} };
  new Function("require", "module", "exports", code)(name => {
    if (name === "server-only") return {};
    if (name === "./inventory-repair") return { loadInventoryRepairPreview: async () => { throw new Error("Unexpected repair lookup in display-only test"); } };
    if (name === "@/lib/supabase/server") return { supabaseServer: db };
    if (name === "@/lib/inventory/ledger-sync-contract") {
      return { inventoryDisplayOverlay: (source, drift) => ({ ...source, ...drift }) };
    }
    return require(name);
  }, testModule, testModule.exports);
  const source = { inventory_log_id: 10423, supplier: null, item_name: "Giấy thấm dầu 15*15", purchase_amount: 153000 };
  const [row] = await testModule.exports.withInventoryDisplay([{ id: 2000, source_snapshot: source }]);
  assert.equal(row.source_snapshot, source);
  assert.equal(source.supplier, null);
  assert.equal(row.display_snapshot.supplier, "Shopee");
  assert.equal(row.display_snapshot.purchase_amount, 153000);
  assert.deepEqual(calls.find(call => call.table === "inventory_logs").ids, [10423]);
});
test("projection warnings use the source supplier and keep missing suppliers unconfirmed", async () => {
  let selectedColumns;
  const source = { item_id: 1, business_date: "2026-10-06", created_at: "2026-10-06T10:00:00Z", item_name: "배", change_quantity: -0.1, new_purchase_price: 35000 };
  const db = { from(table) {
    assert.equal(table, "ledger_inventory_projection_status");
    const query = {
      select(columns) { selectedColumns = columns; return query; },
      in() { return query; }, gte() { return query; }, lt() { return query; }, order() { return query; },
      async range() { return { data: [
        { inventory_log_id: 1, status: "review_required", code: "PURCHASE_CORRECTION_REFERENCE_REQUIRED", source: { ...source, new_supplier: " Source supplier " } },
        { inventory_log_id: 2, status: "review_required", code: "PURCHASE_CORRECTION_REFERENCE_REQUIRED", source: { ...source, new_supplier: null } },
      ], error: null }; },
    }; return query;
  } };
  const testModule = { exports: {} };
  new Function("require", "module", "exports", code)(name => {
    if (name === "server-only") return {};
    if (name === "./inventory-repair") return { loadInventoryRepairPreview: async () => ({ recommended: true, candidates: [{ supplier: "Suggested supplier", quantity: 1.42 }] }) };
    if (name === "@/lib/supabase/server") return { supabaseServer: db };
    if (name === "@/lib/inventory/ledger-sync-contract") return {};
    return require(name);
  }, testModule, testModule.exports);
  const rows = await testModule.exports.loadInventoryProjectionIssues("2026-10-01", "2026-11-01", 7);
  assert.match(selectedColumns, /new_supplier/);
  assert.equal(rows[0].supplier, "Source supplier");
  assert.equal(rows[1].supplier, null);
  assert.equal(rows.length, 2);
});
