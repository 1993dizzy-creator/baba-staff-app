import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { runInThisContext } from "node:vm";
import { execFileSync } from "node:child_process";
import test from "node:test";
import ts from "typescript";
import { buildEarlyLeaveDisplayContexts } from "../lib/attendance/early-leave-display-context.ts";
import { formatVietnamTime } from "../lib/common/business-time.ts";

const external = createRequire(import.meta.url);
function load(file, stubs, cache = new Map()) {
  const path = resolve(file);
  if (cache.has(path)) return cache.get(path).exports;
  const loadedModule = { exports: {} };
  cache.set(path, loadedModule);
  const code = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const localRequire = (name) => {
    if (stubs.has(name)) return stubs.get(name);
    if (name === "server-only") return {};
    if (name === "@/lib/supabase/server") throw new Error("Remote DB access is forbidden");
    if (name.startsWith(".") || name.startsWith("@/")) {
      let child = name.startsWith("@/") ? resolve(name.slice(2)) : resolve(dirname(path), name);
      if (!existsSync(child)) child += ".ts";
      return load(child, stubs, cache);
    }
    return external(name);
  };
  runInThisContext(`(function(require,module,exports){${code}\n})`, { filename: path })(localRequire, loadedModule, loadedModule.exports);
  return loadedModule.exports;
}
const date = "2026-09-04";
const target = { id: 1, user_id: 1, work_date: date };
const schedule = (user_id, extra = {}) => ({ user_id, start_time: "16:00:00", end_time: "01:00:00", effective_from: "2026-09-01", effective_to: null, ...extra });
const attendance = (user_id, checkout, extra = {}) => ({ id: user_id, user_id, work_date: date, status: "done", check_out_at: checkout, ...extra });
const own = attendance(1, "2026-09-04T23:00:00+07:00");
const context = (records = [own], schedules = [schedule(1)], targets = [target]) => buildEarlyLeaveDisplayContexts(targets, records, schedules).get(1);

test("past card uses date-effective history, not current user times, including exclusive effective_to boundary", () => {
  const result = context([own], [schedule(1, { effective_to: "2026-09-05" }), schedule(1, { start_time: "18:00", end_time: "23:00", effective_from: "2026-09-05" })]);
  assert.equal(result.effectiveScheduleStart, "16:00");
  assert.equal(result.effectiveScheduleEnd, "01:00");
  const nextDay = { ...target, work_date: "2026-09-05" };
  const next = buildEarlyLeaveDisplayContexts([nextDay], [], [schedule(1, { effective_to: "2026-09-05" }), schedule(1, { start_time: "18:00", end_time: "23:00", effective_from: "2026-09-05" })]).get(1);
  assert.equal(next.effectiveScheduleStart, "18:00");
  assert.equal(next.effectiveScheduleEnd, "23:00");
});

test("actual checkout displays the Vietnam wall-clock time from UTC", () => {
  const result = context([{ ...own, check_out_at: "2026-09-04T16:00:00Z" }]);
  assert.equal(formatVietnamTime(result.actualCheckOutAt), "23:00");
});

test("both start and end must match; peer employment category and level are irrelevant", () => {
  const rows = [own,
    attendance(2, "2026-09-05T00:30:00+07:00", { role: "staff", level_program_enabled: false }),
    attendance(3, "2026-09-05T01:00:00+07:00", { role: "part_time", level_program_enabled: true }),
    attendance(4, "2026-09-04T23:00:00+07:00"),
    attendance(5, "2026-09-04T23:00:00+07:00"),
    attendance(6, "2026-09-05T01:00:00+07:00"),
  ];
  const result = context(rows, [schedule(1), schedule(2), schedule(3), schedule(4, { end_time: "23:00" }), schedule(5, { start_time: "17:00", end_time: "23:00" }), schedule(6, { start_time: "18:00" })]);
  assert.equal(result.peerCount, 2);
  assert.equal(formatVietnamTime(result.peerAverageCheckOutAt), "00:45");
});

