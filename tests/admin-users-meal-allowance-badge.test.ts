import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
// @ts-expect-error Node's test runner requires the explicit TypeScript extension.
import { selectMealAllowanceEligibilityAt } from "../lib/payroll/meal-allowance.ts";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

const eligibilityServer = read("lib/payroll/meal-allowance-eligibility-server.ts");
const usersRoute = read("app/api/admin/users/route.ts");
const usersPage = read("app/(protected)/admin/users/page.tsx");
const usersText = read("lib/text/admin-users.ts");

// ---------------------------------------------------------------------------
// eligibility 판정 로직(순수 함수) — latest-version-wins 시나리오
// ---------------------------------------------------------------------------

test("eligibility badge logic: past true → latest revision false hides the badge", () => {
  const versions = [
    { id: 1, userId: 1, isEligible: true, effectiveFrom: "2026-06-01", revision: 1 },
    { id: 2, userId: 1, isEligible: false, effectiveFrom: "2026-08-01", revision: 1 },
  ];
  assert.equal(selectMealAllowanceEligibilityAt(versions, "2026-08-07"), false);
});

test("eligibility badge logic: past false → latest revision true shows the badge", () => {
  const versions = [
    { id: 1, userId: 1, isEligible: false, effectiveFrom: "2026-06-01", revision: 1 },
    { id: 2, userId: 1, isEligible: true, effectiveFrom: "2026-08-01", revision: 1 },
  ];
  assert.equal(selectMealAllowanceEligibilityAt(versions, "2026-08-07"), true);
});

test("eligibility badge logic: a future-effective version never changes today's display", () => {
  const versions = [
    { id: 1, userId: 1, isEligible: true, effectiveFrom: "2026-08-01", revision: 1 },
    { id: 2, userId: 1, isEligible: false, effectiveFrom: "2026-09-01", revision: 1 },
  ];
  assert.equal(selectMealAllowanceEligibilityAt(versions, "2026-08-07"), true);
});

test("eligibility badge logic: no version at all → not eligible", () => {
  assert.equal(selectMealAllowanceEligibilityAt([], "2026-08-07"), false);
});

// ---------------------------------------------------------------------------
// lib/payroll/meal-allowance-eligibility-server.ts — bulk 조회, N+1 없음, 분리 유지
// ---------------------------------------------------------------------------

