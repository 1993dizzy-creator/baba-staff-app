import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

const route = read("app/api/admin/users/route.ts");
const levelServer = read("lib/employee-level/server.ts");
const eligibilityServer = read("lib/payroll/meal-allowance-eligibility-server.ts");

function extractFunctionBody(source: string, signature: string) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `expected to find "${signature}"`);
  const nextExport = source.indexOf("\nexport ", start + signature.length);
  return source.slice(start, nextExport === -1 ? source.length : nextExport);
}

// ---------------------------------------------------------------------------
// /admin/users parallel-prefetch optimization — users + level + meal start
// together after auth, instead of level/meal waiting for users first.
// ---------------------------------------------------------------------------

test("GET: users, level-versions, and meal-eligibility all start inside the SAME Promise.all, right after auth, with no dependency between them", () => {
  const getFn = extractFunctionBody(route, "export async function GET");
  const authIndex = getFn.indexOf('const auth = await requireRole(["owner", "master"]);');
  const promiseAllIndex = getFn.indexOf("await Promise.all([");
  assert.ok(authIndex >= 0 && promiseAllIndex > authIndex);

  const parallelBlock = getFn.slice(promiseAllIndex, getFn.indexOf("]);", promiseAllIndex) + 3);
  assert.match(parallelBlock, /supabaseServer\.from\("users"\)\.select\(USER_SELECT\)\.eq\("is_system_account", false\)/);
  assert.match(parallelBlock, /loadEmployeeLevelProgramVersionsForDatesUnscoped\(\[today, nextDate\]\)/);
  assert.match(parallelBlock, /loadMealAllowanceEligibilityVersionsAt\(today\)/);

  // today/nextDate are computed BEFORE the Promise.all and do not depend on
  // the users query result — proving level/meal do not need `users` to start.
  const todayIndex = getFn.indexOf("const today = getVietnamDateKey();");
  assert.ok(todayIndex >= 0 && todayIndex < promiseAllIndex);
  // No userIds variable exists before the Promise.all (it can only be
  // derived from `users`, which isn't resolved yet at that point).
  const beforeParallel = getFn.slice(0, promiseAllIndex);
  assert.doesNotMatch(beforeParallel, /const userIds/);
});

