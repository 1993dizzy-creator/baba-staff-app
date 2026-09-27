import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  ownerInvestmentCashEventErrorStatus,
  parseOwnerInvestmentCashEventInput,
} from "./investment-cash-event.ts";

const migration = readFileSync("supabase/migrations/20260927122430_add_owner_investment_cash_event.sql", "utf8");
const route = readFileSync("app/api/admin/ledger/investments/route.ts", "utf8");

test("investment API accepts strict positive contribution and recovery payloads", () => {
  for (const action of ["contribution", "recovery"] as const) {
    assert.deepEqual(parseOwnerInvestmentCashEventInput({
      participantId: 2,
      action,
      amount: 1_000_000,
      occurredAt: "2026-09-27T12:00:00+07:00",
      fundAccountId: 3,
      reason: "자금 조정",
      memo: "원문 메모",
    })?.action, action);
  }
  assert.equal(parseOwnerInvestmentCashEventInput({ participantId: 2, action: "recovery", amount: -1 }), null);
  assert.equal(parseOwnerInvestmentCashEventInput({ participantId: 2, action: "recovery", amount: 1, extra: true }), null);
  assert.equal(ownerInvestmentCashEventErrorStatus("closed_month"), 409);
});

test("POST calls only the atomic cash-event RPC with actor-derived authority", () => {
  assert.match(route, /export async function POST/);
  assert.match(route, /ledger_create_owner_investment_cash_event_v1/);
  assert.match(route, /p_actor_user_id: auth\.actor\.id/);
  assert.doesNotMatch(route, /ledger_create_owner_investment_v1/);
  assert.doesNotMatch(route, /fetch\("\/api\/admin\/ledger"/);
});

test("RPC stores contribution and recovery principal plus opposite fund movements atomically", () => {
  assert.match(migration, /create or replace function public\.ledger_create_owner_investment_cash_event_v1/);
  assert.match(migration, /v_signed_amount := case when p_action = 'contribution' then p_amount else -p_amount end/);
  assert.match(migration, /v_transaction_type := case when p_action = 'contribution' then 'investment' else 'owner_settlement_payment' end/);
  assert.match(migration, /insert into public\.ledger_movements[\s\S]*case when p_action = 'contribution' then p_amount else -p_amount end/);
  assert.match(migration, /insert into public\.ledger_owner_investments[\s\S]*v_signed_amount[\s\S]*v_transaction_id/);
  assert.doesNotMatch(migration, /recognition_month/);
});

test("RPC protects cumulative capital, obligations, month, account, and all-or-nothing execution", () => {
  assert.match(migration, /pg_advisory_xact_lock[\s\S]*ledger_owner_capital_recovery/);
  assert.match(migration, /v_new_investment < 0[\s\S]*negative_cumulative_investment/);
  assert.match(migration, /v_new_investment < v_recovery_allocated[\s\S]*investment_below_recovery_obligation/);
  assert.match(migration, /ledger_month_is_closed_v1[\s\S]*closed_month/);
  assert.match(migration, /is_active and a\.is_business_fund[\s\S]*invalid_fund_account/);
  assert.match(migration, /security definer[\s\S]*set search_path = ''/);
  assert.equal((migration.match(/create or replace function public\.ledger_create_owner_investment_cash_event_v1/g) ?? []).length, 1);
  assert.doesNotMatch(route, /\.from\("ledger_owner_investments"\).*\.insert/);
  assert.doesNotMatch(route, /\.from\("ledger_movements"\).*\.insert/);
});
