import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const route = readFileSync(join(process.cwd(), "app/api/attendance/users/route.ts"), "utf8");

test("users query reads birth_date server-side and derives only MM-DD for calendar display", () => {
  assert.match(route, /USER_FIELDS_WITH_BIRTH_DATE = `\$\{BASE_USER_FIELDS\},birth_date`/);
  assert.match(route, /return typeof value === "string"[\s\S]*\? value\.slice\(5\)[\s\S]*: null;/);
  assert.match(route, /birthdayMonthDay: monthDay/);
});

test("ordinary actors never receive full birth_date while owner/master retain the existing contract", () => {
  assert.match(route, /const canViewFullBirthDate = auth\.actor\.role === "owner" \|\| auth\.actor\.role === "master";/);
  assert.match(route, /if \(canViewFullBirthDate\) return \{ \.\.\.user, birthdayMonthDay: monthDay \};/);
  assert.match(route, /const \{ birth_date: _privateBirthDate, \.\.\.publicUser \} = user;/);
  assert.match(route, /return \{ \.\.\.publicUser, birthdayMonthDay: monthDay \};/);
});

test("birthday support reuses the existing users request and adds no endpoint or client fetch", () => {
  assert.equal((route.match(/\.from\("users"\)/g) ?? []).length, 1);
  assert.doesNotMatch(route, /birthday.*fetch|fetch.*birthday/i);
});
