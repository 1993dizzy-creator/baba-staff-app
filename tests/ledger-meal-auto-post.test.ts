import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
// @ts-expect-error Node strips TypeScript extensions in tests.
import { calculateCurrentMealAllowanceCost } from "../lib/payroll/meal-allowance.ts";
// @ts-expect-error Node strips TypeScript extensions in tests.
import { previousVietnamBusinessDate, selectMealSyncActor, syncConfirmedMealSource } from "../lib/ledger/meal-late-source-sync.ts";

const route = readFileSync("app/api/cron/ledger-meal-auto-post/route.ts", "utf8");
const lateRoute = readFileSync("app/api/cron/ledger-meal-source-sync/route.ts", "utf8");
const source = readFileSync("lib/ledger/employee-costs.ts", "utf8");
const memoBackfill = readFileSync("supabase/migrations/20260826123527_shorten_employee_meal_memos.sql", "utf8");
const vercel = JSON.parse(readFileSync("vercel.json", "utf8"));

const datedMealInput = {
  attendanceDays: Array.from({ length: 9 }, (_, index) => ({
    userId: index + 1,
    workDate: "2026-08-26",
  })),
  users: new Map(
    Array.from({ length: 9 }, (_, index) => [
      index + 1,
      { hireDate: null, terminationDate: null },
    ])
  ),
  eligibilityVersionsByUser: new Map(
    Array.from({ length: 9 }, (_, index) => [
      index + 1,
      [
        { id: index + 1, userId: index + 1, isEligible: false, effectiveFrom: "2026-08-01", revision: 1 },
        { id: index + 11, userId: index + 1, isEligible: true, effectiveFrom: "2026-08-20", revision: 2 },
      ],
    ])
  ),
  policyVersions: [
    { id: 1, dailyAmount: 20_000, effectiveFrom: "2026-08-01", revision: 1 },
    { id: 2, dailyAmount: 30_000, effectiveFrom: "2026-08-25", revision: 2 },
  ],
};

test("meal auto-post cron uses configured business date with legacy fallback", () => {
  assert.match(route, /loadBusinessTimeAdapter\(new Date\(\)\)/);
  assert.match(route, /databaseBusinessDate/);
  assert.match(route, /return getBusinessDate\(\)/);
});

test("meal auto-post syncs only today's active non-zero row", () => {
  assert.match(route, /loadMealCandidateSource\(businessDate\.slice\(0, 7\)\)/);
  assert.match(route, /find\(\(item\) => item\.businessDate === businessDate\)/);
  assert.match(route, /!row \|\| !row\.active \|\| row\.amount <= 0/);
  assert.match(route, /p_rows: \[row\]/);
});

test("effective-dated eligibility and price produce 9 x 30,000 = 270,000", () => {
  assert.equal(calculateCurrentMealAllowanceCost(datedMealInput).totalAmount, 270_000);
});

test("duplicate attendance for one employee is counted once by the ledger source", () => {
  assert.match(source, /key=`\$\{userId\}:\$\{date\}`/);
  assert.match(source, /if\(seen\.has\(key\)\)continue;seen\.add\(key\)/);
});

test("18:00 auto-post remains idempotent when a candidate is already confirmed", () => {
  const confirmed = route.indexOf('existing?.status === "confirmed"');
  const sync = route.indexOf('"ledger_sync_candidates_v2"');
  assert.ok(confirmed >= 0 && sync > confirmed);
  assert.match(route, /Never feed later attendance or policy[\s\S]*managers correct the ledger manually/);
});

