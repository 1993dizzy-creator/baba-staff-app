import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
// @ts-expect-error Node direct TS tests use explicit extension.
import { isReserveRecurringActiveForMonth, reservePlannedRecurringAmount, reserveTargetReached, shouldGenerateReserveSchedule } from "../lib/ledger/reserve-recurring.ts";

const migration = readFileSync("supabase/migrations/202608280001_add_reserve_recurring_allocation.sql", "utf8");
const reservesApi = readFileSync("app/api/admin/ledger/reserves/route.ts", "utf8");
const recurringApi = readFileSync("app/api/admin/ledger/reserves/[id]/recurring/route.ts", "utf8");
const scheduleApi = readFileSync("app/api/admin/ledger/reserves/schedule/route.ts", "utf8");
const scheduleResolveApi = readFileSync("app/api/admin/ledger/reserves/schedule/[scheduleId]/route.ts", "utf8");
const cron = readFileSync("app/api/cron/ledger-reserve-schedule/route.ts", "utf8");
const vercelJson = readFileSync("vercel.json", "utf8");
const settings = readFileSync("app/(protected)/admin/ledger/settings/page.tsx", "utf8");

// ── pure helpers ────────────────────────────────────────────────────────────────
test("recurring window: active only from start month through optional end month", () => {
  const rule = { startMonth: "2026-08-01", endMonth: null };
  assert.equal(isReserveRecurringActiveForMonth(rule, "2026-07-01"), false);
  assert.equal(isReserveRecurringActiveForMonth(rule, "2026-08-01"), true);
  assert.equal(isReserveRecurringActiveForMonth(rule, "2027-05-01"), true);
  const bounded = { startMonth: "2026-08-01", endMonth: "2026-10-01" };
  assert.equal(isReserveRecurringActiveForMonth(bounded, "2026-10-01"), true);
  assert.equal(isReserveRecurringActiveForMonth(bounded, "2026-11-01"), false);
});

test("planned amount = monthly minus manual-this-month, capped to target room, never negative", () => {
  assert.equal(reservePlannedRecurringAmount({ monthlyAmount: 60_000_000, manualThisMonth: 0, targetAmount: 720_000_000, currentReserved: 0 }), 60_000_000);
  // partial manual: only the remainder
  assert.equal(reservePlannedRecurringAmount({ monthlyAmount: 60_000_000, manualThisMonth: 20_000_000, targetAmount: 720_000_000, currentReserved: 20_000_000 }), 40_000_000);
  // manual already >= monthly: nothing to schedule
  assert.equal(reservePlannedRecurringAmount({ monthlyAmount: 60_000_000, manualThisMonth: 60_000_000, targetAmount: 720_000_000, currentReserved: 60_000_000 }), 0);
  // near target: clamp to remaining room
  assert.equal(reservePlannedRecurringAmount({ monthlyAmount: 60_000_000, manualThisMonth: 0, targetAmount: 720_000_000, currentReserved: 700_000_000 }), 20_000_000);
});

test("target reached is inclusive", () => {
  assert.equal(reserveTargetReached(720_000_000, 719_999_999), false);
  assert.equal(reserveTargetReached(720_000_000, 720_000_000), true);
});

// ── cron vs manual generation gate (the reported contract fix) ───────────────────
const baseGen = {
  planActive: true,
  hasRecurringRule: true,
  autoGenerate: true,
  startMonth: "2026-08-01",
  endMonth: null as string | null,
  scheduledMonth: "2026-08-01",
  today: "2026-08-10",
  recurringDay: 1,
  currentReserved: 0,
  targetAmount: 720_000_000,
  liveOccurrenceExists: false,
};

test("autoGenerate OFF + manual request -> generates", () => {
  const r = shouldGenerateReserveSchedule({ ...baseGen, requireAutoGenerate: false, autoGenerate: false });
  assert.deepEqual(r, { generate: true, reason: "ok" });
});

test("autoGenerate OFF + cron -> does NOT generate", () => {
  const r = shouldGenerateReserveSchedule({ ...baseGen, requireAutoGenerate: true, autoGenerate: false });
  assert.deepEqual(r, { generate: false, reason: "auto_generate_off" });
});

test("autoGenerate ON + before due day + cron -> does NOT generate", () => {
  const r = shouldGenerateReserveSchedule({ ...baseGen, requireAutoGenerate: true, recurringDay: 15, today: "2026-08-10" });
  assert.deepEqual(r, { generate: false, reason: "not_due" });
});

