import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
// @ts-expect-error Node strips TypeScript extensions in tests.
import { canManagePayroll } from "../lib/payroll/authorization.ts";

const root=process.cwd();
const routeFiles=[
  "users/route.ts","shadow/route.ts","settings/route.ts","schedules/route.ts","runs/route.ts","runs/[runId]/route.ts","overview/route.ts","contracts/route.ts","adjustments/route.ts","runs/[runId]/employees/[employeeId]/reviews/route.ts","runs/[runId]/employees/[employeeId]/items/route.ts",
];

test("master is an owner-equivalent payroll manager while lower roles are denied",()=>{
  const cases:[[string|null|undefined,boolean]]=[...["master","owner"].map(role=>[role,true] as [string,boolean]),...["manager","leader","staff",null,undefined].map(role=>[role,false] as [string|null|undefined,boolean])] as [[string|null|undefined,boolean]];
  for(const[role,allowed]of cases)assert.equal(canManagePayroll(role),allowed,String(role));
});

test("every payroll API route uses the shared authenticated payroll gate",()=>{
  for(const relative of routeFiles){const source=readFileSync(join(root,"app/api/admin/payroll",relative),"utf8");assert.match(source,/requirePayrollActor\(\)/,relative);assert.doesNotMatch(source,/role\s*[!=]==?\s*["']owner["']/,relative)}
});

test("payroll page layout uses the same owner-master role constant",()=>{const source=readFileSync(join(root,"app/(protected)/admin/payroll/layout.tsx"),"utf8");assert.match(source,/requireRole\(PAYROLL_MANAGER_ROLES\)/)});
