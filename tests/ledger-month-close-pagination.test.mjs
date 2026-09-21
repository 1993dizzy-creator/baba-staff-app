import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);

function loadTs(path, dependencies) {
  const code = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const testModule = { exports: {} };
  new Function("require", "module", "exports", code)(name => dependencies[name] ?? require(name), testModule, testModule.exports);
  return testModule.exports;
}

function fixture(transactionCount, extraTables = {}) {
  const transactions = Array.from({ length: transactionCount }, (_, index) => ({
    id: index + 1, type: "expense", business_date: "2026-08-15", recognition_month: "2026-08-01",
    amount: 0, economic_effect_sign: 1, source_type: "manual", source_key: null,
    category: { name: "재고" }, movements: [],
  }));
  if (transactionCount > 1000) {
    transactions[1000] = { ...transactions[1000], amount: 100,
      movements: [{ fund_account_id: 1, amount: -100 }] };
  }
  if (transactionCount > 1012) {
    transactions[1012] = { ...transactions[1012], type: "sales", amount: 50,
      movements: [{ fund_account_id: 1, amount: 50 }] };
  }
  const pages = [];
  const allPages = [];
  const tables = {
    ledger_transactions: transactions,
    ledger_fund_accounts: [{ id: 1, code: "store_cash", type: "cash", display_name: "현금", is_active: true }],
    ...extraTables,
  };
  const supabaseServer = {
    from(table) {
      const query = {
        table, start: 0, end: Infinity, ordered: false,
        select() { return this; }, eq() { return this; }, neq() { return this; }, lt() { return this; }, lte() { return this; }, or() { return this; },
        order(column) { if (column === "id") this.ordered = true; return this; },
        range(from, to) { this.start = from; this.end = to; return this; },
        maybeSingle() { return Promise.resolve({ data: null, error: null }); },
        then(resolve, reject) {
          allPages.push([this.table, this.start, this.end]);
          if (this.table === "ledger_transactions") {
            assert.equal(this.ordered, true, "transaction pages need a stable id order");
            pages.push([this.start, this.end]);
          }
          const source = tables[this.table] ?? [];
          return Promise.resolve({ data: source.slice(this.start, Math.min(this.end + 1, this.start + 1000)), error: null }).then(resolve, reject);
        },
      };
      return query;
    },
    rpc() { return Promise.resolve({ data: null, error: null }); },
  };
  const { loadCardRows } = loadTs("lib/ledger/card-settlement-data.ts", {
    "@/lib/supabase/server": { supabaseServer },
  });
  const { buildMonthCloseSnapshot } = loadTs("lib/ledger/month-close.ts", {
    "server-only": {},
    "node:crypto": require("node:crypto"),
    "@/lib/common/business-time": require("../lib/common/business-time.ts"),
    "@/lib/ledger/month-close-card": require("../lib/ledger/month-close-card.ts"),
    "@/lib/ledger/month-close-operating": require("../lib/ledger/month-close-operating.ts"),
    "@/lib/ledger/card-settlement-data": { loadCardRows },
    "@/lib/supabase/server": { supabaseServer },
  });
  return { buildMonthCloseSnapshot, pages, allPages };
}

test("snapshot pages payables and candidates beyond the Supabase 1000-row cap", async () => {
  const payables = Array.from({ length: 1001 }, (_, index) => ({
    id: index + 1, party_id: 10, original_amount: 1, status: "unpaid",
    expense: { business_date: "2026-08-15", source_snapshot: {} }, party: { name: "Supplier" },
  }));
  const candidates = Array.from({ length: 1013 }, (_, index) => ({ id: index + 1, candidate_type: "inventory_purchase", status: "confirmed" }));
  const { buildMonthCloseSnapshot, allPages } = fixture(0, { ledger_payables: payables, ledger_candidates: candidates });
  const snapshot = await buildMonthCloseSnapshot("2026-08");
  assert.equal(snapshot.payables.totalOutstanding, 1001);
  assert.equal('paymentVerification' in snapshot, false, 'historical snapshots without verification retain their shape');
  assert.equal(snapshot.candidate.counts["inventory_purchase:confirmed"], 1013);
  for (const table of ["ledger_payables", "ledger_candidates"])
    assert.deepEqual(allPages.filter(([name]) => name === table).map(([, from, to]) => [from, to]), [[0, 999], [1000, 1999]]);
});

test("verification purchase affects expense but not cash or ordinary payable subtotal", async () => {
  const expense = { id: 1, type: "expense", business_date: "2026-08-29", recognition_month: "2026-08-01",
    amount: 1_900_000, economic_effect_sign: 1, source_type: "inventory_purchase_candidate", source_key: "candidate:1",
    category: { name: "Inventory" }, movements: [] };
  const payable = { id: 1, party_id: 10, original_amount: 1_900_000, status: "unpaid",
    expense: { business_date: "2026-08-29", source_snapshot: { paymentVerification: "pending" } }, party: { name: "Chợ" } };
  const { buildMonthCloseSnapshot } = fixture(0, { ledger_transactions: [expense], ledger_payables: [payable] });
  const snapshot = await buildMonthCloseSnapshot("2026-08");
  assert.equal(snapshot.expense.total, 1_900_000);
  assert.equal(snapshot.funds.liquidFunds, 0);
  assert.equal(snapshot.payables.totalOutstanding, 0);
  assert.deepEqual(snapshot.paymentVerification, { count: 1, totalOutstanding: 1_900_000 });
});

for (const count of [1000, 1001, 1013]) {
  test(`month-close snapshot includes all ${count} transactions`, async () => {
    const { buildMonthCloseSnapshot, pages } = fixture(count);
    const snapshot = await buildMonthCloseSnapshot("2026-08");
    assert.deepEqual(pages, count === 1000 ? [[0, 999], [1000, 1999]] : [[0, 999], [1000, 1999]]);
    assert.equal(snapshot.funds.accounts[0].balance, count > 1012 ? -50 : count > 1000 ? -100 : 0);
    assert.equal(snapshot.funds.liquidFunds, snapshot.funds.accounts[0].balance);
    assert.equal(snapshot.expense.total, count > 1000 ? 100 : 0);
    assert.equal(snapshot.revenue.total, count > 1012 ? 50 : 0);
    assert.equal(snapshot.operatingResult.operatingProfit, snapshot.revenue.total - snapshot.expense.total);
  });
}
