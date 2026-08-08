import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node's direct TypeScript tests require an explicit extension.
import { countHolidayGroupSizes, getEffectiveHolidayMultiplier, isBabaPremiumHoliday } from "../lib/store-settings/holidays-policy.ts";

// ---------------------------------------------------------------------------
// BABA 200% effective 판정 — 관리자 UI와 근태 API가 절대 다른 기준으로 판정하지
// 않도록 여기 하나에만 로직이 있다(둘 다 이 파일을 그대로 import해서 쓴다).
//
// 정책:
//   - 그룹 크기 1(1일짜리 공휴일) → 관리자 선택 없이 자동 200% 적용.
//   - 그룹 크기 2 이상 → internal_pay_multiplier === 2인 날짜만 200% 적용.
// ---------------------------------------------------------------------------

test("single-day group (groupSize=1) is always effective, regardless of internalPayMultiplier", () => {
  assert.equal(
    isBabaPremiumHoliday({ holidayGroup: "NEW_YEAR", internalPayMultiplier: null }, 1),
    true
  );
  assert.equal(
    isBabaPremiumHoliday({ holidayGroup: "HUNG_KINGS", internalPayMultiplier: null }, 1),
    true
  );
});

test("multi-day group (groupSize>=2) with internalPayMultiplier=2 is effective (selected)", () => {
  assert.equal(
    isBabaPremiumHoliday({ holidayGroup: "TET", internalPayMultiplier: 2 }, 5),
    true
  );
  assert.equal(
    isBabaPremiumHoliday({ holidayGroup: "NATIONAL_DAY", internalPayMultiplier: 2 }, 2),
    true
  );
});

test("multi-day group (groupSize>=2) with internalPayMultiplier=null is NOT effective (unselected)", () => {
  assert.equal(
    isBabaPremiumHoliday({ holidayGroup: "TET", internalPayMultiplier: null }, 5),
    false
  );
  assert.equal(
    isBabaPremiumHoliday({ holidayGroup: "NATIONAL_DAY", internalPayMultiplier: null }, 2),
    false
  );
});

test("multi-day group with a multiplier other than exactly 2 is not treated as effective (defensive — the RPC only ever writes 2, but the judge function does not assume that)", () => {
  assert.equal(
    isBabaPremiumHoliday({ holidayGroup: "TET", internalPayMultiplier: 1 }, 5),
    false
  );
});

test("groupSize=0 (holiday not present in the group-size map, e.g. unknown/edge input) is never effective", () => {
  assert.equal(
    isBabaPremiumHoliday({ holidayGroup: "TET", internalPayMultiplier: 2 }, 0),
    false
  );
});

test("getEffectiveHolidayMultiplier returns 2 exactly when isBabaPremiumHoliday is true, and null otherwise — never a bare boolean or a default 1.0", () => {
  assert.equal(
    getEffectiveHolidayMultiplier({ holidayGroup: "NEW_YEAR", internalPayMultiplier: null }, 1),
    2
  );
  assert.equal(
    getEffectiveHolidayMultiplier({ holidayGroup: "TET", internalPayMultiplier: 2 }, 5),
    2
  );
  assert.equal(
    getEffectiveHolidayMultiplier({ holidayGroup: "TET", internalPayMultiplier: null }, 5),
    null
  );
});

test("countHolidayGroupSizes counts occurrences per holidayGroup across a mixed list", () => {
  const sizes = countHolidayGroupSizes([
    { holidayGroup: "NEW_YEAR" },
    { holidayGroup: "TET" },
    { holidayGroup: "TET" },
    { holidayGroup: "TET" },
    { holidayGroup: "TET" },
    { holidayGroup: "TET" },
    { holidayGroup: "NATIONAL_DAY" },
    { holidayGroup: "NATIONAL_DAY" },
  ]);
  assert.equal(sizes.get("NEW_YEAR"), 1);
  assert.equal(sizes.get("TET"), 5);
  assert.equal(sizes.get("NATIONAL_DAY"), 2);
  assert.equal(sizes.get("UNKNOWN_GROUP"), undefined);
});

test("countHolidayGroupSizes on an empty list returns an empty map (no throw)", () => {
  const sizes = countHolidayGroupSizes([]);
  assert.equal(sizes.size, 0);
});

test("end-to-end sanity: a full year's holiday list correctly separates auto-applied 1-day holidays from selection-dependent multi-day ones", () => {
  const holidays = [
    { holidayGroup: "NEW_YEAR", internalPayMultiplier: null },
    { holidayGroup: "HUNG_KINGS", internalPayMultiplier: null },
    { holidayGroup: "REUNIFICATION_DAY", internalPayMultiplier: null },
    { holidayGroup: "LABOR_DAY", internalPayMultiplier: null },
    { holidayGroup: "NATIONAL_DAY", internalPayMultiplier: 2 },
    { holidayGroup: "NATIONAL_DAY", internalPayMultiplier: null },
    { holidayGroup: "TET", internalPayMultiplier: null },
    { holidayGroup: "TET", internalPayMultiplier: 2 },
    { holidayGroup: "TET", internalPayMultiplier: 2 },
    { holidayGroup: "TET", internalPayMultiplier: null },
    { holidayGroup: "TET", internalPayMultiplier: null },
  ];
  const sizes = countHolidayGroupSizes(holidays);
  const effective = holidays.filter((h) => isBabaPremiumHoliday(h, sizes.get(h.holidayGroup) ?? 0));
  // 4 single-day + 1 selected NATIONAL_DAY + 2 selected TET = 7
  assert.equal(effective.length, 7);
  assert.equal(effective.filter((h) => h.holidayGroup === "TET").length, 2);
  assert.equal(effective.filter((h) => h.holidayGroup === "NATIONAL_DAY").length, 1);
});

test("naming discipline: no statutory/legal-sounding identifier anywhere in this module", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const source = readFileSync(join(process.cwd(), "lib/store-settings/holidays-policy.ts"), "utf8");
  for (const forbidden of ["statutoryPayRate", "legalPayMultiplier", "legallyPaid", "statutory200", "statutory_pay_rate"]) {
    assert.doesNotMatch(source, new RegExp(forbidden, "i"));
  }
});
