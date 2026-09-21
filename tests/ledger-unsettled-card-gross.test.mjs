import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const route = readFileSync("app/api/admin/ledger/route.ts", "utf8");
const compiled = ts.transpileModule(route, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const sale = (id, amount, businessDate = "2026-08-15") => ({
  id, amount, business_date: businessDate, status: "confirmed",
  source_type: "pos_sales_daily_payment", source_key: `pos:${businessDate}:card`,
});
const line = (id, saleRow, gross, status = "matched", depositDate = "2026-08-20", depositAmount = 95) => ({
  id, pos_card_transaction_id: saleRow.id, allocated_gross_amount: gross, sale: saleRow,
  reconciliation: { status, deposit_date: depositDate, deposit_amount: depositAmount },
});

// Execute the actual GET handler with a read-only query double that applies its filters.
async function summary(sales, lines, { failAllocations = false } = {}) {
  const queries = [];
  const db = { from(table) {
    const query = { table, select: "", filters: [], from: 0, to: 999 };
    queries.push(query);
    const chain = {
      select(value) { query.select = value; return chain; },
      order() { return chain; },
      range(from, to) { Object.assign(query, { from, to }); return chain; },
      async maybeSingle() { return { data: null, error: null }; },
      then(resolve, reject) {
        if (table === "ledger_card_reconciliation_lines" && failAllocations) {
          return Promise.resolve({ data: null, error: { code: "ALLOCATION_READ_FAILED" } }).then(resolve, reject);
        }
        let rows = table === "ledger_card_reconciliation_lines" ? lines
          : table === "ledger_card_reconciliations" ? lines.map(l => l.reconciliation)
          : table === "ledger_transactions" && query.select === "id,business_date,amount,source_key,memo" ? sales : [];
        for (const [operator, key, expected] of query.filters) {
          rows = rows.filter(row => {
            const value = key.split(".").reduce((current, part) => current?.[part], row);
            if (operator === "eq") return value === expected;
            if (operator === "neq") return value !== expected;
            if (operator === "gte") return value >= expected;
            if (operator === "lt") return value < expected;
            if (operator === "like") return new RegExp(`^${expected.replaceAll("%", ".*")}$`).test(value);
            if (operator === "in") return expected.includes(value);
            return true;
          });
        }
        return Promise.resolve({ data: rows.slice(query.from, query.to + 1), error: null }).then(resolve, reject);
      },
    };
    for (const operator of ["eq", "neq", "gte", "lt", "lte", "like", "in", "not"]) {
      chain[operator] = (key, value) => { query.filters.push([operator, key, value]); return chain; };
    }
    return chain;
  } };
  const exports = {};
  vm.runInNewContext(compiled, {
    exports, URL, console: { error() {} },
    require(name) {
      if (name === "@/lib/supabase/server") return { supabaseServer: db };
      if (name === "@/lib/ledger/server") return { requireLedgerActor: async () => ({}), ledgerJson: body => body };
      if (name === "@/lib/ledger/inventory-display") return { withInventoryDisplay: async rows => rows, loadInventoryProjectionIssues: async () => [] };
      if (name === "@/lib/ledger/entries") return { buildLedgerEntries: () => [] };
      if (name === "@/lib/ledger/reserve-balances") return { reservesByFundAccount: () => new Map() };
      if (name === "@/lib/ledger/payables") return { computePaidExpenseTotal: () => 0 };
      if (name === "@/lib/ledger/summary") return require("../lib/ledger/summary.ts");
      if (name === "@/lib/ledger/cash-outflow") return require("../lib/ledger/cash-outflow.ts");
      if (name === "@/lib/ledger/card-settlements") return require("../lib/ledger/card-settlements.ts");
      if (name === "@/lib/common/business-time") return {
        getBusinessDate: () => "2026-09-15",
        getBusinessMonthEndBoundary: month => {
          const next=new Date(`${month}-01T00:00:00Z`);next.setUTCMonth(next.getUTCMonth()+1);const businessDateExclusive=next.toISOString().slice(0,10);
          return {businessDateExclusive,cutoffAt:`${businessDateExclusive}T03:00:00+07:00`};
        },
      };
      if (name === "@/lib/ledger/fund-account-view") return require("../lib/ledger/fund-account-view.ts");
      if (name === "@/lib/ledger/card-settlement-data") {
        const dataExports = {};
        const dataCode = ts.transpileModule(readFileSync("lib/ledger/card-settlement-data.ts", "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
        vm.runInNewContext(dataCode, { exports: dataExports, require: dependency => {
          if (dependency === "@/lib/supabase/server") return { supabaseServer: db };
          throw new Error(`Unexpected data import: ${dependency}`);
        } });
        return dataExports;
      }
      throw new Error(`Unexpected import: ${name}`);
    },
  });
  const body = await exports.GET(new Request("http://localhost/api/admin/ledger?month=2026-08"));
  return { body, queries };
}

test("card fees do not leave gross unsettled when the full sale gross is allocated", async () => {
  const s = sale(1, 100);
  const { body } = await summary([s], [line(1, s, 100, "matched", "2026-08-20", 95)]);
  assert.equal(body.summary.actualCardDeposits, 95);
  assert.equal(body.summary.unsettledCardGross, 0);
});

test("cancelled reconciliation allocations are excluded", async () => {
  const s = sale(1, 100);
  const { body } = await summary([s], [line(1, s, 70, "cancelled"), line(2, s, 20, "partial")]);
  assert.equal(body.summary.unsettledCardGross, 80);
});

test("August month-end unsettled gross does not retroactively include a September deposit", async () => {
  const s = sale(1, 100);
  const { body } = await summary([s], [line(1, s, 100, "matched", "2026-09-10")]);
  // The August as-of snapshot excludes allocations deposited after August 31.
  assert.equal(body.summary.actualCardDeposits, 0);
  assert.equal(body.summary.unsettledCardGross, 100);
});

test("other months, non-card sources and unconfirmed sales do not reduce August card gross", async () => {
  const august = sale(1, 100), september = sale(2, 500, "2026-09-01");
  const cash = { ...sale(3, 500), source_key: "pos:2026-08-15:cash" };
  const cancelled = { ...sale(4, 500), status: "cancelled" };
  const manual = { ...sale(5, 500), source_type: "manual" };
  const { body } = await summary([august, september, cash, cancelled, manual], [
    line(1, august, 20), line(2, september, 500), line(3, cash, 500),
    line(4, cancelled, 500), line(5, manual, 500),
  ]);
  assert.equal(body.summary.cardGrossSales, 100);
  assert.equal(body.summary.unsettledCardGross, 80);
});

test("unsettled gross is floored at zero", async () => {
  const s = sale(1, 100);
  const { body } = await summary([s], [line(1, s, 101)]);
  assert.equal(body.summary.unsettledCardGross, 0);
});

test("an overallocated sale cannot consume another sale's outstanding gross", async () => {
  const first = sale(1, 100), second = sale(2, 200);
  const { body } = await summary([first, second], [line(1, first, 150)]);
  assert.equal(body.summary.cardGrossSales, 300);
  assert.equal(body.summary.reconciledCardGross, 100);
  assert.equal(body.summary.unreconciledCardGross, 200);
  assert.equal(body.summary.unsettledCardGross, 200);
});

test("allocation totals include pages beyond the default 1000-row limit", async () => {
  const s = sale(1, 2000);
  const { body, queries } = await summary([s], Array.from({ length: 1001 }, (_, i) => line(i + 1, s, 1)));
  assert.equal(body.summary.unsettledCardGross, 999);
  assert.equal(queries.filter(q => q.table === "ledger_card_reconciliation_lines").length, 2);
});

test("allocation read failure fails the summary instead of silently overstating unsettled gross", async () => {
  const { body } = await summary([sale(1, 100)], [], { failAllocations: true });
  assert.equal(body.ok, false);
  assert.equal(body.code, "LEDGER_LOAD_FAILED");
});
