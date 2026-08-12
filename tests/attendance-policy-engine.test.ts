import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node's direct TypeScript tests require an explicit extension.
import { calculateAttendanceBusinessDate, evaluateAttendancePolicy, getAdminMissingCheckoutReviewAt, isAdminMissingCheckoutReviewAvailable, type AttendancePolicyInput } from "../lib/attendance/policy-engine.ts";

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
  earlyLeaveGraceMinutes: 0,
  missingCheckoutGraceMinutes: 60,
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

test("general staff: scheduled end equals store close, so the standard checkout is 01:00", () => {
  const result = evaluate({
    scheduledEndTime: "01:00",
    storeCloseTime: "01:00",
  });
  assert.equal(result.normalCheckoutThresholdAt, "2026-07-24T18:00:00.000Z");
});

test("part-time staff: employee's earlier scheduled end wins over the later store close", () => {
  const result = evaluate({
    scheduledEndTime: "22:00",
    storeCloseTime: "01:00",
  });
  assert.equal(result.normalCheckoutThresholdAt, "2026-07-24T15:00:00.000Z");
});

test("special close overrides the store close and can win or lose against the employee schedule", () => {
  const overridesLater = evaluate({
    scheduledEndTime: "01:00",
    storeCloseTime: "01:00",
    overrideCloseTime: "23:00",
  });
  assert.equal(overridesLater.normalCheckoutThresholdAt, "2026-07-24T16:00:00.000Z");
  assert.equal(overridesLater.source.close, "override");

  const employeeWinsAnyway = evaluate({
    scheduledEndTime: "22:00",
    storeCloseTime: "01:00",
    overrideCloseTime: "23:00",
  });
  assert.equal(employeeWinsAnyway.normalCheckoutThresholdAt, "2026-07-24T15:00:00.000Z");
  assert.equal(employeeWinsAnyway.source.close, "override");
});

test("admin missing-checkout review waits for store close plus 30 minutes regardless of employee schedule", () => {
  for (const scheduledEndTime of ["17:00", "23:00", "01:00"]) {
    const policy = evaluate({ scheduledEndTime, storeCloseTime: "01:00" });
    assert.equal(policy.effectiveStoreCloseAt, "2026-07-24T18:00:00.000Z");
    assert.equal(
      getAdminMissingCheckoutReviewAt(policy.effectiveStoreCloseAt),
      "2026-07-24T18:30:00.000Z"
    );
    assert.equal(isAdminMissingCheckoutReviewAvailable({
      checkInAt: base.checkInAt,
      checkOutAt: null,
      effectiveStoreCloseAt: policy.effectiveStoreCloseAt,
      now: "2026-07-25T01:29:59+07:00",
    }), false);
    assert.equal(isAdminMissingCheckoutReviewAvailable({
      checkInAt: base.checkInAt,
      checkOutAt: null,
      effectiveStoreCloseAt: policy.effectiveStoreCloseAt,
      now: "2026-07-25T01:30:00+07:00",
    }), true);
  }
});

test("admin review threshold follows a special early store close, while auto-close uses the earlier schedule/store instant", () => {
  const policy = evaluate({
    scheduledEndTime: "01:00",
    storeCloseTime: "01:00",
    overrideCloseTime: "23:30",
  });
  assert.equal(policy.normalCheckoutThresholdAt, "2026-07-24T16:30:00.000Z");
  assert.equal(policy.effectiveStoreCloseAt, "2026-07-24T16:30:00.000Z");
  assert.equal(getAdminMissingCheckoutReviewAt(policy.effectiveStoreCloseAt), "2026-07-24T17:00:00.000Z");
});

test("schedule-based auto-close produces no early leave or open-record status", () => {
  for (const [scheduledStartTime, scheduledEndTime, expectedMinutes] of [
    ["16:00", "17:00", 60],
    ["17:00", "23:00", 360],
    ["18:00", "23:00", 300],
    ["16:00", "01:00", 540],
  ] as const) {
    const open = evaluate({
      scheduledStartTime,
      scheduledEndTime,
      storeCloseTime: "01:00",
      checkInAt: `2026-07-24T${scheduledStartTime}:00+07:00`,
      checkOutAt: null,
    });
    const closed = evaluate({
      scheduledStartTime,
      scheduledEndTime,
      storeCloseTime: "01:00",
      checkInAt: `2026-07-24T${scheduledStartTime}:00+07:00`,
      checkOutAt: open.normalCheckoutThresholdAt,
    });
    assert.equal(closed.status, "done");
    assert.equal(closed.earlyLeaveMinutes, 0);
    assert.equal(closed.unresolved, false);
    assert.equal(
      Math.floor((new Date(open.normalCheckoutThresholdAt!).getTime() - new Date(`2026-07-24T${scheduledStartTime}:00+07:00`).getTime()) / 60_000),
      expectedMinutes
    );
  }
});

test("missing employee end time falls back to the effective store close", () => {
  const result = evaluate({
    scheduledEndTime: null,
    storeCloseTime: "01:00",
  });
  assert.equal(result.normalCheckoutThresholdAt, "2026-07-24T18:00:00.000Z");
});

test("overnight shift crosses the calendar day at the correct instant", () => {
  const result = evaluate({
    businessDate: "2026-07-25",
    scheduledEndTime: "01:00",
    storeCloseTime: "01:00",
  });
  assert.equal(result.normalCheckoutThresholdAt, "2026-07-25T18:00:00.000Z");
});

