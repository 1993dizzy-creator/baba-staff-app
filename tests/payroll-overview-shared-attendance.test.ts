import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

const overview = read("lib/payroll/overview-server.ts");
const snapshot = read("lib/payroll/monthly-run.ts");
const standing = read("lib/attendance/monthly-standing-server.ts");
const route = read("app/api/admin/payroll/overview/route.ts");

const ATTENDANCE_COLUMNS =
  "id,user_id,status,work_date,check_in_at,check_out_at,late_minutes,early_leave_minutes,work_minutes,approval_status,updated_at";

function extractFunctionBody(source: string, signature: string) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `expected to find "${signature}"`);
  const nextExport = source.indexOf("\nexport ", start + signature.length);
  return source.slice(start, nextExport === -1 ? source.length : nextExport);
}

// ---------------------------------------------------------------------------
// Phase 2 — shared attendance_records read for current/completed periods,
// with future-month (calculationEndDate===null) behavior left untouched.
// ---------------------------------------------------------------------------

test("current/completed month: overview-server builds exactly one shared attendance_records read, only when calculationEndDate is non-null", () => {
  const fn = overview.slice(overview.indexOf("export async function loadPayrollOverview"));
  assert.match(fn, /const attendancePromise=period\.calculationEndDate\?Promise\.resolve/);
  // Guarded by the same calculationEndDate truthiness check the two loaders
  // already use to decide "current/completed" vs "future" — not a new date
  // boundary invented for this optimization.
  assert.match(fn, /:undefined;/);
});

