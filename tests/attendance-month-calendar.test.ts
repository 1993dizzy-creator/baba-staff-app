import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = ts.transpileModule(readFileSync("lib/attendance/month-calendar.ts", "utf8"), {
  compilerOptions: { module: ts.ModuleKind.ESNext },
}).outputText.replace('"./display-status"', JSON.stringify(new URL("../lib/attendance/display-status.ts", import.meta.url).href));
const { getAttendanceMonthCells, getAttendanceCalendarStatus } = await import("data:text/javascript," + encodeURIComponent(source));

test("calendar covers every date once, aligns Sunday to Saturday and uses five or six weeks", () => {
  for (const [month, days, weeks, offset] of [
    ["2026-11", 30, 5, 0], ["2026-08", 31, 6, 6], ["2026-02", 28, 5, 0],
    ["2024-02", 29, 5, 4], ["2026-12", 31, 5, 2],
  ] as const) {
    const cells: (string | null)[] = getAttendanceMonthCells(month);
    assert.equal(cells.length, weeks * 7);
    assert.equal(cells.indexOf(`${month}-01`), offset);
    assert.deepEqual(cells.filter(Boolean), Array.from({ length: days }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`));
  }
});

test("calendar preserves existing verdicts and distinguishes open, pending, missing and future records", () => {
  const state = (record: object | null, date = "2026-11-01") => getAttendanceCalendarStatus(record, date, "2026-11-15");
  assert.equal(state(null), "none");
  assert.equal(state(null, "2026-11-16"), "future");
  assert.equal(state({ status: "done", late_minutes: 0 }), "normal");
  assert.equal(state({ status: "done", late_minutes: 10 }), "late");
  assert.equal(state({ status: "early_leave", early_leave_minutes: 20 }), "early_leave");
  assert.equal(state({ status: "unauthorized_absence" }), "unauthorized_absence");
  assert.equal(state({ status: "leave", approval_status: "approved" }), "approved_leave");
  for (const approval_status of ["pending", null]) assert.equal(state({ status: "leave", approval_status }), "pending");
  assert.equal(state({ status: "working", check_in_at: "2026-11-01T09:00:00Z", check_out_at: null }), "working");
  assert.equal(state({ status: "working", check_in_at: "2026-11-01T09:00:00Z", late_minutes: 5 }), "late");
  // Normalized lateness stays normal; approved future leave retains its evidence.
  assert.equal(state({ status: "late", late_minutes: 0, check_out_at: "2026-11-01T18:00:00Z" }), "normal");
  assert.equal(state({ status: "leave", approval_status: "approved" }, "2026-11-16"), "approved_leave");
});
