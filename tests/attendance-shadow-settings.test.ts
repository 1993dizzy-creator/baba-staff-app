import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
// @ts-expect-error Node's direct TypeScript tests require an explicit extension.
import { resolveAttendanceShadowSetting } from "../lib/attendance/shadow-settings.ts";
// @ts-expect-error Node's direct TypeScript tests require an explicit extension.
import { evaluateAttendancePolicy } from "../lib/attendance/policy-engine.ts";
import type { StoreSetting } from "../lib/store-settings/types.ts";

const read = (path: string) =>
  readFileSync(join(process.cwd(), path), "utf8");

function setting(
  businessDate: string,
  patch: Partial<StoreSetting> = {}
): StoreSetting {
  return {
    id: 0,
    timezone: "Asia/Ho_Chi_Minh",
    businessDayCutoffTime: "03:00",
    effectiveFromBusinessDate: businessDate,
    revision: 0,
    state: "active",
    createdBy: 0,
    createdAt: "",
    cancelledBy: null,
    cancelledAt: null,
    attendancePolicy: {
      lateGraceMinutes: 0,
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

const createFallback = (businessDate: string) => setting(businessDate);

test("a date before the first setting resolves to the official fallback", () => {
  const resolved = resolveAttendanceShadowSetting(
    "2026-07-17",
    null,
    createFallback
  );
  assert.equal(resolved.fallbackUsed, true);
  assert.equal(resolved.settingId, null);
  assert.equal(resolved.revision, null);
  assert.deepEqual(resolved.attendancePolicy, {
    lateGraceMinutes: 0,
    defaultNormalCheckoutTime: "00:00",
  });
  assert.equal(resolved.setting.effectiveFromBusinessDate, "2026-07-17");
});

test("configured dates retain their own version without retroactive lookup", () => {
  const configured = setting("2026-07-20", {
    id: 2,
    revision: 3,
    attendancePolicy: {
      lateGraceMinutes: 5,
      defaultNormalCheckoutTime: "23:30",
    },
  });
  const resolved = resolveAttendanceShadowSetting(
    "2026-07-23",
    configured,
    createFallback
  );
  assert.equal(resolved.fallbackUsed, false);
  assert.equal(resolved.settingId, 2);
  assert.equal(resolved.revision, 3);
  assert.equal(resolved.setting, configured);
});

test("2026-07-17 through 2026-07-23 mixes fallback and configured dates", () => {
  const configured = setting("2026-07-20", { id: 2, revision: 3 });
  const dates = [
    "2026-07-17",
    "2026-07-18",
    "2026-07-19",
    "2026-07-20",
    "2026-07-21",
    "2026-07-22",
    "2026-07-23",
  ];
  const resolved = dates.map((date) =>
    resolveAttendanceShadowSetting(
      date,
      date < "2026-07-20" ? null : configured,
      createFallback
    )
  );
  assert.equal(resolved.filter((item) => item.fallbackUsed).length, 3);
  assert.equal(resolved.filter((item) => !item.fallbackUsed).length, 4);
  assert.deepEqual(
    resolved.slice(0, 3).map((item) => item.revision),
    [null, null, null]
  );
});

test("a special close still overrides a fallback day's store close", () => {
  const resolved = resolveAttendanceShadowSetting(
    "2026-07-17",
    null,
    createFallback
  );
  const result = evaluateAttendancePolicy({
    businessDate: "2026-07-17",
    timezone: resolved.setting.timezone,
    businessDayCutoffTime: resolved.setting.businessDayCutoffTime,
    settingsRevision: resolved.revision,
    scheduledStartTime: "16:00",
    scheduledEndTime: "01:00",
    storeOpenTime: "16:00",
    storeCloseTime: "01:00",
    lateGraceMinutes: resolved.attendancePolicy!.lateGraceMinutes,
    defaultNormalCheckoutTime:
      resolved.attendancePolicy!.defaultNormalCheckoutTime,
    overrideCloseTime: "23:00",
    checkInAt: "2026-07-17T09:00:00.000Z",
    checkOutAt: "2026-07-17T16:00:00.000Z",
    now: "2026-07-17T17:00:00.000Z",
  });
  assert.equal(result.source.settingsRevision, null);
  assert.equal(result.source.close, "override");
  assert.equal(result.overrideCloseAt, "2026-07-17T16:00:00.000Z");
});

test("period route keeps fallback and configured dates together", () => {
  const route = read(
    "app/api/admin/store-settings/attendance-shadow/route.ts"
  );
  assert.match(route, /resolveAttendanceShadowSetting/);
  assert.match(route, /filter\(\(\[, resolved\]\) => !resolved\.fallbackUsed\)/);
  assert.match(route, /resolved\.attendancePolicy \?\?/);
  assert.match(route, /fallbackUsed: resolved\.fallbackUsed/);
  assert.match(route, /businessDayCutoffTime: setting\.businessDayCutoffTime/);
  assert.doesNotMatch(route, /STORE_SETTING_NOT_FOUND/);
});

test("fallback dates still participate in special business overrides", () => {
  const route = read(
    "app/api/admin/store-settings/attendance-shadow/route.ts"
  );
  assert.match(
    route,
    /store_business_day_overrides[\s\S]*gte\("business_date", range\.startBusinessDate\)[\s\S]*lte\("business_date", range\.endBusinessDate\)/
  );
  assert.match(route, /overrideCloseTime: normalizeTime\(override\?\.actualCloseTime\)/);
});

test("single-date compatibility and read-only contract remain intact", () => {
  const route = read(
    "app/api/admin/store-settings/attendance-shadow/route.ts"
  );
  assert.match(
    route,
    /businessDate: range\.singleDate \? range\.startBusinessDate : undefined/
  );
  assert.doesNotMatch(route, /\.(insert|update|delete|upsert)\s*\(/);
  assert.match(route, /2026-07-17|range\.startBusinessDate/);
  assert.match(route, /range\.endBusinessDate/);
});