test("eligibility server helper: each exported loader issues exactly one bulk query, not one query per user", () => {
  // 파일 전체에는 세 함수(오늘 기준 / 급여월 기준 / 오늘 기준·candidate-userId 없는 prefetch 변형)
  // 각각 1건씩, 총 3건의 .from() 호출만 있어야 한다.
  assert.equal((eligibilityServer.match(/supabaseServer\s*\n?\s*\.from\(/g) ?? []).length, 3);
  // .in("user_id", userIds)는 candidate-scoped 두 함수(오늘 기준 / 급여월 기준)에만 있고,
  // parallel-prefetch 변형(loadMealAllowanceEligibilityVersionsAt)에는 의도적으로 없다.
  assert.equal((eligibilityServer.match(/\.in\("user_id", userIds\)/g) ?? []).length, 2);
});

test("eligibility server helper: loadMealAllowanceEligibilityAt filters to already-effective versions server-side so future reservations never reach the resolver", () => {
  const fn = eligibilityServer.slice(eligibilityServer.indexOf("export async function loadMealAllowanceEligibilityAt"), eligibilityServer.indexOf("export async function loadMealAllowanceEligibilityDuringMonth"));
  assert.match(fn, /\.lte\("effective_from", asOfDate\)/);
  assert.match(fn, /selectMealAllowanceEligibilityAt\(/);
});

test("eligibility server helper: loadMealAllowanceEligibilityDuringMonth never uses today's date — it filters to the target payroll month only, and reuses selectMealAllowanceEligibilityDuringMonth (not a today-based resolver)", () => {
  const fn = eligibilityServer.slice(eligibilityServer.indexOf("export async function loadMealAllowanceEligibilityDuringMonth"));
  assert.doesNotMatch(fn, /getVietnamDateKey|new Date\(\)/);
  assert.match(fn, /\.lt\("effective_from", monthEndExclusive\)/);
  assert.match(fn, /selectMealAllowanceEligibilityDuringMonth\(/);
});

test("eligibility server helper: reuses the shared pure resolvers instead of reimplementing latest-version selection", () => {
  assert.match(eligibilityServer, /import\s*\{[\s\S]*selectMealAllowanceEligibilityAt[\s\S]*selectMealAllowanceEligibilityDuringMonth[\s\S]*\}\s*from "@\/lib\/payroll\/meal-allowance"/);
});

test("eligibility server helper stays decoupled from the /admin/payroll cost aggregation module (meal-allowance-server.ts) — mentioning it in a comment is fine, importing/calling it is not", () => {
  assert.doesNotMatch(eligibilityServer, /from "@\/lib\/payroll\/meal-allowance-server"/);
  const mealAllowanceServer = read("lib/payroll/meal-allowance-server.ts");
  assert.doesNotMatch(mealAllowanceServer, /meal-allowance-eligibility-server/);
});

// ---------------------------------------------------------------------------
// app/api/admin/users/route.ts — bulk 병합, N+1 없음, 세 응답 경로(GET/PATCH/rehire) 일관성
// ---------------------------------------------------------------------------

test("users route: imports the lightweight eligibility helpers, not the heavy payroll cost summary", () => {
  // Parallel-prefetch optimization (GET only): loadMealAllowanceEligibilityVersionsAt
  // is the new date-scoped-without-candidate-userIds variant used by GET;
  // loadMealAllowanceEligibilityAt (userId-scoped) is still imported and
  // still used by PATCH/rehire below — see
  // admin-users-parallel-prefetch.test.ts for full coverage of the new
  // loader's own semantics.
  assert.match(usersRoute, /import \{ loadMealAllowanceEligibilityAt, loadMealAllowanceEligibilityVersionsAt \} from "@\/lib\/payroll\/meal-allowance-eligibility-server";/);
  assert.doesNotMatch(usersRoute, /loadMealAllowanceCostSummary/);
});

test("users route GET: eligibility is bulk-loaded once (date-scoped, no candidate-userId prefilter) inside the same Promise.all as users and level-program lookups (no N+1, no waterfall)", () => {
  const getFn = usersRoute.slice(usersRoute.indexOf("export async function GET"), usersRoute.indexOf("export async function PATCH"));
  assert.match(getFn, /loadMealAllowanceEligibilityVersionsAt\(today\)/);
  assert.equal((getFn.match(/loadMealAllowanceEligibilityVersionsAt\(/g) ?? []).length, 1);
  // GET never calls the userId-scoped variant (that would reintroduce the waterfall).
  assert.doesNotMatch(getFn, /loadMealAllowanceEligibilityAt\(/);
  // users.map(...) 콜백 본문 안에서는 조회를 다시 호출하지 않는다(호출은 Promise.all 안에서 1회뿐).
  const mapCallback = getFn.slice(getFn.indexOf("users: users.map("));
  assert.doesNotMatch(mapCallback, /loadMealAllowanceEligibilityVersionsAt\(/);
});

test("users route GET: response merges mealAllowanceEligible onto every user via withMealAllowanceEligibility", () => {
  const getFn = usersRoute.slice(usersRoute.indexOf("export async function GET"), usersRoute.indexOf("export async function PATCH"));
  assert.match(getFn, /users\.map\(\(user\) => withMealAllowanceEligibility\(/);
});

test("users route: PATCH (profile update) and rehire responses also include mealAllowanceEligible — no regression to a stale/missing field after save", () => {
  const patchFn = usersRoute.slice(usersRoute.indexOf("export async function PATCH"));
  assert.match(patchFn, /loadMealAllowanceEligibilityAt\(\[Number\(id\)\], today\)/);
  assert.equal((patchFn.match(/loadMealAllowanceEligibilityAt\(/g) ?? []).length, 2, "rehire branch + normal update branch, each exactly once");
  assert.match(patchFn, /withMealAllowanceEligibility\(/);
});

test("withMealAllowanceEligibility: defaults to false when a user has no eligibility map entry (not undefined)", () => {
  assert.match(usersRoute, /eligibility\.get\(Number\(user\.id\)\) \?\? false/);
});

// ---------------------------------------------------------------------------
// app/(protected)/admin/users/page.tsx — 배지 표시
// ---------------------------------------------------------------------------

test("users page: UserRow carries mealAllowanceEligible from the API response", () => {
  assert.match(usersPage, /mealAllowanceEligible: boolean;/);
});

test("users page: the 🍚 badge renders only when mealAllowanceEligible is true, and is placed next to the name/level, before the role text — not a new separate section", () => {
  const cardIndex = usersPage.indexOf("function UserCard(");
  const rowTitleIndex = usersPage.indexOf("styles.rowTitle", cardIndex);
  const badgeIndex = usersPage.indexOf("user.mealAllowanceEligible ? (", cardIndex);
  const rowPositionIndex = usersPage.indexOf("styles.rowPosition", cardIndex);
  assert.ok(rowTitleIndex > -1 && badgeIndex > -1 && rowPositionIndex > -1);
  assert.ok(rowTitleIndex < badgeIndex && badgeIndex < rowPositionIndex, "badge must sit inside rowTitle, before the role text");
  assert.match(usersPage, /🍚/);
});

test("users page: badge carries a bilingual title/aria-label instead of being decoration-only", () => {
  assert.match(usersPage, /title=\{text\.mealAllowanceEligibleBadge\} aria-label=\{text\.mealAllowanceEligibleBadge\}/);
});

test("users page: badge style stays compact (small font, no extra layout height) — does not introduce a bulky new block", () => {
  assert.match(usersPage, /mealBadge: \{\s*fontSize: 12,\s*lineHeight: 1,\s*flexShrink: 0,\s*\}/);
});

test("admin-users text: bilingual label exists for the meal allowance badge tooltip, and never implies extra personal cash payout ('지급'/'nhận')", () => {
  assert.match(usersText, /mealAllowanceEligibleBadge: "식대 대상"/);
  assert.match(usersText, /mealAllowanceEligibleBadge: "Đối tượng trợ cấp ăn"/);
  assert.doesNotMatch(usersText, /mealAllowanceEligibleBadge: "[^"]*지급[^"]*"/);
  assert.doesNotMatch(usersText, /mealAllowanceEligibleBadge: "[^"]*nhận[^"]*"/);
});