test("02:50 Vietnam late source sync records changed attendance without posting an expense", async () => {
  assert.equal(previousVietnamBusinessDate(new Date("2026-09-02T19:50:00Z")), "2026-09-02");
  const transaction = { id: 7001, amount: 270_000 };
  const candidate = { status: "confirmed", sourceKey: "meal:2026-09-02", sourceDriftSnapshot: null as Record<string, unknown> | null };
  let syncCalls = 0;
  const result = await syncConfirmedMealSource({
    month: "2026-09", latestBusinessDate: "2026-09-02",
    candidates: [candidate, { status: "confirmed", sourceKey: "meal:2026-09-01" }],
    loadRows: async () => [
      { businessDate: "2026-09-01", sourceKey: "meal:2026-09-01", amount: 300_000,
        active: true, snapshot: { total_amount: 300_000 }, fingerprint: "b".repeat(64), categoryId: 5 },
      { businessDate: "2026-09-02", sourceKey: candidate.sourceKey,
        amount: 330_000, active: true, snapshot: { total_amount: 330_000, employee_count: 11 },
        fingerprint: "a".repeat(64), categoryId: 5 },
    ],
    syncRows: async (rows) => {
      syncCalls++;
      candidate.sourceDriftSnapshot = rows[1].snapshot;
      return { status: "ok", driftCount: 1 };
    },
  });
  assert.deepEqual(result, { status: "synced", scannedCount: 2, driftCount: 1 });
  assert.equal(syncCalls, 1);
  assert.deepEqual(transaction, { id: 7001, amount: 270_000 });
  assert.equal(candidate.sourceDriftSnapshot?.total_amount, 330_000);
  assert.doesNotMatch(lateRoute, /ledger_resolve_candidate_v2|ledger_adjust_open_meal_transaction_v1|ledger_create_correction_v1/);
  assert.match(lateRoute, /authorizeCron\(request\)/);
  assert.match(lateRoute, /ledger_sync_candidates_v2/);
});

test("late source sync skips unconfirmed days and never creates a second candidate", async () => {
  let loads = 0;
  let syncs = 0;
  const result = await syncConfirmedMealSource({
    month: "2026-09", latestBusinessDate: "2026-09-02",
    candidates: [{ status: "pending", sourceKey: "meal:2026-09-02" }],
    loadRows: async () => { loads++; return []; },
    syncRows: async () => { syncs++; return { status: "ok" }; },
  });
  assert.equal(result.status, "no_confirmed_candidate");
  assert.equal(loads, 0);
  assert.equal(syncs, 0);
});