test("autoGenerate ON + on/after due day + cron -> generates", () => {
  assert.deepEqual(
    shouldGenerateReserveSchedule({ ...baseGen, requireAutoGenerate: true, recurringDay: 15, today: "2026-08-15" }),
    { generate: true, reason: "ok" },
  );
  assert.deepEqual(
    shouldGenerateReserveSchedule({ ...baseGen, requireAutoGenerate: true, recurringDay: 15, today: "2026-08-28" }),
    { generate: true, reason: "ok" },
  );
});

test("manual request ignores the due day (generates before recurringDay)", () => {
  const r = shouldGenerateReserveSchedule({ ...baseGen, requireAutoGenerate: false, autoGenerate: false, recurringDay: 28, today: "2026-08-03" });
  assert.deepEqual(r, { generate: true, reason: "ok" });
});

test("no duplicate: an existing live occurrence blocks both cron and manual", () => {
  assert.equal(shouldGenerateReserveSchedule({ ...baseGen, requireAutoGenerate: true, liveOccurrenceExists: true }).reason, "already_exists");
  assert.equal(shouldGenerateReserveSchedule({ ...baseGen, requireAutoGenerate: false, autoGenerate: false, liveOccurrenceExists: true }).reason, "already_exists");
});

test("out-of-window and target-reached stop generation for cron and manual alike", () => {
  assert.equal(shouldGenerateReserveSchedule({ ...baseGen, requireAutoGenerate: false, autoGenerate: false, scheduledMonth: "2026-07-01" }).reason, "out_of_window");
  assert.equal(shouldGenerateReserveSchedule({ ...baseGen, requireAutoGenerate: false, autoGenerate: false, currentReserved: 720_000_000 }).reason, "target_reached");
});

// ── migration shape ─────────────────────────────────────────────────────────────
test("plan gets the monthly rule columns and no auto-confirm / frequency column", () => {
  assert.match(migration, /add column recurring_monthly_amount numeric\(16, 3\) null/);
  assert.match(migration, /add column recurring_day smallint null/);
  assert.match(migration, /add column recurring_start_month date null/);
  assert.match(migration, /add column recurring_end_month date null/);
  assert.match(migration, /add column recurring_auto_generate boolean not null default false/);
  assert.doesNotMatch(migration, /recurring_auto_confirm/);
  assert.doesNotMatch(migration, /add column recurring_frequency|recurring_frequency text/);
});

test("rule columns are all-or-nothing and the period is ordered", () => {
  assert.match(migration, /ledger_reserve_plans_recurring_complete check/);
  assert.match(migration, /ledger_reserve_plans_recurring_period check[\s\S]*recurring_end_month >= recurring_start_month/);
});

test("schedule table: one live row per plan-month, expense-shaped resolution states, RPC-write-only", () => {
  assert.match(migration, /create table public\.ledger_reserve_scheduled_allocations/);
  assert.match(migration, /create unique index ledger_reserve_sched_live_unique[\s\S]*\(reserve_plan_id, scheduled_month\)[\s\S]*where status <> 'superseded'/);
  assert.match(migration, /status in \('pending', 'confirmed', 'skipped', 'superseded'\)/);
  assert.match(migration, /reserve_entry_id bigint null references public\.ledger_reserve_entries\(id\)/);
  assert.match(migration, /revoke all on table public\.ledger_reserve_scheduled_allocations[\s\S]*from public, anon, authenticated, service_role/);
  assert.match(migration, /grant select on table public\.ledger_reserve_scheduled_allocations to service_role/);
  assert.doesNotMatch(migration, /grant (?:insert|update|delete|all)[\s\S]*ledger_reserve_scheduled_allocations/i);
});

