import assert from "node:assert/strict";import test from "node:test";import{readFileSync}from"node:fs";
// @ts-expect-error Node test execution needs explicit TypeScript extensions.
import{calendarDayDifference}from"../lib/employee-level/calendar-day.ts";
const source=readFileSync("lib/employee-level/next-level-schedule.ts","utf8");
test("future next level uses calendar dates without timezone milliseconds",()=>assert.equal(calendarDayDifference("2026-07-30","2026-09-15"),47));
test("today, maximum and ineligible states are explicit",()=>{assert.match(source,/days===0/);assert.match(source,/EMPLOYEE_LEVEL_MAX/);assert.match(source,/!info\?\.eligible/)});
test("timezone-sensitive Math.ceil milliseconds is absent",()=>assert.doesNotMatch(source,/Math\.ceil|new Date/));
