import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node's direct TypeScript tests require an explicit extension.
import { groupStoreHours } from "../lib/store-settings/hours-summary.ts";
// @ts-expect-error Node's direct TypeScript tests require an explicit extension.
import { DEFAULT_STORE_HOURS } from "../lib/store-settings/types.ts";

test("uniform hours across every weekday collapse into a single group", () => {
  const groups = groupStoreHours(DEFAULT_STORE_HOURS);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].weekdays, [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(groups[0].openTime, "16:00");
  assert.equal(groups[0].closeTime, "01:00");
  assert.equal(groups[0].isClosed, false);
});

test("a single differing weekday splits into two groups without losing the rest", () => {
  const hours = DEFAULT_STORE_HOURS.map((hour) =>
    hour.weekday === 0 ? { ...hour, openTime: "18:00", closeTime: "00:00" } : hour
  );
  const groups = groupStoreHours(hours);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].weekdays, [0]);
  assert.equal(groups[0].openTime, "18:00");
  assert.deepEqual(groups[1].weekdays, [1, 2, 3, 4, 5, 6]);
  assert.equal(groups[1].openTime, "16:00");
});

test("every weekday differing produces seven independent groups", () => {
  const hours = DEFAULT_STORE_HOURS.map((hour) => ({
    ...hour,
    openTime: `${String(10 + hour.weekday).padStart(2, "0")}:00`,
  }));
  const groups = groupStoreHours(hours);
  assert.equal(groups.length, 7);
  assert.ok(groups.every((group) => group.weekdays.length === 1));
});

test("closed days group separately from open days, including a trailing closed run", () => {
  const hours = DEFAULT_STORE_HOURS.map((hour) =>
    hour.weekday === 6
      ? { ...hour, isClosed: true, openTime: null, closeTime: null }
      : hour
  );
  const groups = groupStoreHours(hours);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].weekdays, [0, 1, 2, 3, 4, 5]);
  assert.equal(groups[0].isClosed, false);
  assert.deepEqual(groups[1].weekdays, [6]);
  assert.equal(groups[1].isClosed, true);
  assert.equal(groups[1].openTime, null);
});

test("missing weekdays in the input are skipped rather than crashing", () => {
  const hours = DEFAULT_STORE_HOURS.filter((hour) => hour.weekday !== 3);
  const groups = groupStoreHours(hours);
  const allWeekdays = groups.flatMap((group) => group.weekdays);
  assert.deepEqual(allWeekdays, [0, 1, 2, 4, 5, 6]);
});