test("leave, missing checkout, invalid timestamp and target's own checkout never contribute", () => {
  const rows = [own, attendance(2, "2026-09-05T01:00:00+07:00"),
    attendance(3, "2026-09-04T17:00:00+07:00", { status: "leave", approval_status: "approved" }),
    attendance(4, null), attendance(5, "invalid")];
  const result = context(rows, [1,2,3,4,5].map((id) => schedule(id)));
  assert.equal(result.peerCount, 1);
  assert.equal(formatVietnamTime(result.peerAverageCheckOutAt), "01:00");
});

test("zero peers and missing or overlapping historical schedule render dashes without fallback", () => {
  const zero = context();
  assert.equal(zero.peerCount, 0);
  assert.equal(formatVietnamTime(zero.peerAverageCheckOutAt), "-");
  for (const versions of [[], [schedule(1), schedule(1)]]) {
    const missing = context([own, attendance(2, "2026-09-05T01:00:00+07:00")], [...versions, schedule(2)]);
    assert.equal(missing.effectiveScheduleStart, null);
    assert.equal(missing.effectiveScheduleEnd, null);
    assert.equal(missing.peerCount, 0);
    assert.equal(formatVietnamTime(missing.peerAverageCheckOutAt), "-");
    assert.equal(formatVietnamTime(missing.actualCheckOutAt), "23:00");
  }
});

test("23:50, next-day 00:30 and 01:00 average on a continuous business-date axis", () => {
  const rows = [own, attendance(2, "2026-09-04T23:50:00+07:00"), attendance(3, "2026-09-05T00:30:00+07:00"), attendance(4, "2026-09-05T01:00:00+07:00")];
  const result = context(rows, [1,2,3,4].map(id => schedule(id)));
  assert.equal(result.peerCount, 3);
  assert.equal(formatVietnamTime(result.peerAverageCheckOutAt), "00:27");
  assert.equal(result.peerAverageCheckOutAt, "2026-09-04T17:27:00.000Z");
});

test("averages stay date-specific and each review target excludes itself from a shared group", () => {
  const rows = [own, attendance(2, "2026-09-05T01:00:00+07:00"), attendance(3, "2026-09-06T00:00:00+07:00", { work_date: "2026-09-05" })];
  const targets = [target, { id: 2, user_id: 2, work_date: date }];
  const results = buildEarlyLeaveDisplayContexts(targets, rows, [1,2,3].map(id => schedule(id)));
  assert.equal(formatVietnamTime(results.get(1).peerAverageCheckOutAt), "01:00");
  assert.equal(formatVietnamTime(results.get(2).peerAverageCheckOutAt), "23:00");
  assert.equal(results.get(1).peerCount, 1);
});

function database(records, schedules) {
  const calls = [];
  const tables = { attendance_records: records, employee_work_schedule_versions: schedules };
  return { calls, supabaseServer: { from(table) {
    assert.ok(table in tables, `Unexpected table ${table}`);
    const filters = [];
    let includedDates = null;
    const query = {
      select() { return this; },
      in(key, values) { filters.push(row => values.includes(row[key])); if (key === "work_date") includedDates = values; return this; },
      eq(key, value) { filters.push(row => row[key] === value); return this; },
      gte(key, value) { filters.push(row => row[key] >= value); return this; },
      not(key) { filters.push(row => row[key] != null); return this; },
      is(key) { filters.push(row => row[key] == null); return this; },
      lte(key, value) { filters.push(row => row[key] <= value); return this; },
      or() { return this; }, order() { return this; },
      async range(start, end) {
        calls.push({ table, start, end, includedDates });
        return { data: tables[table].filter(row => filters.every(fn => fn(row))).slice(start, end + 1), error: null };
      },
      then(resolve) { return Promise.resolve({ data: tables[table].filter(row => filters.every(fn => fn(row))), error: null }).then(resolve); },
    };
    return query;
  } } };
}
function displayLoader(db) {
  return load("lib/attendance/early-leave-display-context-server.ts", new Map([["@/lib/supabase/server", db]])).loadEarlyLeaveDisplayContexts;
}

