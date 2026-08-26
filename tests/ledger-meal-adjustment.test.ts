import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { TransactionRow } from "../lib/ledger/entries";

const { buildLedgerEntries } = await import(new URL("../lib/ledger/entries.ts", import.meta.url).href) as typeof import("../lib/ledger/entries");
const { parseMealFinalAmount } = await import(new URL("../lib/ledger/meal-adjust-input.ts", import.meta.url).href) as typeof import("../lib/ledger/meal-adjust-input");
const read = (path: string) => readFileSync(path, "utf8");
const sql = read("supabase/migrations/20260826113239_adjust_open_meal_transactions.sql");
const api = read("app/api/admin/ledger/transactions/[id]/meal-adjust/route.ts");
const ledgerApi = read("app/api/admin/ledger/route.ts");
const entriesSource = read("lib/ledger/entries.ts");
const page = read("app/(protected)/admin/ledger/entries/page.tsx");
const genericCorrection = read("app/api/admin/ledger/corrections/route.ts");
const inventoryMigration = read("supabase/migrations/202608250003_rebook_inventory_transaction.sql");

function mealTransaction(id = 10, amount = 270_000): TransactionRow {
  return {
    id,
    type: "expense",
    business_date: "2026-08-26",
    occurred_at: "2026-08-26T03:12:00Z",
    recognition_month: "2026-08-01",
    amount,
    economic_effect_sign: 1,
    source_type: "attendance_meal_daily_candidate",
    source_key: "candidate:77",
    source_snapshot: { employee_count: 9 },
    memo: "직원 식대 · 9명",
    category: { id: 5, name: "직원 식대" },
    movements: [{ amount: -amount, fund_account: { id: 3, display_name: "매장 현금" } }],
  };
}

function adjustment(id: number, originalId: number, amount: number, sign: 1 | -1): TransactionRow {
  return {
    id,
    type: "expense",
    business_date: "2026-09-01",
    recognition_month: "2026-08-01",
    amount,
    economic_effect_sign: sign,
    correction_of_id: originalId,
    source_type: "ledger_correction",
    source_snapshot: { adjustmentType: "employee_meal", originalTransactionId: originalId },
    category: { id: 5, name: "직원 식대" },
    movements: [{ amount: -amount * sign, fund_account: { id: 3, display_name: "매장 현금" } }],
  };
}

test("increase and decrease adjustments render one meal row at signed effective amount", () => {
  const original = mealTransaction();
  const increased = buildLedgerEntries([original, adjustment(11, 10, 30_000, 1)], [], new Map());
  assert.equal(increased.length, 1);
  assert.equal(increased[0].drilldown, "meal");
  assert.equal(increased[0].originalAmount, 270_000);
  assert.equal(increased[0].adjustmentAmount, 30_000);
  assert.equal(increased[0].effectiveAmount, 300_000);
  assert.equal(increased[0].amount, 300_000);

  const decreased = buildLedgerEntries([original, adjustment(12, 10, 30_000, -1)], [], new Map());
  assert.equal(decreased.length, 1);
  assert.equal(decreased[0].adjustmentAmount, -30_000);
  assert.equal(decreased[0].effectiveAmount, 240_000);
  assert.equal(decreased[0].amount, 240_000);
});

test("sequential adjustments aggregate from current effective amount", () => {
  const original = mealTransaction();
  const to330 = buildLedgerEntries([
    original,
    adjustment(11, 10, 30_000, 1),
    adjustment(12, 10, 30_000, 1),
  ], [], new Map())[0];
  assert.equal(to330.effectiveAmount, 330_000);

  const to240 = buildLedgerEntries([
    original,
    adjustment(11, 10, 30_000, 1),
    adjustment(12, 10, 60_000, -1),
  ], [], new Map())[0];
  assert.equal(to240.adjustmentAmount, -30_000);
  assert.equal(to240.effectiveAmount, 240_000);
});

test("RPC calculates delta under a per-original lock and no-ops unchanged totals", () => {
  assert.match(sql, /pg_advisory_xact_lock[\s\S]*ledger_meal_adjustment:/);
  assert.match(sql, /where id = p_original_transaction_id\s+for update/);
  assert.match(sql, /v_original\.amount \* v_original\.economic_effect_sign[\s\S]*sum\(linked\.amount \* linked\.economic_effect_sign\)/);
  assert.match(sql, /v_delta := p_final_amount - v_previous_amount/);
  assert.match(sql, /if v_delta = 0 then[\s\S]*'status', 'unchanged'/);
  assert.ok(sql.indexOf("pg_advisory_xact_lock") < sql.indexOf("v_delta :="));
});

