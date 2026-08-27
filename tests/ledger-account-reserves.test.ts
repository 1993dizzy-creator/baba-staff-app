import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
// @ts-expect-error Node direct TS tests use explicit extension.
import { reserveCurrentAmount, reservesByFundAccount } from "../lib/ledger/reserve-balances.ts";

const migration = readFileSync("supabase/migrations/202608270001_link_reserve_plans_to_fund_accounts.sql", "utf8");
const reserveFoundation = readFileSync("supabase/migrations/202608210007_add_recurring_reserves_bep.sql", "utf8");
const ledgerApi = readFileSync("app/api/admin/ledger/route.ts", "utf8");
const reserveApi = readFileSync("app/api/admin/ledger/reserves/route.ts", "utf8");
const page = readFileSync("app/(protected)/admin/ledger/entries/page.tsx", "utf8");

test("reserve entry signs preserve allocate, release, consume and adjustment semantics", () => {
  assert.equal(reserveCurrentAmount([
    { entry_type: "allocate", amount: 100 },
    { entry_type: "release", amount: 20 },
    { entry_type: "consume", amount: 10 },
    { entry_type: "adjustment", amount: -5 },
  ]), 65);
});

test("multiple active reserve plans aggregate under one fund account", () => {
  const grouped = reservesByFundAccount([
    { id: 1, name: "rent", fund_account_id: 7, linked_recurring_plan: [{ source_key_prefix: "rent" }], entries: [{ entry_type: "allocate", amount: 60 }] },
    { id: 2, name: "other", fund_account_id: 7, entries: [{ entry_type: "allocate", amount: 25 }] },
    { id: 3, name: "unlinked", fund_account_id: null, entries: [{ entry_type: "allocate", amount: 999 }] },
  ]);
  const reserves = grouped.get(7) ?? [];
  assert.equal(reserves.reduce((sum, reserve) => sum + reserve.currentAmount, 0), 85);
  assert.equal(reserves[0].linkedRecurringSourceKeyPrefix, "rent");
  assert.equal(grouped.size, 1);
});

test("inactive plans with residual balances remain visible as a defensive accounting fallback", () => {
  const grouped = reservesByFundAccount([
    { id: 1, name: "residual", is_active: false, fund_account_id: 7, entries: [{ entry_type: "allocate", amount: 30 }] },
    { id: 2, name: "empty", is_active: false, fund_account_id: 7, entries: [] },
  ]);
  assert.deepEqual(grouped.get(7)?.map((reserve) => reserve.name), ["residual"]);
});

test("zero reserve leaves available balance equal to gross account balance", () => {
  const grossBalance = 295_387_555;
  const reserves = reservesByFundAccount([{ id: 1, name: "rent", fund_account_id: 7, entries: [] }]).get(7) ?? [];
  const reserveTotal = reserves.reduce((sum, reserve) => sum + reserve.currentAmount, 0);
  assert.equal(grossBalance - reserveTotal, grossBalance);
});

