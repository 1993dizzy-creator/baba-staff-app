import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node's test runner requires the explicit TypeScript extension.
import {
  resolvePayrollAttendancePolicyByDate,
  type PayrollStoreSettingTimelineRow,
} from "../lib/payroll/store-setting-timeline.ts";

// ---------------------------------------------------------------------------
// /admin/payroll 로딩 성능 최적화 1차 B — loadPayrollMonthSnapshot()이 계산 대상
// 날짜마다 store_get_settings_overview_v1 RPC를 반복 호출하던 것을, active
// store_setting_versions timeline을 한 번만 읽어 메모리에서 resolve하도록 바꾼다.
// 이 파일은 그 resolver(순수 함수)가 기존 RPC의 current 선택 규칙(state='active' and
// effective_from_business_date <= date, order by effective_from_business_date desc,
// id desc limit 1)과 완전히 동일한 결과를 내는지 고정한다.
// ---------------------------------------------------------------------------

function row(
  id: number,
  revision: number,
  effectiveFromBusinessDate: string,
  lateGraceMinutes: number | null,
  earlyLeaveGraceMinutes: number | null,
): PayrollStoreSettingTimelineRow {
  return { id, revision, effectiveFromBusinessDate, lateGraceMinutes, earlyLeaveGraceMinutes };
}

test("1) no setting version at all: revision null / late 0 / early 0 — same fallback as overview.current being null (fallbackStoreSetting is never called)", () => {
  const result = resolvePayrollAttendancePolicyByDate(["2026-08-01"], []);
  assert.deepEqual(result.get("2026-08-01"), { revision: null, lateGraceMinutes: 0, earlyLeaveGraceMinutes: 0 });
});

test("2) a version effective before the month applies to the month-start date", () => {
  const timeline = [row(1, 3, "2026-07-20", 0, 0)];
  const result = resolvePayrollAttendancePolicyByDate(["2026-08-01"], timeline);
  assert.deepEqual(result.get("2026-08-01"), { revision: 3, lateGraceMinutes: 0, earlyLeaveGraceMinutes: 0 });
});

test("3) mid-month effective date change: the new revision applies starting exactly on its effective date", () => {
  const timeline = [row(1, 12, "2026-07-26", 0, 90), row(2, 13, "2026-08-03", 0, 60)];
  const result = resolvePayrollAttendancePolicyByDate(["2026-08-03"], timeline);
  assert.deepEqual(result.get("2026-08-03"), { revision: 13, lateGraceMinutes: 0, earlyLeaveGraceMinutes: 60 });
});

test("4) the day before a mid-month change still uses the previous revision", () => {
  const timeline = [row(1, 12, "2026-07-26", 0, 90), row(2, 13, "2026-08-03", 0, 60)];
  const result = resolvePayrollAttendancePolicyByDate(["2026-08-02"], timeline);
  assert.deepEqual(result.get("2026-08-02"), { revision: 12, lateGraceMinutes: 0, earlyLeaveGraceMinutes: 90 });
});

test("5) a version with no store_attendance_policies row (null grace fields) falls back to 0/0, not fallbackStoreSetting's other defaults", () => {
  const timeline = [row(1, 5, "2026-08-01", null, null)];
  const result = resolvePayrollAttendancePolicyByDate(["2026-08-01"], timeline);
  assert.deepEqual(result.get("2026-08-01"), { revision: 5, lateGraceMinutes: 0, earlyLeaveGraceMinutes: 0 });
});

test("6) dates=[] resolves to an empty Map without needing any timeline rows", () => {
  const result = resolvePayrollAttendancePolicyByDate([], [row(1, 5, "2026-08-01", 0, 0)]);
  assert.equal(result.size, 0);
});

test("7) 2026-08 production example: 08-01~08-02 uses revision 12 (early=90), 08-03 onward uses revision 13 (early=60)", () => {
  const timeline = [
    row(101, 3, "2026-07-20", 0, 0),
    row(102, 12, "2026-07-26", 0, 90),
    row(103, 13, "2026-08-03", 0, 60),
  ];
  const dates = ["2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06", "2026-08-07"];
  const result = resolvePayrollAttendancePolicyByDate(dates, timeline);
  assert.deepEqual(result.get("2026-08-01"), { revision: 12, lateGraceMinutes: 0, earlyLeaveGraceMinutes: 90 });
  assert.deepEqual(result.get("2026-08-02"), { revision: 12, lateGraceMinutes: 0, earlyLeaveGraceMinutes: 90 });
  for (const date of ["2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06", "2026-08-07"]) {
    assert.deepEqual(result.get(date), { revision: 13, lateGraceMinutes: 0, earlyLeaveGraceMinutes: 60 });
  }
});

test("8) storeSettingRevisions parity: iterating dates in ascending order and collecting distinct revisions in first-seen order reproduces [12, 13] for the 2026-08 example (same as the old per-date RPC loop)", () => {
  const timeline = [row(102, 12, "2026-07-26", 0, 90), row(103, 13, "2026-08-03", 0, 60)];
  const dates = ["2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06", "2026-08-07"];
  const result = resolvePayrollAttendancePolicyByDate(dates, timeline);
  const storeSettingRevisions = [...new Set([...result.values()].map((value) => value.revision).filter((value) => value !== null))];
  assert.deepEqual(storeSettingRevisions, [12, 13]);
});

test("tie-break: same effective_from_business_date picks the higher id, matching 'order by effective_from_business_date desc, id desc limit 1'", () => {
  const timeline = [row(10, 20, "2026-08-01", 5, 5), row(11, 21, "2026-08-01", 7, 7)];
  const result = resolvePayrollAttendancePolicyByDate(["2026-08-01"], timeline);
  assert.deepEqual(result.get("2026-08-01"), { revision: 21, lateGraceMinutes: 7, earlyLeaveGraceMinutes: 7 });
});

test("tie-break holds regardless of input row order (id 21 listed first, id 20 second)", () => {
  const timeline = [row(11, 21, "2026-08-01", 7, 7), row(10, 20, "2026-08-01", 5, 5)];
  const result = resolvePayrollAttendancePolicyByDate(["2026-08-01"], timeline);
  assert.deepEqual(result.get("2026-08-01"), { revision: 21, lateGraceMinutes: 7, earlyLeaveGraceMinutes: 7 });
});

test("a future-effective version never applies to an earlier date (effective_from_business_date > date is excluded)", () => {
  const timeline = [row(1, 5, "2026-09-01", 10, 10)];
  const result = resolvePayrollAttendancePolicyByDate(["2026-08-31"], timeline);
  assert.deepEqual(result.get("2026-08-31"), { revision: null, lateGraceMinutes: 0, earlyLeaveGraceMinutes: 0 });
});

test("each date in a multi-date call is resolved independently, not by the last date's version alone", () => {
  const timeline = [row(1, 1, "2026-01-01", 1, 1), row(2, 2, "2026-08-05", 2, 2)];
  const result = resolvePayrollAttendancePolicyByDate(["2026-08-01", "2026-08-05", "2026-08-10"], timeline);
  assert.deepEqual(result.get("2026-08-01"), { revision: 1, lateGraceMinutes: 1, earlyLeaveGraceMinutes: 1 });
  assert.deepEqual(result.get("2026-08-05"), { revision: 2, lateGraceMinutes: 2, earlyLeaveGraceMinutes: 2 });
  assert.deepEqual(result.get("2026-08-10"), { revision: 2, lateGraceMinutes: 2, earlyLeaveGraceMinutes: 2 });
});