test("late sync actor prefers a currently active owner and falls back to an active master", () => {
  const master = { id: 2, role: "master" };
  const owner = { id: 3, role: "owner" };
  assert.deepEqual(selectMealSyncActor([master, owner]), owner);
  assert.deepEqual(selectMealSyncActor([master]), master);
  assert.equal(selectMealSyncActor([]), null);
  assert.match(lateRoute, /\.in\("role", \["owner", "master"\]\)/);
  assert.match(lateRoute, /\.eq\("is_active", true\)/);
  assert.match(lateRoute, /\.eq\("app_login_enabled", true\)/);
  assert.match(lateRoute, /if \(!actor\)[\s\S]*"NO_LEDGER_ACTOR"/);
  assert.doesNotMatch(lateRoute, /resolved_by|\.eq\("id", candidates\[0\]/);
  assert.match(lateRoute, /p_actor_user_id: actor\.id/);
});

test("September 1 at 02:50 Vietnam syncs confirmed August 31 source", async () => {
  const runAt = new Date("2026-08-31T19:50:00Z");
  const businessDate = previousVietnamBusinessDate(runAt);
  const month = businessDate.slice(0, 7);
  assert.equal(businessDate, "2026-08-31");
  assert.equal(month, "2026-08");
  assert.match(lateRoute, /const month = businessDate\.slice\(0, 7\)/);
  assert.match(lateRoute, /\.gte\("business_date", `\$\{month\}-01`\)/);
  assert.match(lateRoute, /\.lte\("business_date", businessDate\)/);
  const synced: string[] = [];
  const result = await syncConfirmedMealSource({
    month, latestBusinessDate: businessDate,
    candidates: [{ status: "confirmed", sourceKey: "meal:2026-08-31" }],
    loadRows: async (sourceMonth) => {
      assert.equal(sourceMonth, "2026-08");
      return [{ businessDate: "2026-08-31", sourceKey: "meal:2026-08-31", amount: 270_000,
        active: true, snapshot: { total_amount: 270_000 }, fingerprint: "c".repeat(64), categoryId: 5 }];
    },
    syncRows: async (rows) => {
      synced.push(...rows.map((row) => row.sourceKey));
      return { status: "ok", driftCount: 1 };
    },
  });
  assert.deepEqual(synced, ["meal:2026-08-31"]);
  assert.deepEqual(result, { status: "synced", scannedCount: 1, driftCount: 1 });
});

test("September 1 at 03:00 Vietnam selects September, while a midmonth 02:50 selects its prior day", () => {
  assert.equal(previousVietnamBusinessDate(new Date("2026-08-31T19:59:59Z")), "2026-08-31");
  assert.equal(previousVietnamBusinessDate(new Date("2026-08-31T20:00:00Z")), "2026-09-01");
  assert.equal(previousVietnamBusinessDate(new Date("2026-09-17T19:50:00Z")), "2026-09-17");
});

test("actor comes only from the effective meal policy author and is validated", () => {
  assert.match(route, /payroll_meal_allowance_policy_versions/);
  assert.match(route, /\.eq\("id", policyVersionIds\[0\]\)/);
  assert.match(route, /\.eq\("id", policy\.created_by\)/);
  assert.match(route, /actor\?\.is_active/);
  assert.match(route, /actor\.app_login_enabled/);
  assert.match(route, /\["owner", "master"\]/);
  assert.doesNotMatch(route, /\.in\("role"[\s\S]*\.limit\(1\)/);
});

test("cash resolution uses stable account code, category, immediate mode and memo", () => {
  assert.match(route, /\.eq\("code", "store_cash"\)/);
  assert.match(route, /\.eq\("is_business_fund", true\)/);
  assert.match(route, /\.lte\("active_from", businessDate\)/);
  assert.match(route, /candidate\.proposed_category_id \?\? row\.categoryId/);
  assert.match(route, /p_resolution: "immediate"/);
  assert.match(route, /const memo = `직원 식대 · \$\{employeeCount\.toLocaleString\("en-US"\)\}명`/);
  assert.doesNotMatch(route, /const memo = `[^`]*(?:dailyAmount|18시 자동집계)/);
});

test("historical meal memo backfill changes only confirmed original meal memos", () => {
  assert.match(memoBackfill, /update public\.ledger_transactions\s+set memo =/);
  assert.match(memoBackfill, /type = 'expense'/);
  assert.match(memoBackfill, /source_type = 'attendance_meal_daily_candidate'/);
  assert.match(memoBackfill, /status = 'confirmed'/);
  assert.match(memoBackfill, /correction_of_id is null/);
  assert.match(memoBackfill, /business_date between date '2026-08-01' and date '2026-08-26'/);
  assert.match(memoBackfill, /source_snapshot->>'employee_count'/);
  assert.match(memoBackfill, /source_key ~ '\^candidate:\[0-9\]\+\$'/);
  assert.match(memoBackfill, /candidate\.candidate_type = 'employee_meal'/);
  assert.match(memoBackfill, /candidate\.source_type = 'attendance_meal_daily'/);
  assert.match(memoBackfill, /candidate\.resolved_transaction_id = ledger_transactions\.id/);
  const setClause = memoBackfill.match(/set ([\s\S]+?)\nwhere /)?.[1] ?? "";
  assert.match(setClause, /^memo = /);
  assert.doesNotMatch(setClause, /,/);
});

test("concurrent second resolution is a successful no-op", () => {
  assert.match(route, /resolveResult\.status === "already_resolved"/);
});

test("Vercel runs meal auto-post at 11:00 UTC / 18:00 Vietnam time", () => {
  assert.deepEqual(
    vercel.crons.find((cron: { path: string }) => cron.path === "/api/cron/ledger-meal-auto-post"),
    { path: "/api/cron/ledger-meal-auto-post", schedule: "0 11 * * *" }
  );
});

test("Vercel runs source drift sync at 19:50 UTC / 02:50 Vietnam time", () => {
  assert.deepEqual(vercel.crons.find((cron: { path: string }) => cron.path === "/api/cron/ledger-meal-source-sync"),
    { path: "/api/cron/ledger-meal-source-sync", schedule: "50 19 * * *" });
});
