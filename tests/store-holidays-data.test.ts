import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node's direct TypeScript tests require an explicit extension.
import { HOLIDAY_GROUP_LABELS, getHolidayGroupLabel } from "../lib/store-settings/holidays-data.ts";

// ---------------------------------------------------------------------------
// 공휴일 그룹 표시용 짧은 라벨 표 — Tet 묶음 선택 UX(TET_OPTIONS/TET_OPTION_DATES)는
// 완전히 제거되었다. 이제 store_holidays에 이미 존재하는 날짜를 holiday_group으로
// 묶어 표시할 때만 이 표를 쓴다.
// ---------------------------------------------------------------------------

test("known groups (TET, NATIONAL_DAY) have both ko/vi labels", () => {
  assert.equal(getHolidayGroupLabel("TET", "ko", "fallback"), "음력설");
  assert.equal(getHolidayGroupLabel("TET", "vi", "fallback"), "Tết Nguyên Đán");
  assert.equal(getHolidayGroupLabel("NATIONAL_DAY", "ko", "fallback"), "국경일");
  assert.equal(getHolidayGroupLabel("NATIONAL_DAY", "vi", "fallback"), "Quốc khánh");
});

test("an unknown holiday_group (e.g. a future government-announced type) falls back to the caller-provided label instead of throwing or returning undefined", () => {
  assert.equal(getHolidayGroupLabel("SOME_FUTURE_GROUP", "ko", "미래 공휴일"), "미래 공휴일");
  assert.equal(getHolidayGroupLabel("SOME_FUTURE_GROUP", "vi", "Ngày lễ tương lai"), "Ngày lễ tương lai");
});

test("HOLIDAY_GROUP_LABELS is a plain lookup, not a closed enum guard — holiday_group itself has no CHECK constraint in the DB, and this table must not pretend otherwise", () => {
  assert.equal(typeof HOLIDAY_GROUP_LABELS, "object");
  assert.ok(!Array.isArray(HOLIDAY_GROUP_LABELS));
});