test("multiple past-month review cards use two batch reads, independent of selected month and card count", async () => {
  const old = { id: 8, user_id: 1, work_date: "2026-08-31" };
  const records = [own, attendance(2, "2026-09-05T01:00:00+07:00"), attendance(1, "2026-08-31T23:00:00+07:00", old), attendance(2, "2026-09-01T00:00:00+07:00", { id: 9, work_date: "2026-08-31" })];
  const db = database(records, [schedule(1, { effective_from: "2026-08-01" }), schedule(2, { effective_from: "2026-08-01" })]);
  const results = await displayLoader(db)([target, old]);
  assert.equal(db.calls.length, 2);
  assert.equal(formatVietnamTime(results.get(8).peerAverageCheckOutAt), "00:00");
  assert.equal(formatVietnamTime(results.get(1).peerAverageCheckOutAt), "01:00");
  assert.equal(results.get(8).effectiveScheduleEnd, "01:00");
});

test("empty review lists add no DB queries; large batches page past 1000 rows", async () => {
  const empty = database([], []);
  assert.equal((await displayLoader(empty)([])).size, 0);
  assert.equal(empty.calls.length, 0);
  const rows = Array.from({ length: 1002 }, (_, i) => attendance(i+1, "2026-09-05T01:00:00+07:00"));
  const db = database(rows, rows.map(row => schedule(row.user_id)));
  const results = await displayLoader(db)([target]);
  assert.equal(results.get(1).peerCount, 1001);
  assert.equal(db.calls.length, 4);
});

test("admin GET adds evidence while retaining every existing review field and POST implementation", async () => {
  const review = { ...target, rawEarlyLeaveMinutes: 120, earlyLeaveGraceMinutes: 60, effectiveEarlyLeaveMinutes: 60,
    normalCheckoutThresholdAt: "2026-09-05T01:00:00+07:00", earlyLeaveSelection: null, earlyLeaveReviewRequired: true };
  const db = database([own, attendance(2, "2026-09-05T01:00:00+07:00")], [schedule(1), schedule(2)]);
  const stubs = new Map([
    ["@/lib/supabase/server", db],
    ["next/server", { NextResponse: { json: (value, init) => Response.json(value, init) } }],
    ["@/lib/attendance/server-api", { requireAttendanceActor: async () => ({ ok: true, actor: { id: 1, role: "owner" } }) }],
    ["@/lib/attendance/early-leave-review-server", { loadEarlyLeaveReviewContexts: async () => new Map([[1,review]]) }],
  ]);
  // users is an existing lookup, separate from the two new evidence reads.
  const from = db.supabaseServer.from;
  db.supabaseServer.from = (table) => table === "users" ? {
    select() { return this; }, in: async () => ({ data: [{ id: 1, name: "Khoi", work_start_time: "18:00", work_end_time: "23:00" }], error: null }),
  } : from(table);
  const route = load("app/api/attendance/admin/route.ts", stubs);
  const response = await route.GET(new Request("http://localhost/api/attendance/admin"));
  assert.equal(response.status, 200);
  const data = await response.json();
  const enriched = data.earlyLeaveReviewRecords[0];
  for (const [key,value] of Object.entries(review)) assert.equal(enriched[key], value, key);
  assert.equal(enriched.effectiveScheduleStart, "16:00");
  assert.equal(enriched.effectiveScheduleEnd, "01:00");
  assert.equal(enriched.user.work_end_time, "23:00");
  assert.equal(enriched.peerCount, 1);
  assert.equal(formatVietnamTime(enriched.peerAverageCheckOutAt), "01:00");
  assert.deepEqual(data.unresolvedOpenRecords, []);
  const current = readFileSync("app/api/attendance/admin/route.ts", "utf8");
  const baseline = execFileSync("git", ["show", "HEAD:app/api/attendance/admin/route.ts"], { encoding: "utf8" });
  assert.equal(current.slice(current.indexOf("export async function POST")), baseline.slice(baseline.indexOf("export async function POST")));
});

