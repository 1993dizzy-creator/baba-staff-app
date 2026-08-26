import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
// @ts-expect-error Node strips TypeScript extensions in tests.
import { calculateCurrentMealAllowanceCost } from "../lib/payroll/meal-allowance.ts";

const route = readFileSync("app/api/cron/ledger-meal-auto-post/route.ts", "utf8");
const source = readFileSync("lib/ledger/employee-costs.ts", "utf8");
const memoBackfill = readFileSync("supabase/migrations/20260826191856_shorten_employee_meal_memos.sql", "utf8");
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

test("confirmed meal is checked before sync so later drift is not recorded", () => {
  const confirmed = route.indexOf('existing?.status === "confirmed"');
  const sync = route.indexOf('"ledger_sync_candidates_v2"');
  assert.ok(confirmed >= 0 && sync > confirmed);
  assert.match(route, /Never feed later attendance or policy[\s\S]*managers correct the ledger manually/);
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
