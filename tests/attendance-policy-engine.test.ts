import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node's direct TypeScript tests require an explicit extension.
import { calculateAttendanceBusinessDate, evaluateAttendancePolicy, type AttendancePolicyInput } from "../lib/attendance/policy-engine.ts";

const base: AttendancePolicyInput = {
  businessDate: "2026-07-24",
  timezone: "Asia/Ho_Chi_Minh",
  businessDayCutoffTime: "03:00",
  settingsRevision: 3,
  scheduledStartTime: "16:00",
  scheduledEndTime: "01:00",
  storeOpenTime: "16:00",
  storeCloseTime: "01:00",
  lateGraceMinutes: 0,
  defaultNormalCheckoutTime: "00:00",
  overrideCloseTime: null,
  checkInAt: "2026-07-24T16:00:00+07:00",
  checkOutAt: null,
  now: "2026-07-24T20:00:00+07:00",
};

function evaluate(patch: Partial<AttendancePolicyInput>) {
  return evaluateAttendancePolicy({ ...base, ...patch });
}

test("business date uses the configured strict cutoff boundary", () => {
  assert.equal(
    calculateAttendanceBusinessDate({
      timestamp: "2026-07-25T02:59:00+07:00",
      timezone: "Asia/Ho_Chi_Minh",
      cutoffTime: "03:00",
    }),
    "2026-07-24"
  );
  assert.equal(
    calculateAttendanceBusinessDate({
      timestamp: "2026-07-25T03:00:00+07:00",
      timezone: "Asia/Ho_Chi_Minh",
      cutoffTime: "03:00",
    }),
    "2026-07-25"
  );
  assert.equal(
    calculateAttendanceBusinessDate({
      timestamp: "2026-07-25T03:30:00+07:00",
      timezone: "Asia/Ho_Chi_Minh",
      cutoffTime: "04:00",
    }),
    "2026-07-24"
  );
});

test("late grace keeps the raw difference and suppresses effective lateness", () => {
  for (const [time, late] of [
    ["16:00", 0],
    ["16:04", 0],
    ["16:05", 0],
    ["16:06", 6],
  ] as const) {
    const result = evaluate({
      lateGraceMinutes: 5,
      checkInAt: `2026-07-24T${time}:00+07:00`,
    });
    assert.equal(result.lateMinutes, late);
    assert.equal(result.rawLateMinutes, time === "16:00" ? 0 : Number(time.slice(3)));
  }

  assert.equal(
    evaluate({
      lateGraceMinutes: 0,
      checkInAt: "2026-07-24T16:01:00+07:00",
    }).lateMinutes,
    1
  );
});

test("default midnight threshold handles the overnight shift", () => {
  const cases = [
    ["2026-07-24T23:59:00+07:00", "early_leave", 61],
    ["2026-07-25T00:00:00+07:00", "done", 0],
    ["2026-07-25T00:30:00+07:00", "done", 0],
  ] as const;
  for (const [checkOutAt, status, earlyLeaveMinutes] of cases) {
    const result = evaluate({ checkOutAt });
    assert.equal(result.status, status);
    assert.equal(result.earlyLeaveMinutes, earlyLeaveMinutes);
  }
});

test("special close overrides the normal checkout threshold", () => {
  const cases = [
    ["2026-07-24T22:59:00+07:00", "early_leave", 121],
    ["2026-07-24T23:00:00+07:00", "done", 0],
    ["2026-07-24T23:20:00+07:00", "done", 0],
  ] as const;
  for (const [checkOutAt, status, earlyLeaveMinutes] of cases) {
    const result = evaluate({
      overrideCloseTime: "23:00",
      checkOutAt,
    });
    assert.equal(result.status, status);
    assert.equal(result.earlyLeaveMinutes, earlyLeaveMinutes);
    assert.equal(result.source.close, "override");
  }
});

test("an earlier employee schedule wins over a later special close", () => {
  assert.equal(
    evaluate({
      scheduledEndTime: "22:00",
      overrideCloseTime: "23:00",
      checkOutAt: "2026-07-24T21:59:00+07:00",
    }).status,
    "early_leave"
  );
  assert.equal(
    evaluate({
      scheduledEndTime: "22:00",
      overrideCloseTime: "23:00",
      checkOutAt: "2026-07-24T22:00:00+07:00",
    }).status,
    "done"
  );
});

test("unresolved begins sixty minutes after the effective store close", () => {
  assert.equal(
    evaluate({ now: "2026-07-25T01:59:59+07:00" }).unresolved,
    false
  );
  assert.equal(
    evaluate({ now: "2026-07-25T02:00:00+07:00" }).unresolved,
    true
  );
  assert.equal(
    evaluate({
      overrideCloseTime: "23:00",
      now: "2026-07-24T23:59:59+07:00",
    }).unresolved,
    false
  );
  assert.equal(
    evaluate({
      overrideCloseTime: "23:00",
      now: "2026-07-25T00:00:00+07:00",
    }).unresolved,
    true
  );
});

test("midnight boundary instants are stable and timezone explicit", () => {
  const result = evaluate({
    overrideCloseTime: "23:00",
    checkOutAt: "2026-07-25T00:00:00+07:00",
  });
  assert.equal(result.overrideCloseAt, "2026-07-24T16:00:00.000Z");
  assert.equal(result.scheduledEndAt, "2026-07-24T18:00:00.000Z");
  assert.equal(result.status, "done");
  assert.throws(
    () => evaluate({ timezone: "UTC" }),
    /Unsupported attendance timezone/
  );
});
