import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
const read = (file: string) =>
  fs.readFileSync(path.join(process.cwd(), file), "utf8");
const list = read("app/(protected)/admin/payroll/page.tsx");
const detail = read("app/(protected)/admin/payroll/[runId]/page.tsx");
const settings = read("app/(protected)/admin/payroll/settings/page.tsx");
const compensationCard = read("components/payroll/CompensationCard.tsx");
const attendanceCopy = read("lib/text/attendance.ts");
const employeeInsurance = read(
  "components/payroll/EmployeeInsuranceSettings.tsx",
);
const globalInsurance = read(
  "components/payroll/PayrollInsuranceSettings.tsx",
);
const shadow = read("components/PayrollShadowPanel.tsx");
const migration = read(
  "supabase/migrations/202607270002_create_payroll_runs.sql",
);
test("payroll pages use forms and mobile cards without prompt or wide tables", () => {
  for (const source of [list, detail, settings])
    assert.doesNotMatch(source, /prompt\s*\(/);
  assert.doesNotMatch(list, /<table/);
  assert.match(list, /runCard/);
  assert.match(detail, /EmployeeCard/);
  assert.match(settings, /PayrollModal/);
});
test("settings sends versioned compensation fields, preserves contract policy, and excludes payroll-owned level inputs", () => {
  assert.match(
    settings,
    /fixedRaiseAmount:\s*Number\(form\.fixedRaiseAmount\)/,
  );
  assert.match(settings, /fromContract\(current\)/);
  assert.match(settings, /lateAdjustmentMode:\s*contract\.lateAdjustmentMode/);
  assert.doesNotMatch(
    settings,
    /levelRaiseIncludedCount|level_raise_included_count/,
  );
  assert.match(settings, /await load\(userId\)/);
  const schedule = read("components/PayrollScheduleVersions.tsx");
  assert.match(schedule, /await load\(\)/);
});
test("review UI offers warning-specific actions and no bulk acknowledgement", () => {
  for (const action of [
    "approve_overtime",
    "exclude_overtime",
    "custom_overtime_minutes",
    "paid_leave",
    "unpaid_leave",
    "exclude_pending_leave",
    "use_stored_attendance",
    "use_recalculated_attendance",
    "exclude_date",
  ])
    assert.match(detail, new RegExp(action));
  assert.doesNotMatch(detail, /resolveAll|bulkResolve/);
});
test("finalization, cancellation, payment, and paid locking have dedicated UI", () => {
  for (const action of [
    "force_finalize",
    "cancel_finalization",
    "pay",
    "recalculate",
  ])
    assert.match(detail, new RegExp(action));
  assert.match(detail, /const locked=run\.status!=="draft"/);
  assert.match(migration, /p_action='force_finalize'/);
  assert.match(migration, /p_action='cancel_finalization'/);
});
test("shadow is collapsed and uses localized user-facing labels", () => {
  assert.match(shadow, /<details/);
  assert.match(shadow, /급여 계산 비교/);
  assert.doesNotMatch(shadow, /PAYROLL SHADOW|review \{|warning_code/);
});

test("payroll position labels reuse attendance translations with safe fallbacks", () => {
  for (const source of [compensationCard, settings]) {
    assert.match(source, /import \{ attendanceText \} from "@\/lib\/text"/);
    assert.match(source, /attendance\.positions\[/);
    assert.match(source, /\] \?\? (?:employee|user)\.position/);
  }
  assert.doesNotMatch(
    compensationCard,
    /employee\.position \?\? employee\.username/,
  );
  assert.match(compensationCard, /: employee\.username/);
  assert.match(settings, /: user\.username/);
  assert.match(attendanceCopy, /manager: "매니저"/);
  assert.match(attendanceCopy, /manager: "Quản lý"/);
});

test("payroll settings renders page guidance before separated company and employee sections", () => {
  const pageTitle = settings.indexOf('vi ? "Cài đặt lương" : "급여설정"');
  const companySection = settings.indexOf('"회사 공통 설정"');
  assert.ok(pageTitle >= 0 && companySection > pageTitle);
  assert.match(settings, /"직원별 급여 설정"/);
  assert.match(settings, /"Cài đặt chung của công ty"/);
  assert.match(settings, /commonGrid/);
});

test("employee selector has accessible selected styling and complete empty states", () => {
  assert.match(settings, /aria-pressed=\{selectedUser\}/);
  assert.match(settings, /personSelected/);
  assert.match(settings, /"선택됨"/);
  assert.match(settings, /"Đã chọn"/);
  assert.match(settings, /"직원을 선택하면 급여 설정을 확인할 수 있습니다\."/);
  assert.match(settings, /"Chọn nhân viên để xem cài đặt lương\."/);
});

test("employee insurance form is collapsed and resets from the current setting per employee", () => {
  assert.match(employeeInsurance, /const \[formOpen, setFormOpen\] = useState\(false\)/);
  assert.match(employeeInsurance, /setEnrolled\(setting\?\.isEnrolled \?\? false\)/);
  assert.match(employeeInsurance, /setBase\(String\(setting\?\.insuranceBaseAmount \?\? 0\)\)/);
  assert.match(employeeInsurance, /setEffectiveMonth\(currentMonth\(\)\)/);
  assert.match(employeeInsurance, /setNote\(""\)/);
  assert.match(employeeInsurance, /setFormOpen\(false\)/);
  assert.match(employeeInsurance, /resetForm\(null\)/);
  assert.match(employeeInsurance, /\[load, resetForm, userId, vi\]/);
  assert.match(employeeInsurance, /<details/);
  assert.match(employeeInsurance, /`설정 이력 \$\{history\.length\}건`/);
});

test("director employee keeps global-only insurance guidance", () => {
  assert.match(settings, /selected\.username !== "mjk"/);
  assert.match(settings, /"법인장 보험은 위의 회사 공통 보험 설정에서 관리합니다\."/);
  assert.match(
    settings,
    /"Bảo hiểm giám đốc pháp nhân được quản lý trong phần cài đặt bảo hiểm chung của công ty ở trên\."/,
  );
  assert.match(globalInsurance, /"보험 기준"/);
});

test("contract and insurance histories are collapsed and localized", () => {
  assert.match(settings, /<details style=\{s\.details\}>/);
  assert.match(settings, /`계약 이력 \$\{contracts\.length\}건`/);
  assert.match(settings, /`Lịch sử hợp đồng \$\{contracts\.length\} mục`/);
  assert.match(employeeInsurance, /"보험 설정 변경"/);
  assert.match(employeeInsurance, /"Thay đổi cài đặt bảo hiểm"/);
});
