import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node's direct TypeScript tests require an explicit extension.
import { buildAdminAttendancePolicyInput, selectActiveScheduleVersion } from "../lib/attendance/policy-resolution-core.ts";
import type { StoreSetting } from "../lib/store-settings/types";

function setting(patch: Partial<StoreSetting> = {}): StoreSetting {
  return {
    id: 13,
    timezone: "Asia/Ho_Chi_Minh",
    businessDayCutoffTime: "03:00",
    effectiveFromBusinessDate: "2026-07-01",
    revision: 13,
    state: "active",
    createdBy: 1,
    createdAt: "",
    cancelledBy: null,
    cancelledAt: null,
    attendancePolicy: {
      lateGraceMinutes: 0,
      earlyLeaveGraceMinutes: 60,
      missingCheckoutGraceMinutes: 60,
      defaultNormalCheckoutTime: "00:00",
    },
    hours: Array.from({ length: 7 }, (_, weekday) => ({
      weekday,
      isClosed: false,
      openTime: "16:00",
      closeTime: "01:00",
    })),
    ...patch,
  };
}

test("selectActiveScheduleVersion picks the row whose effective range covers work_date", () => {
  const rows = [
    { startTime: "16:00", endTime: "00:00", effectiveFrom: "2026-06-01", effectiveTo: "2026-07-15" },
    { startTime: "16:00", endTime: "01:00", effectiveFrom: "2026-07-15", effectiveTo: null },
  ];
  assert.equal(selectActiveScheduleVersion(rows, "2026-08-04")?.endTime, "01:00");
  assert.equal(selectActiveScheduleVersion(rows, "2026-07-01")?.endTime, "00:00");
});

test("selectActiveScheduleVersion returns null when nothing covers the date", () => {
  const rows = [
    { startTime: "16:00", endTime: "00:00", effectiveFrom: "2026-08-05", effectiveTo: null },
  ];
  assert.equal(selectActiveScheduleVersion(rows, "2026-08-04"), null);
});

test("selectActiveScheduleVersion defensively prefers the most recent effective_from on overlap", () => {
  const rows = [
    { startTime: "16:00", endTime: "00:00", effectiveFrom: "2026-08-01", effectiveTo: null },
    { startTime: "16:00", endTime: "01:00", effectiveFrom: "2026-08-03", effectiveTo: null },
  ];
  assert.equal(selectActiveScheduleVersion(rows, "2026-08-04")?.endTime, "01:00");
});

test("buildAdminAttendancePolicyInput prefers the versioned schedule over the users profile fallback", () => {
  const input = buildAdminAttendancePolicyInput({
    workDate: "2026-08-04",
    setting: setting(),
    settingsRevision: 13,
    scheduleVersion: { startTime: "16:00", endTime: "01:00", effectiveFrom: "2026-07-01", effectiveTo: null },
    fallbackScheduledStartTime: "18:00",
    fallbackScheduledEndTime: "23:00",
    lateGraceMinutes: 0,
    earlyLeaveGraceMinutes: 60,
    missingCheckoutGraceMinutes: 60,
    overrideCloseTime: null,
    checkInAt: "2026-08-04T08:51:00.000Z",
    checkOutAt: "2026-08-04T16:30:00.000Z",
  });
  assert.equal(input.scheduledStartTime, "16:00");
  assert.equal(input.scheduledEndTime, "01:00");
});

test("buildAdminAttendancePolicyInput falls back to users.work_start_time/work_end_time when no schedule version exists", () => {
  const input = buildAdminAttendancePolicyInput({
    workDate: "2026-08-04",
    setting: setting(),
    settingsRevision: 13,
    scheduleVersion: null,
    fallbackScheduledStartTime: "18:00",
    fallbackScheduledEndTime: "23:00",
    lateGraceMinutes: 0,
    earlyLeaveGraceMinutes: 60,
    missingCheckoutGraceMinutes: 60,
    overrideCloseTime: null,
    checkInAt: null,
    checkOutAt: null,
  });
  assert.equal(input.scheduledStartTime, "18:00");
  assert.equal(input.scheduledEndTime, "23:00");
});

test("buildAdminAttendancePolicyInput reads the business hour for work_date's weekday and passes through the override", () => {
  const tuesdayClosedSetting = setting({
    hours: Array.from({ length: 7 }, (_, weekday) => ({
      weekday,
      isClosed: weekday === 2,
      openTime: weekday === 2 ? null : "16:00",
      closeTime: weekday === 2 ? null : "01:00",
    })),
  });
  // 2026-08-04 is a Tuesday (weekday 2).
  const input = buildAdminAttendancePolicyInput({
    workDate: "2026-08-04",
    setting: tuesdayClosedSetting,
    settingsRevision: 13,
    scheduleVersion: { startTime: "16:00", endTime: "01:00", effectiveFrom: "2026-07-01", effectiveTo: null },
    fallbackScheduledStartTime: null,
    fallbackScheduledEndTime: null,
    lateGraceMinutes: 0,
    earlyLeaveGraceMinutes: 60,
    missingCheckoutGraceMinutes: 60,
    overrideCloseTime: "23:30",
    checkInAt: null,
    checkOutAt: null,
  });
  assert.equal(input.storeCloseTime, null);
  assert.equal(input.overrideCloseTime, "23:30");
});

test("Quyen 2026-08-04 store setting revision 13 produces the ticket's expected policy input", () => {
  const input = buildAdminAttendancePolicyInput({
    workDate: "2026-08-04",
    setting: setting(),
    settingsRevision: 13,
    scheduleVersion: { startTime: "16:00", endTime: "01:00", effectiveFrom: "2026-07-01", effectiveTo: null },
    fallbackScheduledStartTime: null,
    fallbackScheduledEndTime: null,
    lateGraceMinutes: 0,
    earlyLeaveGraceMinutes: 60,
    missingCheckoutGraceMinutes: 60,
    overrideCloseTime: null,
    checkInAt: "2026-08-04T08:51:00.000Z",
    checkOutAt: "2026-08-04T16:30:00.000Z",
  });
  assert.deepEqual(input, {
    businessDate: "2026-08-04",
    timezone: "Asia/Ho_Chi_Minh",
    businessDayCutoffTime: "03:00",
    settingsRevision: 13,
    scheduledStartTime: "16:00",
    scheduledEndTime: "01:00",
    storeOpenTime: "16:00",
    storeCloseTime: "01:00",
    lateGraceMinutes: 0,
    earlyLeaveGraceMinutes: 60,
    missingCheckoutGraceMinutes: 60,
    overrideCloseTime: null,
    checkInAt: "2026-08-04T08:51:00.000Z",
    checkOutAt: "2026-08-04T16:30:00.000Z",
    now: undefined,
  });
});
