import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read=(path:string)=>readFileSync(join(process.cwd(),path),"utf8");
const panel=read("components/payroll/PayrollSourceReadinessPanel.tsx");
const page=read("app/(protected)/admin/payroll/page.tsx");
const overviewRoute=read("app/api/admin/payroll/overview/route.ts");
const exportRoute=read("app/api/admin/payroll/source-export/route.ts");
const attendancePage=read("app/(protected)/attendance/page.tsx");
const buildExport=read("lib/payroll/source-export/build-export.ts");

test("admin payroll main screen no longer eager-loads the monthly source-readiness panel",()=>{
  assert.doesNotMatch(page,/PayrollSourceReadinessPanel/);
  assert.doesNotMatch(page,/sourceExport/);
  assert.doesNotMatch(page,/기존 급여 계산·지급/);
  // 기존 지급 UI는 그대로 유지된다.
  assert.match(page,/PaymentBatchCard/);
  assert.match(page,/CompensationCard/);
});

test("overview route does not compute Source Export on the main payroll entry path",()=>{
  assert.doesNotMatch(overviewRoute,/buildPayrollSourceExport\(/);
  assert.doesNotMatch(overviewRoute,/sourceExport/);
  assert.doesNotMatch(page,/fetch\(`\/api\/admin\/payroll\/source-export/);
});

test("Source Export implementation itself is preserved for future APP↔T8 cross-check",()=>{
  // 코드/전용 API/패널 컴포넌트는 삭제하지 않고 보존한다.
  assert.match(buildExport,/export function buildPayrollSourceExport/);
  assert.match(exportRoute,/requirePayrollActor\(\)/);
  assert.match(exportRoute,/export async function GET/);
  assert.doesNotMatch(exportRoute,/export async function (POST|PUT|PATCH|DELETE)/);
  assert.match(exportRoute,/loadPayrollSourceExport/);
  assert.match(read("lib/payroll/source-export/server.ts"),/buildPayrollSourceExport/);
  assert.match(panel,/PayrollSourceReadinessPanel/);
});

test("employee attendance summary no longer frames the amount as a pre-accounting T8 reference",()=>{
  assert.doesNotMatch(attendancePage,/T8/);
  assert.doesNotMatch(attendancePage,/회계 확정 전 참고값/);
  assert.match(attendancePage,/근무 기록으로 계산한 예상 급여/);
  assert.match(attendancePage,/lương dự kiến được tính từ dữ liệu chấm công/);
});