test("card renders evidence in both languages, wraps on mobile and keeps detail navigation and original minutes", () => {
  const page = readFileSync("app/(protected)/admin/payroll/attendance/page.tsx", "utf8");
  const card = page.slice(page.indexOf("{earlyLeaveReviewRecords.map"), page.indexOf("{unresolvedOpenRecords.length > 0"));
  for (const field of ["effectiveScheduleStart", "effectiveScheduleEnd", "actualCheckOutAt", "peerAverageCheckOutAt", "rawEarlyLeaveMinutes", "effectiveEarlyLeaveMinutes"]) assert.ok(card.includes(`record.${field}`), field);
  assert.ok(card.includes("퇴근"));
  assert.ok(card.includes("평균 퇴근"));
  assert.ok(card.includes("Tan ca"));
  assert.match(card, /goDetailForDate\(record.user_id, record.work_date\)/);
  assert.doesNotMatch(card, /work_start_time|work_end_time|level_program_enabled|role ===/);
  assert.match(page, /const earlyLeaveCheckoutComparisonStyle[\s\S]*?flexWrap: "wrap"/);
});



test("detail API reuses banner evidence for pending and confirmed reviews, batching only relevant dates", async () => {
  const secondTarget = { id: 3, user_id: 1, work_date: "2026-09-05" };
  const unrelated = attendance(1, "2026-09-06T23:00:00+07:00", { id: 5, work_date: "2026-09-06" });
  const rows = [own, attendance(2,"2026-09-05T01:00:00+07:00"),
    attendance(1,"2026-09-05T23:00:00+07:00", secondTarget),
    attendance(2,"2026-09-06T00:00:00+07:00", { id: 4, work_date: "2026-09-05" }), unrelated];
  const db = database(rows,[schedule(1),schedule(2)]);
  const expected = await displayLoader(db)([target,secondTarget]);
  db.calls.length = 0;
  const contexts = new Map([
    [1,{ ...target, rawEarlyLeaveMinutes: 120, effectiveEarlyLeaveMinutes: 60, earlyLeaveGraceMinutes: 60,
      earlyLeaveReviewRequired: true, earlyLeaveSelection: null }],
    [3,{ ...secondTarget, rawEarlyLeaveMinutes: 64, effectiveEarlyLeaveMinutes: 4, earlyLeaveGraceMinutes: 60,
      earlyLeaveReviewRequired: false, earlyLeaveSelection: "use_effective" }],
  ]);
  const from = db.supabaseServer.from;
  db.supabaseServer.from = (table) => table === "users" ? {
    select() { return this; }, eq() { return this; },
    maybeSingle: async () => ({ data: { id: 1,work_start_time: "18:00",work_end_time: "23:00" },error:null }),
  } : from(table);
  const route = load("app/api/attendance/records/route.ts", new Map([
    ["@/lib/supabase/server",db],
    ["@/lib/attendance/server-api", { requireAttendanceActor: async () => ({ok:true,actor:{id:1,role:"owner"}}), attendanceJson: value => Response.json(value) }],
    ["@/lib/attendance/early-leave-review-server", { loadEarlyLeaveReviewContexts: async () => contexts }],
  ]));
  const request = () => new Request("http://localhost/api/attendance/records?scope=admin_user_month&user_id=1&month=2026-09");
  const response = await route.GET(request());
  assert.equal(response.status,200);
  const result = await response.json();
  assert.equal(db.calls.length,2);
  const attendanceRead = db.calls.find(call => call.table === "attendance_records");
  assert.deepEqual(attendanceRead.includedDates,["2026-09-04","2026-09-05"]);
  for(const id of [1,3]) {
    const record = result.records.find(record => record.id === id);
    assert.deepEqual(record.early_leave_display_context,expected.get(id));
    assert.deepEqual(record.early_leave_review,contexts.get(id));
  }
  assert.equal(result.records.find(record => record.id === 5).early_leave_display_context,null);
  contexts.clear();
  db.calls.length = 0;
  const noReviews = await (await route.GET(request())).json();
  assert.equal(noReviews.ok,true);
  assert.equal(db.calls.length,0);
});
