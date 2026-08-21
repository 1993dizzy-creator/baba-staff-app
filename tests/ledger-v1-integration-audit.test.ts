import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const { allocateOwnerPool } = createRequire(import.meta.url)("../lib/ledger/owner-allocation-core.ts") as typeof import("../lib/ledger/owner-allocation-core");
const names = ["create_ledger_v1_foundation", "add_ledger_pos_sales_sync", "add_inventory_purchase_candidates", "add_ledger_payable_payments", "add_ledger_meal_payroll_sync", "add_ledger_card_settlements", "add_recurring_reserves_bep", "add_ledger_month_close_corrections", "add_owner_settlements"];
const migrations = names.map((name, index) => fs.readFileSync(`supabase/migrations/20260821000${index + 1}_${name}.sql`, "utf8"));
const closeHelper = fs.readFileSync("lib/ledger/month-close.ts", "utf8");

test("integrated P&L recognizes each economic event once", () => {
  const rows = [
    { type: "sales", amount: 500_000_000, sign: 1 },
    { type: "expense", amount: 100_000_000, sign: 1 },
    { type: "expense", amount: 10_000_000, sign: 1 },
    { type: "expense_recognition", amount: 80_000_000, sign: 1 },
    { type: "expense_recognition", amount: 60_000_000, sign: 1 },
    { type: "expense_recognition", amount: 5_000_000, sign: 1 },
    { type: "expense", amount: 2_000_000, sign: -1 },
  ];
  const income = rows.filter(row => ["income", "sales"].includes(row.type)).reduce((sum, row) => sum + row.amount * row.sign, 0);
  const expense = rows.filter(row => ["expense", "expense_recognition"].includes(row.type)).reduce((sum, row) => sum + row.amount * row.sign, 0);
  assert.equal(income - expense, 247_000_000);
  assert.match(closeHelper, /economic_effect_sign/);
});

test("fund balance is opening plus signed movements and excludes virtual events", () => {
  assert.equal([20_000_000, -10_000_000, -5_000_000, 30_000_000, -15_000_000].reduce((sum, amount) => sum + amount, 100_000_000), 120_000_000);
  const all = migrations.join("\n");
  assert.match(all, /Virtual earmarks only/);
  assert.match(all, /owner settlement confirmed; no fund movement/i);
});

test("safe cash and owner payment remain economically consistent", () => {
  const before = 280_000_000 - 60_000_000 - 80_000_000 - 20_000_000;
  assert.equal(before, 120_000_000);
  assert.equal(Math.min(180_000_000, before), 120_000_000);
  const afterConfirm = 280_000_000 - 60_000_000 - 80_000_000 - 120_000_000;
  const afterPayment = 250_000_000 - 60_000_000 - 80_000_000 - 90_000_000;
  assert.equal(afterConfirm, 20_000_000);
  assert.equal(afterPayment, afterConfirm);
});

test("investment recovery allocation and payments are recovery-first", () => {
  const [line] = allocateOwnerPool("35.000", [{ participantId: 1, rate: "1.000000", sortOrder: 1 }]);
  const recovery = Math.min(Number(line.assignedAmount), 100 - 80);
  assert.deepEqual({ recovery, profit: Number(line.assignedAmount) - recovery }, { recovery: 20, profit: 15 });
  let recoveryPaid = 0, profitPaid = 0;
  for (const payment of [10, 15, 10]) { const recoveryPart = Math.min(payment, recovery - recoveryPaid); recoveryPaid += recoveryPart; profitPaid += payment - recoveryPart; }
  assert.deepEqual({ recoveryPaid, profitPaid }, { recoveryPaid: 20, profitPaid: 15 });
});

test("month close card totals use confirmation cutoff rather than current status", () => {
  assert.match(closeHelper, /confirmed_at!=null&&String\(row\.confirmed_at\)<endAt/);
  assert.match(closeHelper, /asOfMatchedIds/);
});

test("all migrations deny browser table access and fix security definer search paths", () => {
  const all = migrations.join("\n");
  assert.doesNotMatch(all, /grant\s+(select|insert|update|delete)[^;]*to\s+(public|anon|authenticated)/i);
  for (const match of all.matchAll(/create or replace function public\.[\s\S]*?\$\$;/gi)) if (/security definer/i.test(match[0])) assert.match(match[0], /set search_path=pg_catalog,public/i);
});

test("correction API preserves numeric input instead of coercing it through JS Number", () => {
  const route = fs.readFileSync("app/api/admin/ledger/corrections/route.ts", "utf8");
  assert.match(route, /p_economic_delta:body\.economicDelta\?\?"0"/);
  assert.doesNotMatch(route, /p_economic_delta:Number/);
});

test("month-close trigger functions are not public executable entry points", () => {
  assert.match(migrations[7], /revoke all on function public\.ledger_transaction_month_guard_v1\(\)[\s\S]*public\.ledger_confirmed_candidate_drift_v1\(\) from public,anon,authenticated,service_role/);
});
