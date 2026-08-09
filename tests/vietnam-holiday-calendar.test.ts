import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node's direct TypeScript tests require an explicit extension.
import { addCalendarDays, getVietnamHolidayChoices, resolveVietnamHolidayPreparation, vietnameseLunarToSolar } from "../lib/store-settings/vietnam-holiday-calendar.ts";

test("known Vietnamese Tet dates are calculated from lunar 1/1", () => {
  for (const [year, expected] of [[2024, "2024-02-10"], [2025, "2025-01-29"], [2026, "2026-02-17"], [2027, "2027-02-06"], [2028, "2028-01-26"]] as const) {
    assert.equal(vietnameseLunarToSolar(1, 1, year), expected);
  }
});

test("known Hung Kings dates are calculated from lunar 3/10", () => {
  for (const [year, expected] of [[2024, "2024-04-18"], [2025, "2025-04-07"], [2026, "2026-04-26"], [2027, "2027-04-16"]] as const) {
    assert.equal(vietnameseLunarToSolar(10, 3, year), expected);
  }
});

test("all three Tet options are consecutive five-day ranges containing Tet day", () => {
  for (const year of [2024, 2027, 2030, 2050, 2100]) {
    const choices = getVietnamHolidayChoices(year);
    assert.equal(choices.tetOptions.length, 3);
    for (const option of choices.tetOptions) {
      assert.equal(option.dates.length, 5);
      assert.ok(option.dates.includes(choices.tetDay));
      option.dates.forEach((date, index) => {
        assert.equal(date, addCalendarDays(option.dates[0], index));
        assert.ok(date.startsWith(`${year}-`));
      });
    }
  }
});

test("national day choices are exactly 09/01+02 and 09/02+03", () => {
  assert.deepEqual(getVietnamHolidayChoices(2027).nationalDayOptions, [
    { id: "before", dates: ["2027-09-01", "2027-09-02"] },
    { id: "after", dates: ["2027-09-02", "2027-09-03"] },
  ]);
});

test("server preparation resolver accepts option identifiers and derives final RPC dates", () => {
  assert.deepEqual(resolveVietnamHolidayPreparation(2027, "before2", "after"), {
    hungKingsDate: "2027-04-16",
    tetDates: ["2027-02-04", "2027-02-05", "2027-02-06", "2027-02-07", "2027-02-08"],
    nationalDayAdjacentDate: "2027-09-03",
  });
});

test("unsupported target years and invalid choices are rejected", () => {
  assert.throws(() => getVietnamHolidayChoices(2019), RangeError);
  assert.throws(() => getVietnamHolidayChoices(2101), RangeError);
  assert.throws(() => resolveVietnamHolidayPreparation(2027, "bad" as never, "before"), RangeError);
});