test("confirm reuses ledger_create_reserve_entry_v1 and books no transaction / movement", () => {
  assert.match(migration, /create function public\.ledger_confirm_reserve_schedule_v1\(\s*p_schedule_id bigint,\s*p_actor_user_id bigint\s*\)/);
  assert.match(migration, /v_entry := public\.ledger_create_reserve_entry_v1\(\s*v_plan\.id, 'allocate', v_amount, now\(\)/);
  assert.doesNotMatch(migration, /insert into public\.ledger_transactions/i);
  assert.doesNotMatch(migration, /insert into public\.ledger_movements/i);
  // closed month => book the allocate now, never backdate into a closed month
  assert.match(migration, /if public\.ledger_month_is_closed_v1\(v_now_month\) then\s*return jsonb_build_object\('status', 'current_month_closed'\)/);
  assert.match(migration, /'allocate', v_amount, now\(\)/);
});

test("confirm clamps to target room and to monthly-minus-manual", () => {
  assert.match(migration, /v_target_room := v_plan\.target_amount - v_current;/);
  assert.match(migration, /if v_target_room <= 0 then[\s\S]*'status', 'target_reached'/);
  assert.match(migration, /v_monthly_room := coalesce\(v_monthly, v_occ\.planned_amount\) - v_manual;/);
  assert.match(migration, /v_amount := least\(v_occ\.planned_amount, v_target_room, greatest\(v_monthly_room, 0\)\)/);
  assert.match(migration, /'status', 'already_fulfilled'/);
});

test("generate: dedup, target stop, not-yet-due, manual-net, month bounds", () => {
  assert.match(migration, /create function public\.ledger_generate_reserve_schedule_v1\(\s*p_month date,\s*p_require_auto_generate boolean,\s*p_actor_user_id bigint\s*\)/);
  assert.match(migration, /recurring_start_month <= p_month\s*and \(recurring_end_month is null or recurring_end_month >= p_month\)/);
  assert.match(migration, /if public\.ledger_month_is_closed_v1\(p_month\) then\s*return jsonb_build_object\('status', 'month_closed'\)/);
  assert.match(migration, /extract\(day from v_today\)::int < v_plan\.recurring_day/);
  assert.match(migration, /where reserve_plan_id = v_plan\.id and scheduled_month = p_month and status <> 'superseded'/);
  assert.match(migration, /if v_current >= v_plan\.target_amount then\s*v_skipped_target/);
  assert.match(migration, /entry\.entry_type = 'allocate'[\s\S]*not exists \([\s\S]*sched\.reserve_entry_id = entry\.id/);
  assert.match(migration, /v_planned := least\(\s*v_plan\.recurring_monthly_amount - v_manual,\s*v_plan\.target_amount - v_current\s*\)/);
});

test("auto-generate is a cron-only filter; manual (p_require_auto_generate=false) bypasses it and the due day", () => {
  // plan selection: auto_generate only enforced when the flag is true
  assert.match(migration, /coalesce\(p_require_auto_generate, true\) = false or recurring_auto_generate = true/);
  // due-day gate: only for the cron
  assert.match(migration, /if coalesce\(p_require_auto_generate, true\) = true\s*and p_month = date_trunc\('month', v_today\)::date\s*and extract\(day from v_today\)::int < v_plan\.recurring_day/);
  // dedup + advisory lock + target-stop apply regardless of mode
  assert.match(migration, /pg_advisory_xact_lock\(\s*hashtext\('ledger_reserve_schedule:'/);
  assert.match(migration, /'mode', case when coalesce\(p_require_auto_generate, true\) then 'cron' else 'manual' end/);
});

test("enabling auto-generate requires a reserve-eligible fund account", () => {
  const setFn = migration.slice(
    migration.indexOf("create function public.ledger_set_reserve_recurring_v1"),
    migration.indexOf("create function public.ledger_generate_reserve_schedule_v1"),
  );
  assert.match(setFn, /coalesce\(p_auto_generate, false\) = true and not exists \([\s\S]*account\.id = v_before\.fund_account_id\s*and account\.is_active = true\s*and account\.is_business_fund = true\s*and account\.type in \('cash', 'bank', 'personal_custody'\)\s*and account\.code <> 'card_clearing'/);
  assert.match(setFn, /'status', 'auto_generate_requires_fund_account'/);
});

test("all four new RPCs are owner/master + service_role only", () => {
  for (const fn of [
    "ledger_set_reserve_recurring_v1",
    "ledger_generate_reserve_schedule_v1",
    "ledger_confirm_reserve_schedule_v1",
    "ledger_skip_reserve_schedule_v1",
  ]) {
    assert.match(migration, new RegExp(`create function public\\.${fn}[\\s\\S]*?security definer`));
    assert.match(migration, new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\)\\s*from public, anon, authenticated`));
    assert.match(migration, new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\)\\s*to service_role`));
  }
  assert.match(migration, /not in \('owner', 'master'\)/);
});

// ── API ─────────────────────────────────────────────────────────────────────────
test("reserves GET surfaces recurring rule, pending schedule and target-reached", () => {
  assert.match(reservesApi, /recurring_monthly_amount,recurring_day,recurring_start_month,recurring_end_month,recurring_auto_generate/);
  assert.match(reservesApi, /from\("ledger_reserve_scheduled_allocations"\)/);
  assert.match(reservesApi, /pendingSchedule/);
  assert.match(reservesApi, /targetReached = currentAmount >= targetAmount/);
  // GET stays read-only
  const get = reservesApi.slice(reservesApi.indexOf("export async function GET"), reservesApi.indexOf("export async function POST"));
  assert.doesNotMatch(get, /\.rpc\(/);
  assert.doesNotMatch(get, /\.insert\(|\.update\(|\.delete\(/);
});

test("recurring route -> ledger_set_reserve_recurring_v1, clears when monthlyAmount null", () => {
  assert.match(recurringApi, /ledger_set_reserve_recurring_v1/);
  assert.match(recurringApi, /const clear = body\.monthlyAmount == null/);
  assert.match(recurringApi, /p_auto_generate: clear \? false : Boolean\(body\.autoGenerate\)/);
  assert.doesNotMatch(recurringApi, /ledger_create_manual_transaction|ledger_movements|ledger_transactions/);
});

test("schedule routes -> generate / confirm / skip RPCs only", () => {
  assert.match(scheduleApi, /ledger_generate_reserve_schedule_v1/);
  // manual trigger: NOT auto-generate-gated
  assert.match(scheduleApi, /p_require_auto_generate: false/);
  assert.match(scheduleResolveApi, /ledger_confirm_reserve_schedule_v1/);
  assert.match(scheduleResolveApi, /ledger_skip_reserve_schedule_v1/);
  assert.match(scheduleResolveApi, /action !== "confirm" && action !== "skip"/);
  for (const src of [scheduleApi, scheduleResolveApi]) {
    assert.doesNotMatch(src, /\.insert\(|\.update\(|\.delete\(/);
  }
});

// ── cron ────────────────────────────────────────────────────────────────────────
test("cron: authorized, generation-only, daily after Vietnam 03:00, isolated failure", () => {
  assert.match(cron, /authorizeCron\(req\)/);
  assert.match(cron, /ledger_generate_reserve_schedule_v1/);
  // cron: auto-generate-gated
  assert.match(cron, /p_require_auto_generate: true/);
  assert.doesNotMatch(cron, /ledger_create_reserve_entry_v1|ledger_confirm_reserve_schedule|ledger_skip_reserve_schedule/);
  assert.match(cron, /Asia\/Ho_Chi_Minh/);
  // every throw is inside the try; the handler returns a 500 JSON instead of propagating
  assert.match(cron, /try \{[\s\S]*\} catch \(error\) \{[\s\S]*LEDGER_RESERVE_SCHEDULE_CRON_FAILED[\s\S]*status: 500[\s\S]*\}\s*\}\s*$/);
  assert.doesNotMatch(cron.slice(cron.indexOf("} catch")), /\bthrow\b/);
  // 20:17 UTC == 03:17 ICT, daily
  assert.match(vercelJson, /"path": "\/api\/cron\/ledger-reserve-schedule",\s*"schedule": "17 20 \* \* \*"/);
});

// ── UI ──────────────────────────────────────────────────────────────────────────
test("settings recurring UI: amount / day / start / end / auto-generate + confirm & skip", () => {
  assert.match(settings, /정기 적립 설정/);
  assert.match(settings, /월 적립액/);
  assert.match(settings, /매월 적립일/);
  assert.match(settings, /시작월/);
  assert.match(settings, /종료월\(선택\)/);
  assert.match(settings, /자동 예정 생성/);
  assert.match(settings, /reserves\/\$\{[^}]+\}\/recurring/);
  assert.match(settings, /reserves\/schedule\/\$\{scheduleId\}/);
  assert.match(settings, /action: "confirm"/);
  assert.match(settings, /action: "skip"/);
  assert.match(settings, /목표 금액을 달성하여 신규 정기 적립 예정이 생성되지 않습니다/);
  assert.match(settings, /적립 예정 ·/);
  // manual generation works with auto-generate off; hint + eligible-account warning
  assert.match(settings, /자동 예정 생성이 꺼져 있어도 .*이번 달 예정 생성.* 버튼으로 수동 생성할 수 있습니다/);
  assert.match(settings, /자동 예정 생성은 연결 계좌가 필요합니다/);
  assert.match(settings, /recAuto && !row\.fundAccount/);
});

test("settings never auto-confirms and never books a ledger transaction/movement", () => {
  assert.doesNotMatch(settings, /autoConfirm|auto_confirm/);
  assert.doesNotMatch(settings, /ledger_movements|ledger_transactions|ledger_create_manual_transaction/);
});
