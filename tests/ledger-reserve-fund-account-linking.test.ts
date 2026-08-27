import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
// @ts-expect-error Node direct TS tests use explicit extension.
import { isReserveEligibleFundAccount, reserveShortfall, reserveCurrentAmount } from "../lib/ledger/reserve-balances.ts";

const reservesApi = readFileSync("app/api/admin/ledger/reserves/route.ts", "utf8");
const reserveIdApi = readFileSync("app/api/admin/ledger/reserves/[id]/route.ts", "utf8");
const reserveEntryApi = readFileSync("app/api/admin/ledger/reserves/[id]/entries/route.ts", "utf8");
const settings = readFileSync("app/(protected)/admin/ledger/settings/page.tsx", "utf8");

test("eligible fund account mirrors the DB guard rule", () => {
  assert.equal(isReserveEligibleFundAccount({ type: "bank", code: "baba_corporate_bank", is_active: true, is_business_fund: true }), true);
  assert.equal(isReserveEligibleFundAccount({ type: "cash", code: "store_cash", is_active: true, is_business_fund: true }), true);
  assert.equal(isReserveEligibleFundAccount({ type: "personal_custody", code: "cho_personal_custody", is_active: true, is_business_fund: true }), true);
  assert.equal(isReserveEligibleFundAccount({ type: "card_clearing", code: "card_clearing", is_active: true, is_business_fund: false }), false);
  assert.equal(isReserveEligibleFundAccount({ type: "bank", code: "x", is_active: false, is_business_fund: true }), false);
  assert.equal(isReserveEligibleFundAccount({ type: "bank", code: "x", is_active: true, is_business_fund: false }), false);
  assert.equal(isReserveEligibleFundAccount({ type: "other", code: "x", is_active: true, is_business_fund: true }), false);
});

test("linking an account or raising a target never creates reserved money", () => {
  // A freshly linked plan (no entries) still reads 0 reserved and target as the shortfall.
  assert.equal(reserveCurrentAmount([]), 0);
  assert.equal(reserveShortfall(720_000_000, 0), 720_000_000);
  assert.equal(reserveShortfall(720_000_000, 720_000_000), 0);
  assert.equal(reserveShortfall(100, 250), 0);
});

test("reserves GET returns linked account identity and eligible account list", () => {
  assert.match(reservesApi, /display_name/);
  assert.match(reservesApi, /fundAccount/);
  assert.match(reservesApi, /eligibleAccounts/);
  assert.match(reservesApi, /isReserveEligibleFundAccount/);
  // earmark math preserved
  assert.match(reservesApi, /Math\.max\(0, targetAmount - currentAmount\)/);
  assert.match(reservesApi, /freeCash: liquidFunds - activeReserve/);
  assert.match(reservesApi, /account\.code !== "card_clearing"/);
});

test("reserves GET performs no allocate / RPC write when reading plans", () => {
  const get = reservesApi.slice(reservesApi.indexOf("export async function GET"), reservesApi.indexOf("export async function POST"));
  assert.doesNotMatch(get, /ledger_create_reserve_entry_v1/);
  assert.doesNotMatch(get, /\.rpc\(/);
});

test("plan create / update go through the existing v2 RPCs with the fund-account param", () => {
  assert.match(reservesApi, /ledger_create_reserve_plan_v2/);
  assert.match(reservesApi, /p_fund_account_id: body\.fundAccountId/);
  assert.match(reserveIdApi, /ledger_update_reserve_plan_v2/);
  assert.match(reserveIdApi, /p_fund_account_id/);
});

test("reserve entry route uses only ledger_create_reserve_entry_v1", () => {
  assert.match(reserveEntryApi, /ledger_create_reserve_entry_v1/);
  assert.doesNotMatch(reserveEntryApi, /from\("ledger_reserve_/);
  assert.doesNotMatch(reserveEntryApi, /ledger_movements/);
  assert.doesNotMatch(reserveEntryApi, /ledger_transactions/);
});

test("no reserve route writes tables directly or books profit transactions", () => {
  for (const src of [reservesApi, reserveIdApi, reserveEntryApi]) {
    assert.doesNotMatch(src, /\.insert\(/);
    assert.doesNotMatch(src, /\.update\(/);
    assert.doesNotMatch(src, /\.delete\(/);
    assert.doesNotMatch(src, /ledger_create_manual_transaction/);
    assert.doesNotMatch(src, /ledger_create_(prepaid|correction|payable)/);
  }
});

test("settings reserve UI: account picker, four entry types, RPC-only entry endpoint", () => {
  assert.match(settings, /연결 계좌/);
  for (const label of ["적립", "해제", "사용", "조정"]) assert.match(settings, new RegExp(label));
  assert.match(settings, /reserves\/\$\{[^}]+\}\/entries/);
  assert.match(settings, /entryType/);
});

test("settings reserve card exposes target, current and shortfall", () => {
  assert.match(settings, /목표 금액/);
  assert.match(settings, /현재 확보 금액/);
  assert.match(settings, /부족 금액/);
});

test("settings reserve history shows time / type / amount / memo", () => {
  for (const col of ["일시", "유형", "금액", "메모"]) assert.match(settings, new RegExp(col));
});

test("settings consume control states it is not a ledger expense", () => {
  assert.match(settings, /실제 장부 지출을 생성하는 기능이 아니/);
  assert.match(settings, /실제 비용 지급은 기존 장부 거래 흐름/);
});

test("settings never auto-allocates the target on create or link", () => {
  const createFn = settings.slice(settings.indexOf("async function createReserve"), settings.indexOf("async function createReserve") + 500);
  assert.doesNotMatch(createFn, /entryType|allocate|\/entries/);
  assert.match(settings, /목표 금액이 자동으로 적립되지 않습니다/);
});

test("settings guards fund-account change on a non-empty plan", () => {
  assert.match(settings, /accountLocked/);
  assert.match(settings, /row\.currentAmount !== 0/);
});
