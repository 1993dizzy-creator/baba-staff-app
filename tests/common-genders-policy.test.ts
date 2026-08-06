import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node's direct TypeScript tests require an explicit extension.
import { GENDER_VALUES, getGenderLabel, isGenderValue } from "../lib/common/genders.ts";

test("GENDER_VALUES is exactly the three storage values, no blank entry", () => {
  assert.deepEqual(GENDER_VALUES, ["male", "female", "other"]);
});

test("isGenderValue accepts only the three storage values", () => {
  for (const value of GENDER_VALUES) {
    assert.equal(isGenderValue(value), true);
  }
  assert.equal(isGenderValue(""), false);
  assert.equal(isGenderValue(null), false);
  assert.equal(isGenderValue(undefined), false);
  assert.equal(isGenderValue("unknown"), false);
});

test("getGenderLabel matches the confirmed label policy in both languages", () => {
  assert.equal(getGenderLabel("male", "ko"), "남성");
  assert.equal(getGenderLabel("male", "vi"), "Nam");
  assert.equal(getGenderLabel("female", "ko"), "여성");
  assert.equal(getGenderLabel("female", "vi"), "Nữ");
  assert.equal(getGenderLabel("other", "ko"), "기타");
  assert.equal(getGenderLabel("other", "vi"), "Khác");
});

test("getGenderLabel falls back to '-' for blank or unknown values, in both languages", () => {
  assert.equal(getGenderLabel("", "ko"), "-");
  assert.equal(getGenderLabel("", "vi"), "-");
  assert.equal(getGenderLabel(null, "ko"), "-");
  assert.equal(getGenderLabel(undefined, "vi"), "-");
  assert.equal(getGenderLabel("unknown", "ko"), "-");
});