test("GET: no secondary read is nested inside a .then() off the users query, and users error handling happens only AFTER the Promise.all resolves (not gating the other two reads)", () => {
  const getFn = extractFunctionBody(route, "export async function GET");
  assert.doesNotMatch(getFn, /supabaseServer\.from\("users"\)[\s\S]*?\.then\(/);
  const promiseAllEnd = getFn.indexOf("]);", getFn.indexOf("await Promise.all([")) + 3;
  const afterParallel = getFn.slice(promiseAllEnd);
  const usersErrorIndex = afterParallel.indexOf("if (usersResult.error)");
  assert.ok(usersErrorIndex >= 0, "users error check happens after the parallel await, not before/during it");
});

test("new level-versions loader preserves exact date-bound semantics of the existing candidate-scoped loader — only the .in(user_id) filter differs", () => {
  const existing = extractFunctionBody(levelServer, "export async function loadEmployeeLevelProgramVersionsForDates(");
  const unscoped = extractFunctionBody(levelServer, "export async function loadEmployeeLevelProgramVersionsForDatesUnscoped(");

  const sameSelect = 'select("id,user_id,enabled,effective_from,effective_to,base_date,base_date_mode,revision")';
  assert.match(existing, new RegExp(sameSelect.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(unscoped, new RegExp(sameSelect.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  for (const fn of [existing, unscoped]) {
    assert.match(fn, /\.lte\("effective_from", maxDate\)/);
    assert.match(fn, /\.or\(`effective_to\.is\.null,effective_to\.gt\.\$\{minDate\}`\)/);
    assert.match(fn, /\.order\("revision", \{ ascending: false \}\)/);
    // Reuses the same pure selector — no duplicated/rewritten selection logic.
    assert.match(fn, /selectEmployeeLevelProgramVersionsForDates\(/);
  }

  // The only structural difference: candidate-user prefilter present on the
  // existing loader, absent on the unscoped one.
  assert.match(existing, /\.in\("user_id", userIds\)/);
  assert.doesNotMatch(unscoped, /\.in\("user_id"/);
  assert.doesNotMatch(unscoped, /userIds/);
});

test("new meal-eligibility loader preserves the exact effective_from <= asOfDate bound of the existing candidate-scoped loader, and excludes future versions the same way", () => {
  const existing = extractFunctionBody(eligibilityServer, "export async function loadMealAllowanceEligibilityAt(");
  const unscoped = extractFunctionBody(eligibilityServer, "export async function loadMealAllowanceEligibilityVersionsAt(");

  const sameSelect = 'select("id,user_id,is_eligible,effective_from,revision")';
  for (const fn of [existing, unscoped]) {
    assert.match(fn, new RegExp(sameSelect.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(fn, /\.lte\("effective_from", asOfDate\)/);
  }

  assert.match(existing, /\.in\("user_id", userIds\)/);
  assert.doesNotMatch(unscoped, /\.in\("user_id"/);
  assert.doesNotMatch(unscoped, /userIds/);

  // Returns raw per-user version lists (groupByUser), not a resolved
  // boolean map — the caller resolves per actual user with the shared pure
  // selector, same as the existing loader does internally.
  assert.match(unscoped, /return groupByUser\(data \?\? \[\]\);/);
});

test("system/orphan/unrelated rows can never leak into the GET response: the final mapping only ever looks up ids taken from the already-filtered `users` array, never from the broader level/meal reads", () => {
  const getFn = extractFunctionBody(route, "export async function GET");
  // users is built strictly from the is_system_account=false query result.
  assert.match(getFn, /const users = sortUsers\(\(usersResult\.data \|\| \[\]\)\.map\(sanitizePublicEmployeeUser\)\);/);
  // Every lookup into the broader level/meal results is keyed by
  // `Number(user.id)` from that same `users` array — never by iterating the
  // raw versionsByDate/mealVersionsByUser maps' own keys.
  assert.match(getFn, /mealVersionsByUser\.get\(userId\) \?\? \[\]/);
  assert.match(getFn, /users\.map\(\(user\) => \{/);
  const eligibilityBuildIndex = getFn.indexOf("const mealAllowanceEligibility = new Map<number, boolean>(");
  const eligibilityBuildBody = getFn.slice(eligibilityBuildIndex, getFn.indexOf(");", eligibilityBuildIndex) + 2);
  assert.match(eligibilityBuildBody, /users\.map\(\(user\) => \{/);
  assert.doesNotMatch(eligibilityBuildBody, /mealVersionsByUser\.keys\(\)|versionsByDate\.keys\(\)/);
});

test("existing candidate-scoped loaders are completely untouched — other callers (PATCH/rehire, /admin/payroll self-service, etc.) retain their exact current behavior", () => {
  // loadEmployeeLevelProgramVersionsForDates: unchanged body, still present,
  // still requires userIds and returns early on empty candidates.
  const existingLevel = extractFunctionBody(levelServer, "export async function loadEmployeeLevelProgramVersionsForDates(");
  assert.match(existingLevel, /if \(userIds\.length === 0 \|\| dates\.length === 0\) return empty;/);
  assert.match(existingLevel, /\.in\("user_id", userIds\)/);

  // loadMealAllowanceEligibilityAt: unchanged body, still present, still
  // requires userIds and returns early on empty candidates.
  const existingMeal = extractFunctionBody(eligibilityServer, "export async function loadMealAllowanceEligibilityAt(");
  assert.match(existingMeal, /if \(userIds\.length === 0\) return result;/);
  assert.match(existingMeal, /\.in\("user_id", userIds\)/);

  // loadMealAllowanceEligibilityDuringMonth (used by /admin/payroll) is
  // untouched — no trace of the new unscoped variant anywhere near it.
  const duringMonth = extractFunctionBody(eligibilityServer, "export async function loadMealAllowanceEligibilityDuringMonth(");
  assert.match(duringMonth, /\.in\("user_id", userIds\)/);

  // PATCH/rehire in route.ts still call the userId-scoped variant, unchanged.
  const afterGet = route.slice(route.indexOf("export async function PATCH"));
  assert.equal((afterGet.match(/loadMealAllowanceEligibilityAt\(\[Number\(id\)\], today\)/g) ?? []).length, 2);
});

test("failure semantics: a users, level, or meal read failure still fails the GET the same way — no partial success, no swallowed error", () => {
  const getFn = extractFunctionBody(route, "export async function GET");
  // users error is checked explicitly and thrown (caught by the outer catch).
  assert.match(getFn, /if \(usersResult\.error\) \{\s*throw new Error\(`Failed to fetch users: \$\{usersResult\.error\.message\}`\);/);
  // The unscoped loaders throw on error internally (same pattern as the
  // existing scoped loaders) rather than returning a partial/empty result.
  const unscopedLevel = extractFunctionBody(levelServer, "export async function loadEmployeeLevelProgramVersionsForDatesUnscoped(");
  assert.match(unscopedLevel, /if \(error\) \{\s*throw new Error\(`EMPLOYEE_LEVEL_PROGRAM_READ_FAILED: \$\{error\.message\}`\);/);
  const unscopedMeal = extractFunctionBody(eligibilityServer, "export async function loadMealAllowanceEligibilityVersionsAt(");
  assert.match(unscopedMeal, /if \(error\) throw new Error\(`MEAL_ALLOWANCE_ELIGIBILITY_READ_FAILED: \$\{error\.message\}`\);/);
  // The route's outer catch-all is unchanged — any thrown error (from any
  // of the three reads) still produces the same 500 JSON error shape.
  const catchBlock = route.slice(route.indexOf("} catch (error) {", route.indexOf("export async function GET")));
  assert.match(catchBlock, /error: error instanceof Error \? error\.message : "Failed to fetch users\."/);
});