test("migration adds a nullable restricted FK without backfilling production data", () => {
  const preflightIndex = migration.indexOf("do $$");
  const firstDdlIndex = migration.indexOf("alter table public.ledger_reserve_plans");
  assert.equal(preflightIndex, 0);
  assert.ok(firstDdlIndex > preflightIndex);
  assert.match(migration, /add column fund_account_id bigint null/);
  assert.match(migration, /references public\.ledger_fund_accounts\(id\)[\s\S]*on delete restrict/);
  assert.match(migration, /is_active = true[\s\S]*is_business_fund = true/);
  assert.doesNotMatch(migration, /update public\.ledger_reserve_plans[\s\S]*set fund_account_id\s*=\s*\(select/i);
  const entryRpcIndex = migration.indexOf(
    "create or replace function public.ledger_create_reserve_entry_v1",
  );
  assert.ok(entryRpcIndex > 0);
  assert.doesNotMatch(
    migration.slice(0, entryRpcIndex),
    /insert into public\.ledger_reserve_entries/i,
  );
});

test("v2 reserve RPCs preserve owner/master and service-role-only access", () => {
  assert.match(migration, /not in \('owner', 'master'\)/);
  assert.match(migration, /security definer/);
  assert.match(migration, /revoke all on function public\.ledger_create_reserve_plan_v2[\s\S]*from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.ledger_update_reserve_plan_v2[\s\S]*to service_role/);
  assert.match(migration, /create function public\.ledger_create_reserve_plan_v2\(\s*p_name text,\s*p_target_amount numeric,\s*p_target_date date,\s*p_linked_plan_id bigint,\s*p_fund_account_id bigint,\s*p_memo text,\s*p_actor_user_id bigint\s*\) returns jsonb[\s\S]*?security definer\s*set search_path = pg_catalog, public/);
  assert.match(migration, /create function public\.ledger_update_reserve_plan_v2\(\s*p_reserve_plan_id bigint,\s*p_target_amount numeric,\s*p_target_date date,\s*p_fund_account_id bigint,\s*p_memo text,\s*p_actor_user_id bigint\s*\) returns jsonb[\s\S]*?security definer\s*set search_path = pg_catalog, public/);
  assert.match(migration, /create or replace function public\.ledger_create_reserve_entry_v1\(\s*p_reserve_plan_id bigint,\s*p_entry_type text,\s*p_amount numeric,\s*p_occurred_at timestamptz,\s*p_memo text,\s*p_actor_user_id bigint\s*\) returns jsonb[\s\S]*?security definer\s*set search_path = pg_catalog, public/);
});

test("reserve plan v2 target amounts reject null through the invalid-input contract", () => {
  const createStart = migration.indexOf("create function public.ledger_create_reserve_plan_v2");
  const updateStart = migration.indexOf("create function public.ledger_update_reserve_plan_v2");
  const entryStart = migration.indexOf("create or replace function public.ledger_create_reserve_entry_v1");
  const createRpc = migration.slice(createStart, updateStart);
  const updateRpc = migration.slice(updateStart, entryStart);
  assert.match(createRpc, /p_target_amount is null[\s\S]*p_target_amount <= 0[\s\S]*scale\(p_target_amount\) > 3[\s\S]*'status', 'invalid_input'/);
  assert.match(updateRpc, /p_target_amount is null[\s\S]*p_target_amount <= 0[\s\S]*scale\(p_target_amount\) > 3[\s\S]*'status', 'invalid_input'/);
});

test("positive linked reserve changes revalidate current fund-account eligibility", () => {
  const entryStart = migration.indexOf("create or replace function public.ledger_create_reserve_entry_v1");
  const entryEnd = migration.indexOf("revoke all on function", entryStart);
  const entryRpc = migration.slice(entryStart, entryEnd);
  const lockIndex = entryRpc.indexOf("pg_advisory_xact_lock");
  const eligibilityIndex = entryRpc.indexOf("v_delta > 0 and not exists");
  const currentIndex = entryRpc.indexOf("into v_current");
  assert.ok(lockIndex >= 0 && eligibilityIndex > lockIndex && currentIndex > eligibilityIndex);
  assert.match(entryRpc, /account\.id = v_plan\.fund_account_id\s+and account\.is_active = true\s+and account\.is_business_fund = true\s+and account\.type in \('cash', 'bank', 'personal_custody'\)\s+and account\.code <> 'card_clearing'/);
  assert.match(entryRpc, /v_delta > 0 and not exists[\s\S]*return jsonb_build_object\('status', 'invalid_fund_account'\)/);
});

test("inactive or otherwise ineligible accounts block increases but allow reserve cleanup", () => {
  const delta = (entryType: string, amount: number) => entryType === "allocate"
    ? amount
    : entryType === "release" || entryType === "consume"
      ? -amount
      : amount;
  assert.ok(delta("allocate", 1) > 0);
  assert.ok(delta("adjustment", 1) > 0);
  assert.ok(delta("release", 1) < 0);
  assert.ok(delta("consume", 1) < 0);
  assert.ok(delta("adjustment", -1) < 0);
  assert.match(migration, /if v_plan\.fund_account_id is not null and v_delta > 0 and not exists/);
});

test("reserve tables remain RPC-write-only for application roles", () => {
  assert.match(reserveFoundation, /revoke all on table[\s\S]*public\.ledger_reserve_plans,public\.ledger_reserve_entries from public,anon,authenticated,service_role/);
  assert.match(reserveFoundation, /grant select on table[\s\S]*public\.ledger_reserve_plans,public\.ledger_reserve_entries to service_role/);
  assert.doesNotMatch(migration, /grant (?:insert|update|delete|all)[\s\S]*ledger_reserve_(?:plans|entries)/i);
});

test("zero-balance plans may change accounts, including the initial null-to-account link", () => {
  assert.match(migration, /p_fund_account_id is distinct from v_before\.fund_account_id and v_current <> 0/);
  assert.doesNotMatch(migration, /p_fund_account_id is distinct from v_before\.fund_account_id and v_current = 0/);
});

test("non-empty plans cannot change from account A to B or from A to null", () => {
  assert.match(migration, /new\.fund_account_id is distinct from old\.fund_account_id and v_current <> 0[\s\S]*non-empty reserve plan cannot change fund account/);
  assert.match(migration, /'status', 'reserve_not_empty', 'currentAmount', v_current/);
});

test("non-empty plans cannot deactivate while zero-balance plans can", () => {
  assert.match(migration, /old\.is_active = true and new\.is_active = false and v_current <> 0/);
  assert.match(migration, /before insert or update of fund_account_id, is_active/);
  assert.match(migration, /inactive reserve plan has a non-zero balance/);
});

test("linked allocations are allowed only within gross available account balance", () => {
  assert.ok(60 + 30 <= 100);
  assert.ok(!(60 + 50 <= 100));
  assert.match(migration, /v_reserved_total \+ v_delta > v_gross_balance/);
  assert.match(migration, /'status', 'insufficient_fund_balance'/);
});

test("all reserve plans on the same account participate in the allocation ceiling", () => {
  assert.match(migration, /where plan\.fund_account_id = v_plan\.fund_account_id/);
  assert.doesNotMatch(migration, /where plan\.id = p_reserve_plan_id[\s\S]*into v_reserved_total/);
});

test("release, consume and negative adjustments bypass the increase ceiling", () => {
  assert.match(migration, /when 'release' then -p_amount/);
  assert.match(migration, /when 'consume' then -p_amount/);
  assert.match(migration, /if v_plan\.fund_account_id is not null and v_delta > 0 then/);
});

test("positive adjustments use the same linked-account ceiling", () => {
  assert.match(migration, /else p_amount[\s\S]*v_delta > 0[\s\S]*v_reserved_total \+ v_delta > v_gross_balance/);
});

test("unlinked legacy reserve plans keep the original balance-only behavior", () => {
  assert.match(migration, /if v_plan\.fund_account_id is not null and v_delta > 0 then/);
  assert.match(migration, /if v_current \+ v_delta < 0 then/);
  assert.match(migration, /'status', 'insufficient_reserve'/);
});

test("same-account concurrent allocations serialize before recomputing totals", () => {
  const lockIndex = migration.indexOf("pg_advisory_xact_lock(hashtext('ledger_reserve_fund:'");
  const totalIndex = migration.indexOf("into v_reserved_total", lockIndex);
  assert.ok(lockIndex >= 0);
  assert.ok(totalIndex > lockIndex);
});

test("earmarks affect only available balance and never gross movement balance", () => {
  assert.match(ledgerApi, /const balance = balanceByAccount\.get/);
  assert.match(ledgerApi, /availableBalance: balance - reserveTotal/);
  assert.doesNotMatch(migration, /insert into public\.ledger_movements/i);
  assert.match(reserveApi, /reserveCurrentAmount/);
  assert.match(migration, /ledger_transaction\.status = 'confirmed'/);
  assert.match(migration, /ledger_transaction\.occurred_at <= now\(\)/);
});

test("corporate account UI exposes localized reserve and available balances", () => {
  for (const label of ["준비금 합계", "사용 가능 잔액", "Tổng quỹ dự phòng", "Số dư khả dụng", "Quỹ dự phòng tiền thuê"]) {
    assert.match(page, new RegExp(label));
  }
});
