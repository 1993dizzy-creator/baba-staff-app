import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");
const sort = read("lib/payroll/employee-sort.ts");
const positions = read("lib/common/positions.ts");
const main = read("app/(protected)/admin/payroll/page.tsx");
const settings = read("app/(protected)/admin/payroll/settings/page.tsx");
const labels = read("lib/payroll/ui-labels.ts");
const attendance = read("lib/text/attendance.ts");
const parts = read("lib/common/parts.ts");

test("payroll screens share part-position-name-id ordering", () => {
  assert.match(sort, /getPartMeta\(a\.part\)\.rank/);
  assert.match(sort, /getPositionRank\(a\.position\)/);
  assert.match(sort, /localeCompare/);
  assert.match(sort, /a\.id \?\? a\.userId/);
  assert.match(main, /employees\.sort\(comparePayrollEmployees\)/);
  assert.match(settings, /sort\(comparePayrollEmployees\)/);
});

test("owner position is first and consistently translated", () => {
  assert.match(positions, /value === "owner"\) return 0/);
  assert.match(labels, /owner:"Chủ quán"/);
  assert.match(labels, /owner:"사장"/);
  assert.match(attendance, /owner: "Chủ quán"/);
  assert.match(attendance, /owner: "사장"/);
});

test("payroll part labels are localized with an unknown-value fallback", () => {
  assert.match(labels, /owner:"사장"/);
  assert.match(labels, /owner:"Chủ quán"/);
  assert.match(labels, /hall:"홀",bar:"바",kitchen:"주방"/);
  assert.match(labels, /hall:"Sảnh",bar:"Quầy bar",kitchen:"Bếp"/);
  assert.match(labels, /\?\?\(value\|\|"-"\)/);
  assert.match(parts, /if \(part === "owner"\) return "owner"/);
  assert.match(settings, /all\.indexOf\(value\) === index/);
  assert.match(settings, /employeeMetaLabel\(user\)/);
  assert.match(settings, /employeeMetaLabel\(selected\)/);
});
