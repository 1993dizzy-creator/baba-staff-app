import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node's direct TypeScript runner requires an explicit extension.
import { getBusinessDate, getBusinessWindowByBusinessDate } from "../lib/common/business-time.ts";
// @ts-expect-error Node's direct TypeScript runner requires an explicit extension.
import { buildPosCollectionWindow, calculateBusinessTimeContext, compareBusinessTimeShadow, createBusinessTimeSnapshot, createFallbackBusinessTimeSnapshot } from "../lib/store-settings/business-time-adapter-core.ts";
// @ts-expect-error Node's direct TypeScript runner requires an explicit extension.
import { DEFAULT_STORE_HOURS, type StoreSetting } from "../lib/store-settings/types.ts";

const configuredSetting: StoreSetting = {
  id: 1,
  timezone: "Asia/Ho_Chi_Minh",
  businessDayCutoffTime: "03:00",
  effectiveFromBusinessDate: "2026-07-20",
  revision: 1,
  state: "active",
  createdBy: 1,
  createdAt: "2026-07-19T00:00:00Z",
  cancelledBy: null,
  cancelledAt: null,
  hours: DEFAULT_STORE_HOURS,
};
const snapshot = createBusinessTimeSnapshot(configuredSetting, "2026-07-20");

test("configured pure business date matches legacy at every required cutoff boundary", () => {
  const cases = [
    ["2026-07-20T00:00:00+07:00", "2026-07-19"],
    ["2026-07-20T00:59:00+07:00", "2026-07-19"],
    ["2026-07-20T01:00:00+07:00", "2026-07-19"],
    ["2026-07-20T01:01:00+07:00", "2026-07-19"],
    ["2026-07-20T02:59:00+07:00", "2026-07-19"],
    ["2026-07-20T03:00:00+07:00", "2026-07-20"],
    ["2026-07-20T03:01:00+07:00", "2026-07-20"],
    ["2026-07-20T15:59:00+07:00", "2026-07-20"],
    ["2026-07-20T16:00:00+07:00", "2026-07-20"],
    ["2026-07-20T23:59:00+07:00", "2026-07-20"],
  ] as const;
  for (const [timestamp, expected] of cases) {
    assert.equal(calculateBusinessTimeContext(timestamp, snapshot).businessDate, expected);
    assert.equal(getBusinessDate(new Date(timestamp)), expected);
  }
});

test("operation state keeps close and cutoff as separate boundaries", () => {
  assert.equal(calculateBusinessTimeContext("2026-07-21T00:30:00+07:00", snapshot).isOpen, true);
  assert.deepEqual(
    (({ isOpen, isAfterCloseBeforeCutoff }) => ({ isOpen, isAfterCloseBeforeCutoff }))(
      calculateBusinessTimeContext("2026-07-21T01:00:00+07:00", snapshot)
    ),
    { isOpen: false, isAfterCloseBeforeCutoff: true }
  );
  assert.equal(calculateBusinessTimeContext("2026-07-21T02:59:00+07:00", snapshot).isAfterCloseBeforeCutoff, true);
  assert.equal(calculateBusinessTimeContext("2026-07-21T03:00:00+07:00", snapshot).isAfterCloseBeforeCutoff, false);
  assert.equal(calculateBusinessTimeContext("2026-07-21T15:59:00+07:00", snapshot).isOpen, false);
  assert.equal(calculateBusinessTimeContext("2026-07-21T16:00:00+07:00", snapshot).isOpen, true);
});

test("POS collection window handles weekdays, weekends and calendar boundaries", () => {
  const cases = [
    ["2026-07-20", "2026-07-21"],
    ["2026-07-25", "2026-07-26"],
    ["2026-07-26", "2026-07-27"],
    ["2026-01-31", "2026-02-01"],
    ["2026-12-31", "2027-01-01"],
    ["2024-02-29", "2024-03-01"],
  ] as const;
  for (const [date, nextDate] of cases) {
    const window = buildPosCollectionWindow(date, snapshot);
    assert.equal(window.openAt, `${date}T16:00:00+07:00`);
    assert.equal(window.closeAt, `${nextDate}T01:00:00+07:00`);
    assert.equal(window.collectionTo, `${nextDate}T03:00:00+07:00`);
  }
});

test("closed days remain calculable and do not invent a collection start", () => {
  const closed = createBusinessTimeSnapshot(
    { ...configuredSetting, hours: configuredSetting.hours.map((hour) => hour.weekday === 0 ? { ...hour, isClosed: true, openTime: null, closeTime: null } : hour) },
    "2026-07-26"
  );
  const window = buildPosCollectionWindow("2026-07-26", closed);
  assert.equal(window.isClosed, true);
  assert.equal(window.collectionFrom, null);
  assert.equal(window.collectionTo, "2026-07-27T03:00:00+07:00");
});

test("missing or incomplete settings use the explicit fallback snapshot", () => {
  assert.equal(createBusinessTimeSnapshot(null, "2026-07-20").isFallback, true);
  assert.equal(createBusinessTimeSnapshot({ ...configuredSetting, hours: configuredSetting.hours.slice(0, 6) }, "2026-07-20").isFallback, true);
  const fallback = createFallbackBusinessTimeSnapshot("2026-07-20");
  assert.equal(fallback.revision, 0);
  assert.equal(fallback.hours.length, 7);
  assert.ok(fallback.hours.every((hour) => hour.openTime === "16:00" && hour.closeTime === "01:00"));
});

test("shadow reports full matches and individual mismatch categories", () => {
  const legacyWindow = getBusinessWindowByBusinessDate("2026-07-20");
  const configured = calculateBusinessTimeContext("2026-07-20T16:00:00+07:00", snapshot);
  const match = compareBusinessTimeShadow({
    legacyBusinessDate: "2026-07-20",
    legacyCollectionFrom: legacyWindow.start.toISOString(),
    legacyCollectionTo: legacyWindow.end.toISOString(),
    configured,
    databaseBusinessDate: "2026-07-20",
  });
  assert.equal(match.matches, true);
  assert.deepEqual(match.differences, []);

  const mismatch = compareBusinessTimeShadow({
    legacyBusinessDate: "2026-07-19",
    legacyCollectionFrom: "2026-07-20T17:00:00+07:00",
    legacyCollectionTo: "2026-07-21T01:00:00+07:00",
    configured,
    databaseBusinessDate: "2026-07-19",
  });
  assert.deepEqual(mismatch.differences, ["businessDate", "databaseBusinessDate", "collectionFrom", "collectionTo"]);
});
