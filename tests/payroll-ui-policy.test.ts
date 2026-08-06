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
const roles = read("lib/common/roles.ts");
const employeeInsurance = read(
  "components/payroll/EmployeeInsuranceSettings.tsx",
);
const commonSettings = read(
  "components/payroll/PayrollCommonSettings.tsx",
);
const payrollModal = read("components/payroll/PayrollModal.tsx");
test("payroll pages use forms and mobile cards without prompt or wide tables", () => {
  for (const source of [list, detail, settings])
    assert.doesNotMatch(source, /prompt\s*\(/);
  assert.doesNotMatch(list, /<table/);
  assert.match(list, /PaymentBatchCard/);
  assert.match(detail, /Chi trả theo nhân viên|직원별 지급 내역/);
  assert.match(settings, /PayrollModal/);
});
test("current contract summary hides legacy calculation basis and revision labels only", () => {
  const summary = settings.slice(
    settings.indexOf("function ContractSummary"),
    settings.indexOf("function Field("),
  );
  assert.doesNotMatch(summary, /급여 산정 방식|Cách tính lương|label="revision"/);
  assert.match(summary, /월 계약급여|고정 급여인상|레벨 인상|합산급여|급여 형태|적용 시작일/);
  assert.match(settings, /expectedRevision: correcting\?\.revision/);
  assert.match(settings, /변경번호 \$\{contract\.revision\}/);
  assert.match(settings, /calculationBasis: selectedIsOwner \? "fixed_monthly" : "minute"/);
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
  assert.match(settings, /await load\(userId\)/);
});
test("ledger detail is read-only and omits the retired review and transition workflow", () => {
  for (const action of ["force_finalize","cancel_finalization","recalculate","resolve_review","mutate_item"])
    assert.doesNotMatch(detail, new RegExp(action));
  assert.match(detail, /calculation_snapshot/);
});
test("payroll position labels are role-based (via the shared lib/common/roles module), not position-based, with a username fallback", () => {
  for (const source of [compensationCard, settings]) {
    assert.match(source, /from "@\/lib\/common\/roles"/);
    assert.match(source, /getEmployeeRoleLabel\(/);
    assert.doesNotMatch(source, /attendance\.positions\[/);
  }
  assert.match(compensationCard, /employee\.role\s*\n?\s*\? getEmployeeRoleLabel\(employee\.role, lang\)/);
  assert.match(compensationCard, /: employee\.username/);
  assert.match(settings, /user\.role \? getEmployeeRoleLabel\(user\.role, l\) : user\.username/);
  assert.match(roles, /manager: \{ ko: "매니저", vi: "Quản lý" \}/);
});

test("payroll settings uses accessible bilingual common and employee tabs", () => {
  assert.match(settings, /role="tablist"/);
  assert.equal((settings.match(/role="tab"/g) ?? []).length, 2);
  assert.equal((settings.match(/aria-selected=/g) ?? []).length, 2);
  for (const label of ["공통 설정", "직원 설정", "Cài đặt chung", "Cài đặt nhân viên"])
    assert.match(settings, new RegExp(label));
  assert.match(settings, /tabParam === "common" \|\| tabParam === "employee"/);
  assert.match(settings, /params\.has\("userId"\)[\s\S]*\? "employee"[\s\S]*: "common"/);
  assert.match(settings, /router\.replace\(`\$\{pathname\}\?\$\{next\}`,[\s\S]*scroll: false/);
});

test("explicit common tab wins while legacy userId links default to employee", () => {
  assert.match(settings, /tabParam === "common" \|\| tabParam === "employee"[\s\S]*\? tabParam/);
  assert.match(settings, /params\.has\("userId"\)/);
  assert.match(compensationCard, /settings\?tab=employee&userId=\$\{employee\.userId\}/);
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

test("employee payroll requests ignore aborts without allowing stale state", () => {
  for (const source of [employeeInsurance, settings]) {
    assert.match(source, /signal\?\.aborted|controller\.signal\.aborted/);
    assert.match(source, /name === "AbortError"|name==="AbortError"/);
    assert.match(source, /\.abort\(\)/);
    assert.match(source, /mounted\.current|setContracts\(\[\]\)/);
  }
  assert.match(settings, /setContracts\(\[\]\)/);
  assert.match(settings, /if \(!response\.ok\) \{[\s\S]*setSelectedInsuranceError\(true\)/);
});

test("employee insurance remounts per employee without the removed schedule editor", () => {
  assert.match(settings, /key=\{`insurance-\$\{selected\.id\}`\}/);
  assert.doesNotMatch(settings, /key=\{selected\.id\}/);
  assert.doesNotMatch(settings, /PayrollScheduleVersions/);
  assert.match(settings, /selected\.username !== "mjk"/);
});

test("employee settings cards share compact mobile dimensions", () => {
  for (const source of [employeeInsurance, settings]) {
    assert.match(source, /fontSize: ?15/);
    assert.match(source, /fontSize: ?12/);
    assert.match(source, /minHeight: ?36/);
    assert.match(source, /padding: ?13/);
  }
  assert.match(settings, /summaryName: \{ fontSize: 16/);
  assert.match(employeeInsurance, /minHeight: 40/);
});

test("contract editor uses cumulative fixed raises and schedule-derived read-only hours", () => {
  assert.match(settings, /고정 급여인상 총액/);
  assert.match(settings, /Tổng mức tăng lương cố định/);
  assert.match(settings, /scheduledMinutesPerDay\(effectiveSchedule\.startTime/);
  assert.match(settings, /현재 근무시간/);
  assert.match(settings, /근무시간 이력/);
  assert.doesNotMatch(settings, /type="number"[^>]*value=\{form\.standardHoursPerDay\}/);
  assert.match(settings, /paidLeaveMode: "unpaid"/);
  assert.match(settings, /earlyLeaveAdjustmentMode: "deduct_minutes"/);
  assert.doesNotMatch(settings, /label=\{vi \? "Ngày nghỉ" : "휴무 처리"\}/);
  assert.doesNotMatch(settings, /label=\{vi \? "Về sớm" : "조퇴 처리"\}/);
  assert.doesNotMatch(settings, /label=\{vi \? "Lý do thay đổi" : "변경 사유"\}/);
});

test("contract amount formatting, read-only schedule summary, and modal focus are stable", () => {
  assert.match(settings, /function MoneyInputField/);
  assert.match(settings, /value=\{formatIntegerInput\(value\)\}/);
  assert.match(settings, /change\(integerInputDigits\(event\.target\.value\)\)/);
  assert.match(settings, /current \? scheduleValue\(current\)/);
  assert.match(settings, /minutes \/ 60/);
  assert.doesNotMatch(settings, /<small style=\{s\.fieldHelp\}>\{hoursInputToMinutes/);
  assert.match(payrollModal, /const onCloseRef=useRef\(onClose\)/);
  assert.match(payrollModal, /onCloseRef\.current=onClose/);
  assert.match(payrollModal, /if\(e\.key==="Escape"\)onCloseRef\.current\(\)/);
  assert.match(payrollModal, /closeRef\.current\?\.focus\(\)[\s\S]*document\.body\.style\.overflow="hidden"[\s\S]*\},\[\]\)/);
  assert.doesNotMatch(payrollModal, /closeRef\.current\?\.focus\(\)[\s\S]*\},\[onClose\]\)/);
});

test("fixed raise reason is conditional in UI and enforced by the server", () => {
  const route = read("app/api/admin/payroll/contracts/route.ts");
  assert.match(settings, /fixedRaiseChanged \? <Field label=\{vi \? "Lý do thay đổi mức tăng lương cố định" : "고정 급여인상 사유"\}/);
  assert.match(settings, /note: fixedRaiseChanged \? form\.fixedRaiseReason\.trim\(\) : correcting\?\.note \?\? null/);
  assert.doesNotMatch(settings, /Chênh lệch/);
  assert.match(route, /FIXED_RAISE_REASON_REQUIRED/);
  assert.match(route, /payroll_create_contract_version_v5/);
  assert.match(route, /p_note: fixedRaiseReason\.note/);
});

test("direct employee clicks scroll only after the selected employee finishes loading", () => {
  assert.match(settings, /pendingScrollUserIdRef/);
  assert.match(settings, /contractsLoading/);
  assert.match(settings, /selectedInsuranceLoading/);
  assert.match(settings, /employeeListOpen/);
  assert.match(settings, /scrollIntoView\(\{ behavior: "smooth", block: "start" \}\)/);
  assert.match(settings, /scrollMarginTop: 72/);
});

test("employee payroll parts use the shared localized formatter", () => {
  assert.match(settings, /partLabel\(l, user\.part\)/);
  assert.doesNotMatch(settings, /\{user\.part \?\? "-"\}/);
  assert.doesNotMatch(settings, /\{selected\.part \?\? "-"\}/);
  assert.match(settings, /employeeMetaLabel\(user\)/);
  assert.match(settings, /employeeMetaLabel\(selected\)/);
  assert.match(list, /partLabel\(l,group\.part\)/);
});

test("contract modal starts at the top and renders the effective date first", () => {
  assert.match(settings, /<PayrollModal\s+[\s\S]*?placement="top"/);
  const formStart = settings.indexOf('<form id="contract"');
  const baseSalary = settings.indexOf('value={form.baseSalary}', formStart);
  const effectiveDate = settings.indexOf('value={form.effectiveFrom}', formStart);
  const fixedRaise = settings.indexOf('value={form.fixedRaiseAmount}', formStart);
  assert.ok(formStart >= 0 && effectiveDate > formStart && baseSalary > effectiveDate && fixedRaise > baseSalary);
  assert.equal(settings.indexOf('value={form.effectiveFrom}', effectiveDate + 1), -1);
  assert.match(payrollModal, /placement\?:"bottom"\|"top"/);
  assert.match(payrollModal, /alignItems:"flex-start"/);
  assert.match(payrollModal, /100dvh/);
  assert.match(payrollModal, /env\(safe-area-inset-top\)/);
  assert.match(payrollModal, /env\(safe-area-inset-bottom\)/);
  assert.match(payrollModal, /overflowY:"auto"/);
  assert.match(payrollModal, /flexShrink:0/);
});

test("fixed monthly date failures alert inside the open modal flow", () => {
  assert.match(settings, /form\.calculationBasis === "fixed_monthly" && !isMonthFirstDate\(form\.effectiveFrom\)/);
  assert.match(settings, /window\.alert\(fixedMonthlyEffectiveDateMessage\)/);
  assert.ok(settings.indexOf("!isMonthFirstDate(form.effectiveFrom)") < settings.indexOf("setSaving(true)"));
  assert.match(settings, /payrollContractErrorMessage\(l, data\.code,/);
  assert.match(settings, /const \[modalError, setModalError\] = useState\(""\)/);
  assert.match(settings, /modalError \? <p role="alert"/);
  assert.doesNotMatch(settings, /setError\(vi \? "Hợp đồng trả cố định hàng tháng/);
  assert.match(settings, /finally \{\s*setSaving\(false\)/);
});

test("v7 retains early-leave audit inputs without creating a separate deduction", () => {
  const run = read("lib/payroll/monthly-run.ts");
  for (const field of ["rawEarlyLeaveMinutes", "earlyLeaveThresholdMinutes", "isEarlyLeave", "deductionEarlyLeaveMinutes", "calculationBasis", "minuteRate", "calculatedAmount", "scheduleRevision", "storeSettingsRevision"])
    assert.match(run, new RegExp(field));
  assert.doesNotMatch(run, /item\("early_leave_deduction"/);
  assert.match(run, /STORED_EARLY_LEAVE_MINUTES_MISMATCH/);
});

test("insurance form reveals details only for meaningful enrollment transitions", () => {
  assert.match(employeeInsurance, /enrolled \|\| current\?\.isEnrolled === true/);
  assert.match(employeeInsurance, /if \(!enrolled && current\?\.isEnrolled !== true\) return/);
  assert.match(employeeInsurance, /insuranceBaseAmount: enrolled \? Number\(base\) : 0/);
  assert.match(employeeInsurance, /보험 설정 적용/);
  assert.match(employeeInsurance, /Áp dụng cài đặt bảo hiểm/);
});

test("director employee keeps global-only insurance guidance", () => {
  assert.match(settings, /selected\.username !== "mjk"/);
  assert.match(settings, /"법인장 보험은 위의 회사 공통 보험 설정에서 관리합니다\."/);
  assert.match(
    settings,
    /"Bảo hiểm giám đốc pháp nhân được quản lý trong phần cài đặt bảo hiểm chung của công ty ở trên\."/,
  );
  assert.match(commonSettings, /"보험"/);
});

test("contract and insurance histories are collapsed and localized", () => {
  assert.match(settings, /<details style=\{s\.details\}>/);
  assert.match(settings, /`계약 이력 \$\{contracts\.length\}건`/);
  assert.match(settings, /`Lịch sử hợp đồng \$\{contracts\.length\} mục`/);
  assert.match(employeeInsurance, /"보험 설정 변경"/);
  assert.match(employeeInsurance, /"Thay đổi cài đặt bảo hiểm"/);
});

test("common payroll settings has one read and one unified save flow", () => {
  assert.equal(
    (commonSettings.match(/fetch\("\/api\/admin\/payroll\/settings"/g) ?? []).length,
    2,
  );
  assert.equal((commonSettings.match(/method: "PATCH"/g) ?? []).length, 1);
  for (const field of [
    "paymentDay",
    "employeeInsuranceRateBp",
    "employerInsuranceRateBp",
    "directorInsuranceEnabled",
    "directorInsuranceBaseAmount",
    "directorInsuranceRateBp",
  ]) assert.match(commonSettings, new RegExp(`${field}:`));
  assert.match(commonSettings, /JSON\.stringify\(payload\) !== JSON\.stringify\(snapshotPayload\)/);
  assert.match(commonSettings, /disabled=\{!dirty \|\| !valid \|\| saving\}/);
  assert.match(commonSettings, /setDraft\(next\);[\s\S]*setSnapshot\(next\)/);
  assert.match(commonSettings, /percentToBasisPoints/);
  assert.equal((commonSettings.match(/공통 설정 저장/g) ?? []).length, 1);
});

test("common settings uses compact rows without duplicate page headings", () => {
  assert.match(commonSettings, /function SettingRow/);
  assert.match(commonSettings, /function SettingsGroup/);
  assert.match(commonSettings, /gridTemplateColumns: "minmax\(104px, auto\) minmax\(0, 1fr\)"/);
  assert.match(commonSettings, /width: 56/);
  assert.match(commonSettings, /height: 34/);
  assert.match(commonSettings, /padding: "4px 6px"/);
  assert.match(commonSettings, /"매월 1일 ~ 말일"/);
  for (const label of ["직원 부담률", "회사 부담률", "법인장 보험", "법인장 기준금액", "법인장 부담률", "월 보험비용"])
    assert.match(commonSettings, new RegExp(label));
  for (const removed of ["급여 지급일, 공통 보험 기준", '"회사 공통 설정"', '"직원별 급여 설정"'])
    assert.doesNotMatch(settings, new RegExp(removed));
});

test("common settings formats the director base and describes inclusive late thresholds", () => {
  assert.match(commonSettings, /formatIntegerInput/);
  assert.match(commonSettings, /type="text"[\s\S]*inputMode="numeric"/);
  assert.match(commonSettings, /directorInsuranceBaseAmount: integerInputDigits\(event\.target\.value\)/);
  for (const label of ["지각 구간 기준", "Mốc phân loại", "분 초과 지각", "Đi muộn quá", "일당의", "lương ngày"])
    assert.match(commonSettings, new RegExp(label));
});
