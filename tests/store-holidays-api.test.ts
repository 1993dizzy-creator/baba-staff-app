import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

const route = read("app/api/admin/store-settings/holidays/route.ts");
const server = read("lib/store-settings/holidays-server.ts");

// ---------------------------------------------------------------------------
// /api/admin/store-settings/holidays — 별도 route (기존 /api/admin/store-settings에
// 합치지 않음). 기존 getStoreSettingsActor()/canMutateStoreSettings()를 재사용한다.
// 음력설 묶음 선택(tetOption) 계약은 완전히 제거되었다 — 이제 날짜 1개(holidayId)의
// BABA 내부 200% 적용 여부만 토글한다.
// ---------------------------------------------------------------------------

test("GET: reuses getStoreSettingsActor (owner/master/manager/leader read), not a new auth path", () => {
  const getFn = route.slice(route.indexOf("export async function GET"), route.indexOf("export async function POST"));
  assert.match(getFn, /await getStoreSettingsActor\(\)/);
  assert.match(getFn, /if \(auth\.response \|\| !auth\.actor\) return auth\.response;/);
  assert.doesNotMatch(getFn, /x-baba-actor-id/);
});

test("GET: rejects a missing/invalid year (non-numeric, out of 2020-2100 range) with 400 before querying", () => {
  const getFn = route.slice(route.indexOf("export async function GET"), route.indexOf("export async function POST"));
  assert.match(getFn, /searchParams\.get\("year"\)/);
  assert.match(getFn, /isValidYear\(year\)/);
  assert.match(getFn, /INVALID_YEAR/);
  assert.match(route, /function isValidYear\(value: number\) \{\s*\n\s*return Number\.isSafeInteger\(value\) && value >= 2020 && value <= 2100;/);
});

test("GET: response includes capabilities.mutate derived from canMutateStoreSettings, and never mutates data", () => {
  const getFn = route.slice(route.indexOf("export async function GET"), route.indexOf("export async function POST"));
  assert.match(getFn, /capabilities: \{ mutate: canMutateStoreSettings\(auth\.actor\) \}/);
  assert.doesNotMatch(getFn, /toggleHolidayOperationPolicy/);
  assert.match(getFn, /loadHolidayCalendar\(year\)/);
});

test("the old tetOption bundle-selection contract is completely gone from the route (no year/tetOption body, no isTetOption/getTetOptionDates import)", () => {
  assert.doesNotMatch(route, /tetOption/);
  assert.doesNotMatch(route, /isTetOption|getTetOptionDates|setHolidayTetOption/);
  assert.doesNotMatch(route, /holidays-data/);
});

test("POST: requires canMutateStoreSettings (owner/master) — manager/leader get 403 before any write", () => {
  const postFn = route.slice(route.indexOf("export async function POST"));
  assert.match(postFn, /if \(!canMutateStoreSettings\(auth\.actor\)\) \{/);
  assert.match(postFn, /status: 403/);
  assert.match(postFn, /code: "FORBIDDEN"/);
});

test("POST: only accepts { holidayId, selected } — unexpected keys are rejected", () => {
  const postFn = route.slice(route.indexOf("export async function POST"));
  assert.match(postFn, /new Set\(\["holidayId", "selected"\]\)/);
  assert.match(postFn, /Object\.keys\(body\)\.some\(\(key\) => !allowedKeys\.has\(key\)\)/);
});

test("POST: validates holidayId as a safe positive integer and selected as a strict boolean", () => {
  const postFn = route.slice(route.indexOf("export async function POST"));
  assert.match(postFn, /!Number\.isSafeInteger\(holidayId\)/);
  assert.match(postFn, /holidayId < 1/);
  assert.match(postFn, /typeof selected !== "boolean"/);
});

test("POST: delegates the single-date write to toggleHolidayOperationPolicy (one RPC call, no client-style sequential multi-write, and the multiplier value is only ever echoed back from the RPC result — never read from the request body)", () => {
  const postFn = route.slice(route.indexOf("export async function POST"));
  assert.match(postFn, /await toggleHolidayOperationPolicy\(holidayId, selected, auth\.actor\.id\)/);
  assert.equal((postFn.match(/await toggleHolidayOperationPolicy\(/g) ?? []).length, 1);
  assert.doesNotMatch(postFn, /body\??\.\w*[Mm]ultiplier/);
  assert.match(postFn, /internalPayMultiplier: result\.internalPayMultiplier,/);
});

test("POST: non-ok RPC statuses map to distinct HTTP codes (forbidden=403, not_found=404, invalid_request=400)", () => {
  const postFn = route.slice(route.indexOf("export async function POST"));
  assert.match(postFn, /forbidden: 403,/);
  assert.match(postFn, /not_found: 404,/);
  assert.match(postFn, /invalid_request: 400,/);
});

test("route never calls the hours/attendance RPC (store_schedule_settings_v1) or the old Tet RPC — mentioning store_setting_versions in the independence-rationale comment is fine, calling either RPC is not", () => {
  assert.doesNotMatch(route, /\.rpc\("store_schedule_settings_v1"/);
  assert.doesNotMatch(route, /\.rpc\("store_set_holiday_tet_option_v1"/);
  assert.doesNotMatch(route, /\.from\("store_setting_versions"\)/);
});

test("naming discipline: the route never uses a statutory/legal-sounding field name for the internal premium", () => {
  for (const forbidden of ["statutoryPayRate", "legalPayMultiplier", "legallyPaid", "statutory200"]) {
    assert.doesNotMatch(route, new RegExp(forbidden, "i"));
  }
});

// ---------------------------------------------------------------------------
// lib/store-settings/holidays-server.ts — adapter contract
// ---------------------------------------------------------------------------

test("holidays-server.ts is server-only and never imported by client bundles by accident", () => {
  assert.match(server, /^import "server-only";/m);
});

test("loadYearHolidays is the single shared query for 'all holidays in a year' — LEFT JOINed with store_holiday_operation_policies (never !inner), so a holiday with no policy row is still included (internalPayMultiplier null), not filtered out", () => {
  const fn = server.slice(
    server.indexOf("async function loadYearHolidays"),
    server.indexOf("// /admin/settings/store 공휴일 탭")
  );
  assert.match(
    fn,
    /\.from\("store_holidays"\)\s*\n\s*\.select\(`\$\{HOLIDAY_COLUMNS\},store_holiday_operation_policies\(internal_pay_multiplier\)`\)/
  );
  assert.match(fn, /\.eq\("calendar_year", year\)/);
  assert.doesNotMatch(fn, /!inner/);
});

test("loadHolidayCalendar delegates the holiday list to the shared loadYearHolidays (no duplicated query) and fetches the calendar row in parallel via Promise.all", () => {
  const fn = server.slice(
    server.indexOf("export async function loadHolidayCalendar"),
    server.indexOf("export type ToggleHolidayOperationPolicyResult")
  );
  assert.match(fn, /await Promise\.all\(\[/);
  assert.match(fn, /\.from\("store_holiday_calendars"\)/);
  assert.match(fn, /loadYearHolidays\(year\),/);
  assert.doesNotMatch(fn, /store_holiday_operation_policies/);
});

test("toggleHolidayOperationPolicy calls the single-date RPC and maps its result — never resolves date bundles (no holidays-data.ts import, no lunar/date-array logic)", () => {
  const fn = server.slice(
    server.indexOf("export async function toggleHolidayOperationPolicy"),
    server.indexOf("export async function loadHolidaysForMonth")
  );
  assert.match(fn, /supabaseServer\.rpc\("store_toggle_holiday_operation_policy_v1", \{/);
  assert.match(fn, /p_holiday_id: holidayId,/);
  assert.match(fn, /p_selected: selected,/);
  assert.doesNotMatch(server, /holidays-data/);
});

test("loadHolidaysForMonth fetches the whole year via loadYearHolidays (not a month-scoped query), then filters with the shared isBabaPremiumHoliday/countHolidayGroupSizes helpers — the DB query itself no longer does the selection filtering (single-day holidays have no policy row to INNER JOIN against)", () => {
  const fn = server.slice(server.indexOf("export async function loadHolidaysForMonth"));
  assert.match(fn, /const yearHolidays = await loadYearHolidays\(year\);/);
  assert.match(fn, /const groupSizes = countHolidayGroupSizes\(yearHolidays\);/);
  assert.match(fn, /isBabaPremiumHoliday\(holiday, groupSizes\.get\(holiday\.holidayGroup\) \?\? 0\)/);
  assert.doesNotMatch(fn, /!inner/);
  assert.doesNotMatch(fn, /store_holiday_calendars/);
});

test("loadHolidaysForMonth still narrows to the requested month's date range (year-wide fetch is filtered down, not returned wholesale)", () => {
  const fn = server.slice(server.indexOf("export async function loadHolidaysForMonth"));
  assert.match(fn, /holiday\.holidayDate >= start &&/);
  assert.match(fn, /holiday\.holidayDate < endExclusive &&/);
});

test("holidays-server.ts imports the shared policy helpers from holidays-policy.ts instead of reimplementing the effective-premium decision", () => {
  assert.match(
    server,
    /import \{ countHolidayGroupSizes, isBabaPremiumHoliday \} from "@\/lib\/store-settings\/holidays-policy";/
  );
});

test("PostgREST embed extraction defensively handles either a single-object or array embed shape for store_holiday_operation_policies (cardinality is not hard-assumed), matching the same defensive pattern already used elsewhere in this codebase", () => {
  assert.match(server, /function extractMultiplier/);
  assert.match(server, /Array\.isArray\(raw\) \? raw\[0\] \?\? null : raw/);
});

test("prepareHolidayCalendar calls store_prepare_holiday_calendar_v1 with the full param set (year, hungKingsDate, tetDates, nationalDayAdjacentDate, sourceUrl, sourcePublishedAt, actor) and maps every documented non-ok status", () => {
  const fn = server.slice(server.indexOf("export async function prepareHolidayCalendar"));
  assert.match(fn, /supabaseServer\.rpc\("store_prepare_holiday_calendar_v1", \{/);
  assert.match(fn, /p_year: input\.year,/);
  assert.match(fn, /p_hung_kings_date: input\.hungKingsDate,/);
  assert.match(fn, /p_tet_dates: input\.tetDates,/);
  assert.match(fn, /p_national_day_adjacent_date: input\.nationalDayAdjacentDate,/);
  assert.match(fn, /p_source_url: input\.sourceUrl,/);
  assert.match(fn, /p_source_published_at: input\.sourcePublishedAt,/);
  assert.match(fn, /p_actor_user_id: actorUserId,/);
  for (const status of [
    "forbidden",
    "invalid_year",
    "year_already_exists",
    "invalid_dates",
    "invalid_national_day_adjacent",
  ]) {
    assert.match(server, new RegExp(status));
  }
});

test("prepareHolidayCalendar never creates a store_holiday_operation_policies row itself — the RPC call is the only mutation, no follow-up toggle/insert calls from this function", () => {
  const fn = server.slice(server.indexOf("export async function prepareHolidayCalendar"));
  assert.doesNotMatch(fn, /toggleHolidayOperationPolicy|store_holiday_operation_policies/);
});

test("naming discipline: the server module never uses a statutory/legal-sounding field or variable name for the internal premium", () => {
  for (const forbidden of ["statutoryPayRate", "legalPayMultiplier", "legallyPaid", "statutory200", "statutory_pay_rate", "legal_pay_multiplier"]) {
    assert.doesNotMatch(server, new RegExp(forbidden, "i"));
  }
});
