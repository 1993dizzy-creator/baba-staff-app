import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const migrationPath="supabase/migrations/20260804152308_remove_legacy_payroll_day_basis.sql";
const migration=fs.readFileSync(migrationPath,"utf8");
const read=(path:string)=>fs.readFileSync(path,"utf8");

test("local migration matches the applied remote version and removes legacy day contracts",()=>{
  assert.equal(migrationPath.split("/").at(-1),"20260804152308_remove_legacy_payroll_day_basis.sql");
  for(const username of ["vuong","quyen","diep"]) assert.match(migration,new RegExp(`'${username}'`));
  assert.match(migration,/where c\.calculation_basis='day'/);
  assert.match(migration,/action,actor_user_id,snapshot,reason/);
  assert.match(migration,/check \(calculation_basis in \('minute','hour','fixed_monthly'\)\)/);
  assert.doesNotMatch(migration,/check \(calculation_basis in \([^)]*'day'/);
});

test("current code rejects legacy day while retaining the daily pay type",()=>{
  assert.doesNotMatch(read("lib/payroll/types.ts"),/CalculationBasis = [^\n]*"day"/);
  assert.doesNotMatch(read("lib/payroll/projection.ts"),/calculationBasis === "day"/);
  assert.doesNotMatch(read("lib/payroll/work-policy.ts"),/calculationBasis === "day"/);
  assert.doesNotMatch(read("app/api/admin/payroll/contracts/correct/route.ts"),/"day"/);
  assert.match(read("lib/payroll/types.ts"),/PayType = "monthly" \| "daily" \| "hourly"/);
  assert.match(read("app/api/admin/payroll/contracts/route.ts"),/\["monthly","daily","hourly"\]/);
});

test("database mapper fails closed on an unsupported calculation basis",()=>{
  const mapper=read("lib/payroll/db-mappers.ts");
  assert.match(mapper,/INVALID_PAYROLL_CALCULATION_BASIS/);
  assert.match(mapper,/\["minute", "hour", "fixed_monthly"\]/);
});
