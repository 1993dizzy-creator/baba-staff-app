import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");
const sort = read("lib/payroll/employee-sort.ts");
const roles = read("lib/common/roles.ts");
const main = read("app/(protected)/admin/payroll/page.tsx");
const settings = read("app/(protected)/admin/payroll/settings/page.tsx");
const labels = read("lib/payroll/ui-labels.ts");
const attendance = read("lib/text/attendance.ts");
const parts = read("lib/common/parts.ts");

test("payroll screens share part-role-name-id ordering", () => {
  assert.match(sort, /getPartMeta\(a\.part\)\.rank/);
  assert.match(sort, /getEmployeeRoleRank\(a\.role\)/);
  assert.match(sort, /localeCompare/);
  assert.match(sort, /a\.id \?\? a\.userId/);
  assert.match(main, /employees\.sort\(comparePayrollEmployees\)/);
  assert.match(settings, /sort\(comparePayrollEmployees\)/);
});

test("master role is first, owner second, and role labels are consistently translated", () => {
  assert.match(roles, /master: 0,/);
  assert.match(roles, /owner: 1,/);
  assert.match(roles, /master: \{ ko: "최고관리자", vi: "Quản trị viên cao nhất" \}/);
  assert.match(roles, /owner: \{ ko: "사장", vi: "Chủ cửa hàng" \}/);
  // (파트의 "owner" 그룹 라벨(lib/common/parts.ts, lib/payroll/ui-labels.ts)은 직원
  // role/position 통합과 무관한 별도 개념이라 이번 작업에서 손대지 않았다.)
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
