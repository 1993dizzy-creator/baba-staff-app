import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

// ---------------------------------------------------------------------------
// role/position 통합 작업(이번 세션 포함)은 급여 지급 snapshot 스키마를 의도적으로
// 건드리지 않았다. 이 파일은 그 현재 한계를 코드 사실로 고정해 문서화한다 —
// DB 컬럼이나 payroll_pay_employee_v1 RPC를 여기서 변경하지 않는다.
//
// 현재 정책:
//   1. 기존 payroll_employee_payments.position_snapshot 값과 스키마는 변경하지 않는다.
//   2. 신규 지급 건도 이번 작업만으로는 role snapshot을 만들지 않는다 — employee_snapshot
//      JSON과 position_snapshot 컬럼 모두 part/position만 담고 role은 담지 않는다.
//   3. master가 지급 대상이 되면(예: payroll_eligible_override=true) 그 지급 기록의
//      position_snapshot은 "owner"로 남는다 — 이 컬럼만 보고는 그 사람이 실제 role=owner
//      였는지 role=master였는지 구분할 수 없다(users.role은 별도 조인 없이는 알 수 없음).
//   4. 향후 이 구분이 필요해지면 payroll_employee_payments에 role_snapshot 컬럼을
//      추가하거나 employee_snapshot JSON에 role 필드를 추가하는 별도 승인·Migration이
//      필요하다. 이번 작업 범위에는 포함되지 않는다.
// ---------------------------------------------------------------------------

const paymentsRoute = read("app/api/admin/payroll/payments/route.ts");
const batchMigration = read("supabase/migrations/202608050001_add_employee_payment_batches.sql");
const overview = read("lib/payroll/overview.ts");

test("the employee_snapshot payload sent to payroll_pay_employee_v1 still carries part/position but not role", () => {
  const targetsLine = paymentsRoute.match(/const targets=[^\n]+;/)?.[0] ?? "";
  assert.ok(targetsLine, "expected to find the targets= builder line");
  assert.match(targetsLine, /part:item\.part/);
  assert.match(targetsLine, /position:item\.position/);
  assert.doesNotMatch(targetsLine, /role:item\.role/);
  assert.doesNotMatch(targetsLine, /\brole\b/);
});

test("PayrollOverviewEmployee carries role for display purposes, but the payments route does not forward it into the snapshot", () => {
  // role은 4장에서 추가됐고(표시/정렬용) 실제로 존재한다 — payments/route.ts가 그
  // role을 일부러 안 쓰는 것이지, role 자체가 없어서가 아니라는 점을 함께 고정한다.
  assert.match(overview, /role: string \| null;/);
  assert.match(overview, /role: user\.role,/);
});

test("payroll_employee_payments schema is unchanged in this pass: position_snapshot exists, role_snapshot does not", () => {
  assert.match(batchMigration, /position_snapshot text null,/);
  assert.doesNotMatch(batchMigration, /role_snapshot/);
});

test("this pass introduces no new migration touching payroll_employee_payments or payroll_pay_employee_v1", () => {
  const roleMigration = read("supabase/migrations/202608060003_payroll_owner_by_role.sql");
  assert.doesNotMatch(roleMigration, /payroll_employee_payments/);
  assert.doesNotMatch(roleMigration, /payroll_pay_employee_v1/);
  assert.doesNotMatch(roleMigration, /role_snapshot/);
});