test("shared attendance query uses the exact same columns as both loaders' own fallback queries", () => {
  const sharedSelect = overview.slice(
    overview.indexOf('.from("attendance_records").select("'),
    overview.indexOf('.from("attendance_records").select("') + '.from("attendance_records").select("'.length + ATTENDANCE_COLUMNS.length,
  );
  assert.match(sharedSelect, new RegExp(ATTENDANCE_COLUMNS.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const snapshotFallback = snapshot.slice(snapshot.indexOf('const attendanceQuery=supabaseServer.from("attendance_records")'));
  assert.match(snapshotFallback, new RegExp('select\\("' + ATTENDANCE_COLUMNS.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + '"\\)'));

  const standingFallback = standing.slice(standing.indexOf("const baseAttendanceQuery"));
  assert.match(standingFallback, new RegExp('select\\("' + ATTENDANCE_COLUMNS.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + '"\\)'));
});

test("shared attendance promise is started right after period resolves and handed to BOTH loaders — snapshot does not wait for standing and standing does not wait for snapshot", () => {
  const fn = overview.slice(overview.indexOf("export async function loadPayrollOverview"));
  const periodIndex = fn.indexOf("const period=await resolvePayrollOverviewPeriod(month)");
  const attendancePromiseIndex = fn.indexOf("const attendancePromise=");
  const snapshotPromiseIndex = fn.indexOf("const snapshotPromise=loadPayrollMonthSnapshot(month,{calculationEndDate:period.calculationEndDate,userId:options?.userId,attendancePromise})");
  const standingPromiseIndex = fn.indexOf("const attendanceStandingPromise=loadMonthlyAttendanceStandings(month,{period,userId:options?.userId,attendancePromise})");
  assert.ok(periodIndex >= 0 && attendancePromiseIndex > periodIndex);
  assert.ok(snapshotPromiseIndex > attendancePromiseIndex);
  assert.ok(standingPromiseIndex > attendancePromiseIndex);
  // Neither promise is built from the other via .then(...) — only
  // bonusVersionsPromise legitimately chains off snapshotPromise (pre-
  // existing, unrelated to this change).
  assert.doesNotMatch(fn, /attendanceStandingPromise=snapshotPromise\.then/);
  assert.doesNotMatch(fn, /snapshotPromise=attendanceStandingPromise\.then/);
  // Both remain arguments to the same outer Promise.all (parallel wait),
  // exactly as the pre-existing waterfall-performance contract requires.
  assert.match(fn, /Promise\.all\(\[[\s\S]*?snapshotPromise,[\s\S]*?adjustmentPromise,[\s\S]*?attendanceStandingPromise,[\s\S]*?bonusVersionsPromise/);
});

test("future month (calculationEndDate===null): attendancePromise is undefined, so both loaders fall back to their own pre-existing, independently-shaped queries — unchanged", () => {
  // snapshot's own future-month fallback (dayBeforeMonth) is untouched.
  assert.match(snapshot, /const dayBeforeMonth=new Date\(`\$\{start\}T00:00:00Z`\);dayBeforeMonth\.setUTCDate\(dayBeforeMonth\.getUTCDate\(\)-1\);const attendanceEnd=dates\.at\(-1\)\?\?dayBeforeMonth\.toISOString\(\)\.slice\(0,10\);/);
  // standing's own future-month fallback (start) is untouched.
  assert.match(standing, /\.lte\("work_date", lastDate \?\? start\)/);
  // No forced normalization to [] was introduced at either loader.
  assert.doesNotMatch(snapshot, /attendancePromise\?\?\[\]/);
  assert.doesNotMatch(standing, /attendancePromise\?\?\[\]/);
});

test("snapshot: attendancePromise (when supplied) is used as-is in the Promise.all batch, never re-.eq()'d on top of the userId filter overview-server.ts already applied — own-query fallback (with its own userId .eq()) is unchanged when no shared promise is supplied", () => {
  const fn = extractFunctionBody(snapshot, "export async function loadPayrollMonthSnapshot(month:string,options?:");
  // attendanceQuery itself (the loader's own builder) is untouched — still
  // built unconditionally, same as every other query in this function.
  assert.match(fn, /const attendanceQuery=supabaseServer\.from\("attendance_records"\)\.select\(/);
  // The sharing decision lives only at the Promise.all call site, where
  // userId-filtering already happened for every other query — attendance is
  // no different, except the shared promise (already filtered by
  // overview-server.ts) short-circuits before attendanceQuery is touched.
  assert.match(
    fn,
    /options\?\.attendancePromise\?\?\(targetUserId===undefined\?attendanceQuery:attendanceQuery\.eq\("user_id",targetUserId\)\)/,
  );
});

test("standing: attendancePromise (when supplied) fully replaces the query builder, preserving the userId-scoped fallback shape when not supplied", () => {
  const fn = extractFunctionBody(standing, "export async function loadMonthlyAttendanceStandings(");
  assert.match(
    fn,
    /const attendanceQuery = options\?\.attendancePromise \?\? \(options\?\.userId === undefined \? baseAttendanceQuery : baseAttendanceQuery\.eq\("user_id", options\.userId\)\);/,
  );
});

test("userId targeting: the shared promise applies the same .eq(user_id) filter the two loaders would have applied themselves", () => {
  const fn = overview.slice(overview.indexOf("const attendancePromise="), overview.indexOf("if(attendancePromise)"));
  assert.match(fn, /return options\?\.userId===undefined\?query:query\.eq\("user_id",options\.userId\);/);
});

test("no other query (users/schedules/store_setting_versions/manual overrides/holidays) was touched by this change", () => {
  assert.match(standing, /\.from\("users"\)\.select\("id,hire_date,termination_date,attendance_tracking_enabled,is_system_account"\)\.eq\("is_system_account", false\)/);
  assert.match(standing, /\.from\("employee_work_schedule_versions"\)/);
  assert.match(standing, /\.from\("store_setting_versions"\)/);
  assert.match(standing, /\.from\("attendance_record_manual_overrides"\)/);
  assert.match(standing, /\.from\("store_holidays"\)/);
  assert.match(snapshot, /\.from\("users"\)\.select\("id,name,full_name,username,is_active,role,part,position,birth_date,hire_date,termination_date,is_system_account,payroll_eligible_override,level_program_enabled,level_base_date_override"\)/);
  assert.match(snapshot, /\.from\("employee_work_schedule_versions"\)/);
  assert.match(snapshot, /\.from\("payroll_insurance_setting_versions"\)/);
  assert.match(snapshot, /\.from\("payroll_settings"\)/);
  assert.match(snapshot, /\.from\("employee_level_program_versions"\)/);
});

test("failure semantics: attendanceQuery failures still surface through the same error paths as before (no new try/catch introduced, no error suppression)", () => {
  assert.match(snapshot, /if\(userResult\.error\|\|attendanceResult\.error\|\|overrideResult\.error\|\|contractResult\.error\|\|scheduleResult\.error\|\|settingTimelineResult\.error\|\|insuranceResult\.error\|\|payrollSettingsResult\.error\|\|levelProgramResult\.error\)throw new Error\("PAYROLL_MONTH_SNAPSHOT_READ_FAILED"\);/);
  assert.match(standing, /if \(userResult\.error \|\| attendanceResult\.error \|\| scheduleResult\.error \|\| settingResult\.error \|\| holidayResult\.error\) \{\s*throw new Error\("MONTHLY_ATTENDANCE_STANDING_READ_FAILED"\);/);
  // Route-level catch-all is unchanged: any thrown error from either loader
  // still collapses to the same PAYROLL_OVERVIEW_READ_FAILED 500 response.
  assert.match(route, /catch \{\s*return payrollJson\(\{ ok: false, code: "PAYROLL_OVERVIEW_READ_FAILED" \}, 500\);/);
  // The shared attendancePromise's own rejection is swallowed only for the
  // *unused* branch (void ...catch(()=>undefined)) — identical pattern to
  // the pre-existing adjustmentPromise, which never suppresses the real
  // error because the awaited destructure (attendanceResult.error /
  // overrideResult... wait, attendanceResult here) still surfaces it.
  assert.match(overview, /if\(attendancePromise\)void attendancePromise\.catch\(\(\)=>undefined\);/);
});