test("early leave grace is a deducted allowance, not an all-or-nothing threshold", () => {
  // raw는 checkOutAt과 22:00(예정 퇴근=매장 마감) 사이 분. grace=5분이면
  // raw<=5는 전액 공제되어 0/done, raw=6부터 1분만 조퇴로 남는다.
  const cases = [
    ["2026-07-24T21:56:00+07:00", "done", 0], // raw 4
    ["2026-07-24T21:55:00+07:00", "done", 0], // raw 5 == grace: 경계값도 전액 공제
    ["2026-07-24T21:54:00+07:00", "early_leave", 1], // raw 6
  ] as const;
  for (const [checkOutAt, status, earlyLeaveMinutes] of cases) {
    const result = evaluate({
      scheduledEndTime: "22:00",
      storeCloseTime: "22:00",
      earlyLeaveGraceMinutes: 5,
      checkOutAt,
    });
    assert.equal(result.status, status);
    assert.equal(result.earlyLeaveMinutes, earlyLeaveMinutes);
  }
});

// Quyen(2026-08-04) 재현 시나리오: 예정 퇴근 01:00, 실제 퇴근 23:30, 유예 60분.
// raw 90분에서 유예 60분을 공제한 30분만 조퇴로 인정되어야 한다(관리자 수정으로
// 퇴근시각을 23:30으로 고쳐도 early_leave_minutes=0/done으로 떨어지면 안 된다).
test("Quyen 2026-08-04 reproduction: raw 90 minutes, 60 minute grace, keeps 30 minutes early leave", () => {
  const result = evaluate({
    scheduledEndTime: "01:00",
    storeCloseTime: "01:00",
    earlyLeaveGraceMinutes: 60,
    checkOutAt: "2026-07-24T23:30:00+07:00",
  });
  assert.equal(result.rawEarlyLeaveMinutes, 90);
  assert.equal(result.earlyLeaveMinutes, 30);
  assert.equal(result.status, "early_leave");
});

test("early leave grace boundary: 59/60/61 minutes raw against a 60 minute grace", () => {
  // 예정 퇴근(=매장 마감) 임계값은 다음날 01:00. raw는 그 임계값까지 남은 분.
  const cases = [
    ["2026-07-25T00:01:00+07:00", 59, 0, "done"],
    ["2026-07-25T00:00:00+07:00", 60, 0, "done"],
    ["2026-07-24T23:59:00+07:00", 61, 1, "early_leave"],
  ] as const;
  for (const [checkOutAt, rawEarlyLeaveMinutes, earlyLeaveMinutes, status] of cases) {
    const result = evaluate({
      scheduledEndTime: "01:00",
      storeCloseTime: "01:00",
      earlyLeaveGraceMinutes: 60,
      checkOutAt,
    });
    assert.equal(result.rawEarlyLeaveMinutes, rawEarlyLeaveMinutes);
    assert.equal(result.earlyLeaveMinutes, earlyLeaveMinutes);
    assert.equal(result.status, status);
  }
});

test("zero grace reflects the full raw early leave minutes", () => {
  const result = evaluate({
    scheduledEndTime: "01:00",
    storeCloseTime: "01:00",
    earlyLeaveGraceMinutes: 0,
    checkOutAt: "2026-07-24T23:30:00+07:00",
  });
  assert.equal(result.rawEarlyLeaveMinutes, 90);
  assert.equal(result.earlyLeaveMinutes, 90);
  assert.equal(result.status, "early_leave");
});

test("no checkout keeps status working regardless of grace or schedule", () => {
  const result = evaluate({
    scheduledEndTime: "01:00",
    storeCloseTime: "01:00",
    earlyLeaveGraceMinutes: 60,
    checkOutAt: null,
  });
  assert.equal(result.status, "working");
  assert.equal(result.earlyLeaveMinutes, 0);
  assert.equal(result.rawEarlyLeaveMinutes, 0);
});

test("missing checkout is judged sixty minutes after the standard checkout time", () => {
  assert.equal(
    evaluate({
      scheduledEndTime: "22:00",
      storeCloseTime: "22:00",
      missingCheckoutGraceMinutes: 60,
      now: "2026-07-24T22:59:59+07:00",
    }).unresolved,
    false
  );
  assert.equal(
    evaluate({
      scheduledEndTime: "22:00",
      storeCloseTime: "22:00",
      missingCheckoutGraceMinutes: 60,
      now: "2026-07-24T23:00:00+07:00",
    }).unresolved,
    true
  );
});

test("part-time staff missing checkout is not delayed until the late-night store close", () => {
  // 파트타임 직원(16:00~22:00)은 매장이 01:00까지 영업하더라도 22:00 기준으로
  // 60분 뒤인 23:00부터 미퇴근으로 판정되어야 한다.
  assert.equal(
    evaluate({
      scheduledEndTime: "22:00",
      storeCloseTime: "01:00",
      missingCheckoutGraceMinutes: 60,
      now: "2026-07-24T22:59:59+07:00",
    }).unresolved,
    false
  );
  assert.equal(
    evaluate({
      scheduledEndTime: "22:00",
      storeCloseTime: "01:00",
      missingCheckoutGraceMinutes: 60,
      now: "2026-07-24T23:00:00+07:00",
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

test("out-of-range grace minutes are rejected", () => {
  assert.throws(
    () => evaluate({ earlyLeaveGraceMinutes: 181 }),
    /Invalid early leave grace minutes/
  );
  assert.throws(
    () => evaluate({ missingCheckoutGraceMinutes: 361 }),
    /Invalid missing checkout grace minutes/
  );
});
