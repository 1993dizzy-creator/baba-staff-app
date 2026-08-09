import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const route = readFileSync(join(process.cwd(), "app/api/admin/store-settings/holidays/prepare-year/route.ts"), "utf8");

test("prepare-year API keeps owner/master mutation authorization", () => {
  assert.match(route, /if \(!canMutateStoreSettings\(auth\.actor\)\)/);
  assert.match(route, /code: "FORBIDDEN"/);
});

test("prepare-year API accepts only year and option identifiers", () => {
  assert.match(route, /"tetOption"/);
  assert.match(route, /"nationalDayOption"/);
  assert.doesNotMatch(route, /"hungKingsDate"|"tetDates"|"nationalDayAdjacentDate"/);
  const allowedKeys = route.slice(route.indexOf("const allowedKeys"), route.indexOf("const year"));
  assert.doesNotMatch(allowedKeys, /sourceUrl|sourcePublishedAt/);
});

test("server derives all final dates with the shared calculator before the existing RPC adapter", () => {
  const calculate = route.indexOf("resolveVietnamHolidayPreparation(");
  const persist = route.indexOf("await prepareHolidayCalendar(");
  assert.ok(calculate > -1 && calculate < persist);
  assert.match(route, /year,\s*\n\s*\.\.\.calculated,/);
  assert.match(route, /sourceUrl: null,/);
  assert.match(route, /sourcePublishedAt: null,/);
});

test("existing-year conflicts stay mapped to HTTP 409", () => {
  assert.match(route, /year_already_exists: 409/);
});