test("RPC supports positive, negative and zero final amounts with exact signs", () => {
  assert.match(sql, /p_final_amount < 0/);
  assert.doesNotMatch(sql, /p_final_amount <= 0/);
  assert.match(sql, /amount[\s\S]*abs\(v_delta\)/);
  assert.match(sql, /case when v_delta > 0 then 1 else -1 end/);
  assert.match(sql, /values \(v_adjustment_id, v_store_cash_id, -v_delta\)/);
  assert.equal(parseMealFinalAmount(0), "0");
  assert.equal(parseMealFinalAmount("300000"), "300000");
  assert.equal(parseMealFinalAmount("240000.125"), "240000.125");
  for (const invalid of [-1, "-1", "1e3", "1.0001", "", null]) {
    assert.equal(parseMealFinalAmount(invalid), null);
  }
});

test("RPC only accepts a fully linked confirmed employee meal", () => {
  for (const marker of [
    "status <> 'confirmed'", "type <> 'expense'",
    "source_type <> 'attendance_meal_daily_candidate'", "correction_of_id is not null",
    "category.name = '직원 식대'", "candidate_type <> 'employee_meal'",
    "source_type <> 'attendance_meal_daily'", "resolved_transaction_id is distinct from v_original.id",
  ]) assert.match(sql, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(sql, /source_key !~ '\^candidate:\[0-9\]\+\$'/);
  assert.match(sql, /invalid_meal_candidate_link/);
});

test("RPC blocks closed source month and validates dated business store cash", () => {
  assert.match(sql, /ledger_month_close:[\s\S]*ledger_month_is_closed_v1\(v_source_month\)[\s\S]*original_month_closed/);
  assert.match(sql, /account.code = 'store_cash'/);
  assert.match(sql, /account.is_active = true/);
  assert.match(sql, /account.is_business_fund = true/);
  assert.match(sql, /account.active_from <= v_business_date/);
  assert.match(sql, /account.active_to is null or account.active_to >= v_business_date/);
  assert.match(sql, /store_cash_unavailable/);
});

test("RPC preserves source provenance and writes linked audit snapshots", () => {
  assert.doesNotMatch(sql, /update public\.ledger_transactions/);
  assert.doesNotMatch(sql, /update public\.ledger_candidates/);
  for (const marker of [
    "correction_of_id", "adjustmentType", "employee_meal", "previousEffectiveAmount",
    "finalAmount", "economicDelta", "originalSourceType", "originalSourceKey", "adjustedAt",
    "meal_adjustment_created", "storeCashMovement", "originalSourceFingerprint",
  ]) assert.match(sql, new RegExp(marker));
  assert.match(sql, /created_by,[\s\S]*confirmed_by, economic_effect_sign/);
});

test("adjustment source metadata satisfies the non-manual transaction constraint", () => {
  assert.match(sql, /v_adjustment_snapshot jsonb/);
  assert.match(sql, /v_adjustment_fingerprint text/);
  assert.match(sql, /v_adjustment_snapshot := jsonb_build_object\([\s\S]*'adjustmentType', 'employee_meal'[\s\S]*'adjustedAt', v_adjusted_at/);
  assert.match(sql, /md5\(v_adjustment_snapshot::text \|\| ':1'\)[\s\S]*md5\(v_adjustment_snapshot::text \|\| ':2'\)/);
  assert.match(sql, /source_fingerprint, source_synced_at, correction_of_id/);
  assert.match(sql, /v_adjustment_snapshot, v_adjustment_fingerprint, v_adjusted_at/);
  assert.match(sql, /source_type[\s\S]*'ledger_correction'/);
  assert.doesNotMatch(sql, /'manual'[\s\S]*v_adjustment_snapshot/);
});

test("RPC and API remain service-only and actor gated", () => {
  assert.match(sql, /from public\.users[\s\S]*is_active = true[\s\S]*app_login_enabled = true/);
  assert.match(sql, /not in \('owner', 'master'\)/);
  assert.match(sql, /security definer[\s\S]*set search_path = pg_catalog, public/);
  assert.match(sql, /revoke all[\s\S]*from public, anon, authenticated/);
  assert.match(sql, /grant execute[\s\S]*to service_role/);
  assert.match(api, /requireLedgerActor\(\)/);
  assert.match(api, /ledger_adjust_open_meal_transaction_v1/);
  assert.match(api, /original_month_closed[\s\S]*409/);
});

test("generic correction and Inventory rebook contracts are untouched", () => {
  assert.match(genericCorrection, /ledger_create_correction_v1/);
  assert.doesNotMatch(genericCorrection, /meal-adjust|ledger_adjust_open_meal/);
  assert.match(inventoryMigration, /ledger_rebook_inventory_transaction_v1/);
  assert.doesNotMatch(inventoryMigration, /employee_meal|attendance_meal/);
});

test("ledger API fetches only linked meal corrections across business months", () => {
  assert.match(ledgerApi, /mealOriginalIds[\s\S]*source_type === "attendance_meal_daily_candidate"/);
  assert.match(ledgerApi, /\.eq\("source_type", "ledger_correction"\)/);
  assert.match(ledgerApi, /\.eq\("source_snapshot->>adjustmentType", "employee_meal"\)/);
  assert.match(ledgerApi, /\.in\("correction_of_id", ids\)/);
  assert.match(ledgerApi, /idChunkSize = 200/);
  assert.match(ledgerApi, /pageSize = 1000/);
});

test("meal corrections are hidden as rows and summed with economic sign", () => {
  assert.match(entriesSource, /mealAdjustmentsByOriginal/);
  assert.match(entriesSource, /adjustment\.amount\) \* value\(adjustment\.economic_effect_sign/);
  assert.match(entriesSource, /source_snapshot\?\.adjustmentType === "employee_meal"[\s\S]*continue/);
  assert.match(entriesSource, /drilldown: "meal"/);
});

test("meal rows use the short snapshot title and fixed 18:00 display time", () => {
  const entry = buildLedgerEntries([mealTransaction()], [], new Map())[0];
  assert.equal(entry.title, "직원 식대 · 9명");
  assert.equal(entry.displayTime, "18:00");
});

test("same-day ledger rows sort by Vietnam display time descending", () => {
  const manual = (id: number, occurredAt: string): TransactionRow => ({
    id,
    type: "expense",
    business_date: "2026-08-26",
    occurred_at: occurredAt,
    amount: 10_000,
    economic_effect_sign: 1,
    source_type: "manual",
    memo: `manual-${id}`,
  });
  const entries = buildLedgerEntries([
    manual(21, "2026-08-26T10:30:00Z"),
    mealTransaction(),
    manual(22, "2026-08-26T12:15:00Z"),
  ], [], new Map());
  assert.deepEqual(entries.map((entry) => entry.displayTime), ["19:15", "18:00", "17:30"]);
  assert.deepEqual(entries.map((entry) => entry.title), ["manual-22", "직원 식대 · 9명", "manual-21"]);
  assert.match(page, /entry\.displayTime/);
  assert.match(page, /b\.sortTimestamp - a\.sortTimestamp/);
});

test("meal UI asks only for final amount and reason and refreshes original row", () => {
  assert.match(page, /confirmedMeal = entry\.drilldown === "meal"/);
  assert.match(page, /자동집계 원본/);
  assert.match(page, /수동 정정 합계/);
  assert.match(page, /현재 반영 금액/);
  assert.match(page, /최종 식대 금액/);
  assert.match(page, /수정 사유/);
  assert.match(page, /transactions\/\$\{entry\.transactionId\}\/meal-adjust/);
  assert.match(page, /entry\.transactionId === transactionId/);
  assert.match(page, /마감된 월의 거래는 일반 수정할 수 없습니다/);
  assert.doesNotMatch(page, /p_economic_delta|storeCashMovement.*input|sourceFingerprint.*input/);
});

test("expense summary and cash balance math match repeated meal adjustments", () => {
  const rows = [
    mealTransaction(),
    adjustment(11, 10, 30_000, 1),
    adjustment(12, 10, 60_000, -1),
  ];
  const expense = rows.reduce(
    (sum, row) => sum + Number(row.amount) * Number(row.economic_effect_sign ?? 1),
    0,
  );
  const cash = rows.flatMap((row) => row.movements ?? []).reduce(
    (sum, movement) => sum + Number(movement.amount),
    0,
  );
  assert.equal(expense, 240_000);
  assert.equal(cash, -240_000);
  assert.match(ledgerApi, /Number\(row\.amount\) \* Number\(row\.economic_effect_sign \?\? 1\)/);
  assert.match(ledgerApi, /balanceByAccount[\s\S]*Number\(row\.amount\)/);
});
