import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { createHash } from "node:crypto";
import { resolveAttendanceRecordsPolicy } from "../lib/attendance/api-policy.ts";
import { evaluateMonthlyAttendanceStanding, classifyMonthlyAttendanceDay, resolveAttendanceStoreClosed } from "../lib/attendance/monthly-standing.ts";
import { normalizeAttendanceDayFacts } from "../lib/payroll/attendance-facts.ts";
import { getPayrollOverviewPeriod } from "../lib/payroll/overview-period.ts";
import { getBusinessDate } from "../lib/common/business-time.ts";
import { calculateStoreBusinessDate } from "../lib/store-settings/business-time-core.ts";
import { shouldShowAttendancePerfectScoreBadge, qualifiesForAttendanceBonus } from "../lib/payroll/attendance-bonus.ts";

function loadModule(path, dependencies, globals = {}) {
  const exports = {};
  const code = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, { exports, require: (name) => {
    assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
    return dependencies[name];
  }, ...globals });
  return exports;
}

// Exercise the actual server loader with local database doubles; no production access.
function standingLoader({ records = [], normalizedIds = [], period = getPayrollOverviewPeriod("2026-10", "2026-10-01", "2026-10-02") } = {}) {
  const schedule = { id: 1, userId: 1, startTime: "16:00", endTime: "01:00", unpaidBreakMinutes: 0,
    effectiveFrom: "2026-10-01", effectiveTo: null, effective_from: "2026-10-01", revision: 1, changeReason: null };
  const queries = [];
  const tables = {
    users: [{ id: 1, hire_date: "2026-10-01", termination_date: null, attendance_tracking_enabled: true, is_system_account: false }],
    attendance_records: records,
    employee_work_schedule_versions: [schedule],
    store_setting_versions: [], store_holidays: [],
    attendance_record_manual_overrides: normalizedIds.map((id) => ({ attendance_record_id: id })),
  };
  const supabaseServer = { from(table) {
    const filters = [];
    const query = { then(resolve) {
      const rows = tables[table].filter((row) => filters.every(([operator, field, value]) =>
        operator === "gte" ? row[field] >= value : operator === "lte" ? row[field] <= value :
        operator === "in" ? value.includes(row[field]) : row[field] == null || row[field] === value));
      return Promise.resolve({ data: rows, error: null }).then(resolve);
    } };
    for (const operator of ["select", "eq", "gte", "lte", "or", "order", "in", "is"]) {
      query[operator] = (...args) => {
        queries.push([table, operator, ...args]);
        if (["eq", "gte", "lte", "in"].includes(operator)) filters.push([operator, ...args]);
        return query;
      };
    }
    return query;
  } };
  const { loadMonthlyAttendanceStandings } = loadModule("lib/attendance/monthly-standing-server.ts", {
    "server-only": {},
    "./early-leave-review-server": { loadEarlyLeaveReviewContexts: async () => new Map() },
    "./monthly-standing": { evaluateMonthlyAttendanceStanding, classifyMonthlyAttendanceDay, resolveAttendanceStoreClosed },
    "@/lib/supabase/server": { supabaseServer },
    "@/lib/payroll/attendance-facts": { normalizeAttendanceDayFacts },
    "@/lib/payroll/db-mappers": { mapSchedule: (row) => row },
    "@/lib/payroll/monthly-run": { resolvePayrollOverviewPeriod: async () => period,
      payrollMonthDates: (month) => Array.from({ length: 31 }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`) },
    "@/lib/payroll/store-setting-timeline": { resolvePayrollAttendancePolicyByDate: () => new Map() },
    "@/lib/store-settings/business-time-adapter-core": { resolveStoreClosedByDate: () => new Map() },
    "@/lib/store-settings/holidays-policy": { countHolidayGroupSizes: () => new Map(), isBabaPremiumHoliday: () => false },
  });
  return { load: async (staffCurrent = true) => (await loadMonthlyAttendanceStandings("2026-10", { staffCurrent })).standings.get(1), queries };
}
const record = (date, patch = {}) => ({ id: Number(date.slice(-2)), user_id: 1, work_date: date, status: "done",
  check_in_at: `${date}T16:00:00+07:00`, check_out_at: `${date}T23:00:00+07:00`, approval_status: null, ...patch });
const yesterday = record("2026-10-01", { check_out_at: "2026-10-02T01:00:00+07:00" });
const shows = (standing, eligible = true) => shouldShowAttendancePerfectScoreBadge(eligible, standing.perfectAttendanceCurrent);

test("first day with no record shows perfect progress only for eligible tracked staff; payroll still requires work", async () => {
  const loader = standingLoader({ period: getPayrollOverviewPeriod("2026-10", "2026-09-30", "2026-10-01") });
  assert.equal(shows(await loader.load()), true);
  assert.equal(shows(await loader.load(), false), false);
  assert.equal(shows(await loader.load(false)), false);
  assert.equal(evaluateMonthlyAttendanceStanding({ attendanceTrackingEnabled: false, days: [], allowZeroWorkDays: true }).perfectAttendanceCurrent, false);
});

test("today's normal open check-in retains badge; late open check-in removes it before checkout", async () => {
  for (const minute of ["00", "01"]) {
    const loader = standingLoader({ records: [yesterday, record("2026-10-02", {
      status: minute === "00" ? "working" : "late", check_in_at: `2026-10-02T16:${minute}:00+07:00`, check_out_at: null,
    })] });
    const live = await loader.load();
    assert.equal(shows(live), minute === "00");
    assert.equal(live.blockingCount, 0);
    assert.equal(shows(await loader.load(false)), true);
    assert.equal(shows(live, false), false);
  }
});

test("today's early checkout and explicit unauthorized absence remove badge immediately", async () => {
  for (const today of [record("2026-10-02"), record("2026-10-02", { status: "unauthorized_absence", check_in_at: null, check_out_at: null })]) {
    const loader = standingLoader({ records: [yesterday, today] });
    assert.equal(shows(await loader.load()), false);
    assert.equal(shows(await loader.load(false)), true);
  }
});

test("five approved leave days preserve progress without satisfying final 26-workday qualification", async () => {
  const records = Array.from({ length: 5 }, (_, i) => record(`2026-10-0${i + 1}`, { status: "leave", approval_status: "approved", check_in_at: null, check_out_at: null }));
  const standing = await standingLoader({ records, period: getPayrollOverviewPeriod("2026-10", "2026-10-04", "2026-10-05") }).load();
  assert.equal(standing.actualWorkDays, 0);
  assert.equal(shows(standing), true);
  assert.equal(qualifiesForAttendanceBonus({ monthClosed: true, attendanceTrackingEnabled: true,
    policy: { minimumActualWorkdays: 26, allowedLateCount: 0, allowedEarlyLeaveCount: 0, bonusAmount: 300000 },
    eligibility: { isEligible: true }, standing }), false);
});

test("past violations remain disqualifying; manual late normalization restores live progress", async () => {
  const late = record("2026-10-02", { status: "late", check_in_at: "2026-10-02T16:01:00+07:00", check_out_at: null });
  assert.equal(shows(await standingLoader({ records: [yesterday, late], normalizedIds: [2] }).load()), true);
  assert.equal(shows(await standingLoader({ records: [{ ...yesterday, check_in_at: "2026-10-01T16:01:00+07:00" }] }).load()), false);
});

test("Vietnam first-of-month 00:00 through 02:59 belong to previous business month; 03:00 starts new month", () => {
  for (const time of ["00:00:00", "00:30:00", "02:59:59", "03:00:00"]) {
    const now = new Date(`2026-10-01T${time}+07:00`);
    const date = getBusinessDate(now);
    assert.equal(date, calculateStoreBusinessDate(now));
    assert.equal(date.slice(0, 7), time === "03:00:00" ? "2026-10" : "2026-09");
  }
  const page = readFileSync("app/(protected)/attendance/staff/page.tsx", "utf8");
  assert.match(page, /const businessDate = getBusinessDate\(\)/);
  assert.match(page, /useMonthlyAttendanceSummary\(businessDate\.slice\(0, 7\), `\$\{businessDate\}:\$\{summaryRefreshKey\}`, true\)/);
});

function hookHarness() {
  let state = null, effect, deps, cleanup;
  const requests = [];
  const react = {
    useState: () => [state, (next) => { state = next; }],
    useMemo: (fn) => fn(),
    useEffect: (fn, nextDeps) => {
      if (!deps || nextDeps.some((item, i) => item !== deps[i])) { cleanup?.(); deps = nextDeps; effect = fn; }
    },
  };
  const hook = loadModule("components/attendance/useMonthlyAttendanceSummary.ts", { react }, {
    AbortController, fetch: (url, options) => new Promise((resolve) => requests.push({ url, options, resolve })),
  }).useMonthlyAttendanceSummary;
  return { requests, render(month, revision, live = true) {
    const result = hook(month, revision, live);
    if (effect) { const fn = effect; effect = null; cleanup = fn(); }
    return result;
  }, unmount() { cleanup?.(); deps = null; state = null; } };
}
async function respond(request, perfectAttendanceCurrent, ok = true) {
  request.resolve({ ok, json: async () => ({ summaries: [{ userId: 1, attendanceBonusEligible: true, perfectAttendanceCurrent }] }) });
  await new Promise((resolve) => setImmediate(resolve));
}

test("same-month refresh and normalization fetch fresh summary; obsolete in-flight response cannot restore badge", async () => {
  const h = hookHarness();
  h.render("2026-10", 0);
  await respond(h.requests[0], true);
  assert.equal(h.render("2026-10", 0).get(1).perfectAttendanceCurrent, true);
  assert.equal(h.render("2026-10", 1).size, 0);
  assert.equal(h.requests[1].options.cache, "no-store");
  assert.match(h.requests[1].url, /scope=staff_current/);
  h.render("2026-10", 2);
  await respond(h.requests[2], false);
  await respond(h.requests[1], true);
  assert.equal(h.render("2026-10", 2).get(1).perfectAttendanceCurrent, false);
  h.render("2026-10", 3);
  await respond(h.requests[3], true);
  assert.equal(h.render("2026-10", 3).get(1).perfectAttendanceCurrent, true);
});

test("month rollover, read failure and remount never reuse a settled monthly Promise", async () => {
  const h = hookHarness();
  h.render("2026-09", 0);
  await respond(h.requests[0], true);
  assert.equal(h.render("2026-10", 0).size, 0);
  await respond(h.requests[1], true, false);
  assert.equal(h.render("2026-10", 0).size, 0);
  h.unmount();
  h.render("2026-10", 0);
  assert.equal(h.requests.length, 3);
  await respond(h.requests[2], false);
  assert.equal(h.render("2026-10", 0).get(1).perfectAttendanceCurrent, false);
});

function staffRefreshKey(records, summaryRevision) {
  const page = readFileSync("app/(protected)/attendance/staff/page.tsx", "utf8");
  const expression = page.slice(page.indexOf("const summaryRefreshKey ="), page.indexOf("const perfectSummary ="));
  return vm.runInNewContext(expression + ";summaryRefreshKey", { records, summaryRevision, useMemo: (fn) => fn() });
}

test("identical polling content and reordered records do not re-fetch summary; mutations and revision changes do", async () => {
  const h = hookHarness();
  const records = [yesterday, record("2026-10-02", { check_out_at: null })];
  const key = staffRefreshKey(records, "revision1");
  h.render("2026-10", key);
  await respond(h.requests[0], true);
  h.render("2026-10", staffRefreshKey(structuredClone(records), "revision1"));
  h.render("2026-10", staffRefreshKey([...records].reverse(), "revision1"));
  assert.equal(h.requests.length, 1);
  h.render("2026-10", staffRefreshKey(records, "revision2"));
  assert.equal(h.requests.length, 2);
  await respond(h.requests[1], false);
  const corrected = [yesterday, { ...records[1], late_minutes: 0, status: "working" }];
  h.render("2026-10", staffRefreshKey(corrected, "revision2"));
  assert.equal(h.requests.length, 3);
});

test("non-staff consumers retain their shared monthly cache and default summary URL", async () => {
  const h = hookHarness();
  h.render("2026-10", undefined, false);
  assert.equal(h.requests[0].url, "/api/attendance/monthly-summary?month=2026-10");
  await respond(h.requests[0], true);
  h.unmount();
  h.render("2026-10", undefined, false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.requests.length, 1);
  assert.equal(h.render("2026-10", undefined, false).get(1).perfectAttendanceCurrent, true);
});

function recordsApiHarness() {
  const tables = {
    attendance_records: [ { ...yesterday, updated_at: "2026-10-01T18:00:00Z" }, record("2026-10-02", { updated_at: "2026-10-02T18:00:00Z" }) ],
    attendance_record_manual_overrides: [],
  };
  const queries = [];
  const supabaseServer = { from(table) {
    const filters = [];
    let columns, order;
    const query = { then(resolve) {
      let rows = tables[table].filter((row) => filters.every(([op, key, value]) =>
        op === "gte" ? row[key] >= value : op === "lte" ? row[key] <= value : op === "in" ? value.includes(row[key]) : row[key] === value));
      if (order) rows = [...rows].sort((a,b) => a[order] - b[order]);
      rows = rows.map(row => Object.fromEntries(columns.split(",").map(key => [key,row[key]])));
      return Promise.resolve({ data: rows, error: null }).then(resolve);
    } };
    for (const op of ["select","eq","gte","lte","in","order"]) query[op] = (...args) => {
      queries.push([table, op, ...args]);
      if (op === "select") columns = args[0]; else if(op === "order") order = args[0]; else filters.push([op, ...args]);
      return query;
    };
    return query;
  } };
  const route = loadModule("app/api/attendance/records/route.ts", {
    "node:crypto": { createHash },
    "@/lib/attendance/api-policy": { resolveAttendanceRecordsPolicy },
    "@/lib/attendance/server-api": { requireAttendanceActor: async () => ({ ok: true, actor: { id: 1, role: "staff" } }),
      attendanceJson: (data) => data, attendanceAuthFailure: () => { throw new Error("Unexpected auth failure"); } },
    "@/lib/supabase/server": { supabaseServer },
    "@/lib/attendance/policy-resolution-adapter": {},
    "@/lib/attendance/policy-engine": {},
    "@/lib/attendance/early-leave-review-server": {},
    "@/lib/attendance/early-leave-display-context-server": {},
  }, { URL });
  return { tables, queries, get: (scope = "staff_today") => route.GET({ url: "http://localhost/api/attendance/records?scope=" + scope + "&work_date=2026-10-02" }) };
}

test("lightweight staff revision detects past corrections, leave changes, deletion, normalization and revocation", async () => {
  const h = recordsApiHarness();
  let previous = (await h.get()).summaryRevision;
  assert.equal((await h.get()).summaryRevision, previous);
  for (const change of [
    () => { h.tables.attendance_records[0].updated_at = "2026-10-02T18:01:00Z"; },
    () => { h.tables.attendance_records[0].status = "leave"; h.tables.attendance_records[0].updated_at = "2026-10-02T18:02:00Z"; },
    () => { h.tables.attendance_record_manual_overrides.push({ id: 1, attendance_record_id: 1, revoked_at: null }); },
    () => { h.tables.attendance_record_manual_overrides[0].revoked_at = "2026-10-02T18:03:00Z"; },
    () => { h.tables.attendance_records.shift(); },
  ]) {
    change();
    const next = (await h.get()).summaryRevision;
    assert.notEqual(next, previous);
    assert.equal((await h.get()).summaryRevision, next);
    previous = next;
  }
  assert.equal(h.queries.some(([table]) => !["attendance_records", "attendance_record_manual_overrides"].includes(table)), false);
});

test("other records API scopes keep their existing response and do not read monthly revision inputs", async () => {
  const h = recordsApiHarness();
  const result = await h.get("self_day");
  assert.equal(result.ok, true);
  assert.equal("summaryRevision" in result, false);
  assert.equal(h.queries.filter(([,op]) => op === "select").length, 1);
});
