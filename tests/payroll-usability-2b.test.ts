import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { countPayrollDashboardFilters, expandedPartsForPayrollFilter, matchesPayrollDashboardFilter } from "../lib/payroll/payroll-dashboard.ts";
import { getPayrollReviewReasons, payrollReviewCategoryForCode, payrollReviewCategoryHref } from "../lib/payroll/review-reasons.ts";
import { pickAttendanceBonus, pickContract, pickInsurance, pickMealAllowance, pickTax, pickWorkSchedule, resolveSettingsSummaryReference } from "../lib/payroll/settings-summary.ts";
import { selectInsuranceSetting } from "../lib/payroll/insurance.ts";
import { selectEmployeeTaxSetting } from "../lib/payroll/tax.ts";
import { reviewLabel } from "../lib/payroll/ui-labels.ts";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const page = read("app/(protected)/admin/payroll/page.tsx");
const card = read("components/payroll/CompensationCard.tsx");
const settingsPage = read("app/(protected)/admin/payroll/settings/page.tsx");
const summary = read("components/payroll/EmployeeSettingsSummary.tsx");

type E = Parameters<typeof matchesPayrollDashboardFilter>[0];
const employee = (userId: number, status: E["calculationStatus"], paid: boolean): E => ({
  userId, name: `u${userId}`, contract: {}, calculationStatus: status,
  amounts: { combinedSalary: 1, contractMonthlyEquivalent: 1, currentAmount: 1, netPayoutAmount: 1 },
  payment: paid ? { payment_status: "paid", actual_paid_amount: 1 } : null,
});
const groups = [
  { part: "owner", employees: [employee(1, "calculable", true)] },
  { part: "hall", employees: [employee(2, "requires_review", false), employee(3, "calculable", true)] },
  { part: "kitchen", employees: [employee(4, "calculable", false)] },
  { part: "bar", employees: [employee(5, "calculable", true)] },
];

// ---------------------------------------------------------------------------
// A. 필터 연동 파트 자동 펼침
// ---------------------------------------------------------------------------

test("filter auto-expands only parts that have matching employees; 전체 restores the default", () => {
  assert.deepEqual([...expandedPartsForPayrollFilter(groups, "review")], ["hall"]);
  assert.deepEqual([...expandedPartsForPayrollFilter(groups, "unpaid")].sort(), ["hall", "kitchen"]);
  assert.deepEqual([...expandedPartsForPayrollFilter(groups, "all")], ["owner"]);
  // 펼친 파트의 필터 결과 수 합계 = 필터 카운트 (파트 인원수와 필터 결과 일치)
  const all = groups.flatMap(group => group.employees);
  for (const filter of ["review", "unpaid", "paid"] as const) {
    const expanded = expandedPartsForPayrollFilter(groups, filter);
    const visible = groups.filter(group => expanded.has(group.part)).reduce((sum, group) => sum + group.employees.filter(item => matchesPayrollDashboardFilter(item, filter)).length, 0);
    assert.equal(visible, countPayrollDashboardFilters(all)[filter], filter);
  }
});

test("payroll page wires filter changes to part expansion and closes an expanded card", () => {
  assert.match(page, /function changeFilter\(next:PayrollDashboardFilter\)\{setFilter\(next\);setExpandedUserId\(null\);setExpandedParts\(expandedPartsForPayrollFilter\(groups,next\)\)\}/);
  assert.match(page, /onChange=\{changeFilter\}/);
  assert.match(page, /if\(overview&&overview\.month===month&&partsSyncedMonth!==overview\.month\)\{setPartsSyncedMonth\(overview\.month\);if\(filter!=="all"\)setExpandedParts/);
  // 파트 인원 표시는 기존 그대로 visible / total
  assert.match(page, /filter==="all"\?group\.employees\.length:`\$\{group\.visibleEmployees\.length\} \/ \$\{group\.employees\.length\}`/);
});

// ---------------------------------------------------------------------------
// B·C. 확인 필요 사유와 바로가기
// ---------------------------------------------------------------------------

const base = { contract: {}, amounts: { combinedSalary: 1000 } };

test("review reasons exist only when the backend status is not calculable", () => {
  assert.deepEqual(getPayrollReviewReasons({ ...base, calculationStatus: "calculable", warningCodes: ["MISSING_CHECK_IN"] }, false, "ko"), { categories: [], details: [] });
});

test("review reasons reuse warningCodes with existing labels and are prioritised for the header", () => {
  const reasons = getPayrollReviewReasons({ ...base, calculationStatus: "requires_review", warningCodes: ["TAX_PROFILE_REQUIRES_REVIEW", "PART_TIME_EXTRA_WORK_REVIEW_REQUIRED", "MISSING_CHECK_OUT", "MISSING_CHECK_IN"] }, false, "ko");
  assert.deepEqual(reasons.categories, ["attendance", "extraWork", "insuranceTax"]);
  assert.deepEqual(reasons.details.map(item => item.label), ["TNCN 설정(직원 프로필) 확인이 필요합니다.", "추가근무 승인이 필요합니다.", "퇴근 기록이 없습니다.", "출근 기록이 없습니다."]);
  const vi = getPayrollReviewReasons({ ...base, calculationStatus: "requires_review", warningCodes: ["MISSING_CHECK_IN"] }, false, "vi");
  assert.equal(vi.details[0].label, reviewLabel("vi", "MISSING_CHECK_IN"));
});

test("unavailable employees get the same reason the card already shows (contract / level)", () => {
  assert.deepEqual(getPayrollReviewReasons({ contract: null, amounts: { combinedSalary: null }, calculationStatus: "unavailable", warningCodes: [] }, false, "ko").categories, ["contract"]);
  assert.deepEqual(getPayrollReviewReasons({ contract: {}, amounts: { combinedSalary: null }, calculationStatus: "unavailable", warningCodes: [] }, false, "ko").categories, ["level"]);
  // 코드가 없는 requires_review(예: 레벨 상태)도 "확인 필요"로 남는다 — 사유 없이 숨기지 않는다.
  assert.deepEqual(getPayrollReviewReasons({ ...base, calculationStatus: "requires_review", warningCodes: [] }, false, "ko").categories, ["other"]);
});

test("every backend warning code with a label has a resolution category", () => {
  const labelled = ["EARLY_LEAVE_REVIEW_REQUIRED", "NO_PAYROLL_CONTRACT", "MISSING_CHECK_IN", "MISSING_CHECK_OUT", "INVALID_TIME_RANGE", "SCHEDULE_HISTORY_UNAVAILABLE", "CONTRACT_OVERLAP", "PENDING_LEAVE_APPROVAL", "LEAVE_PAYROLL_TREATMENT_UNSPECIFIED", "OVERTIME_APPROVAL_UNAVAILABLE", "LATE_POLICY_REVIEW", "EARLY_LEAVE_POLICY_REVIEW", "STORED_STATUS_POLICY_MISMATCH", "STORED_LATE_MINUTES_MISMATCH", "STORED_EARLY_LEAVE_MINUTES_MISMATCH", "STORED_WORK_MINUTES_MISMATCH", "EMPLOYEE_LEVEL_BASE_DATE_REQUIRED", "PART_TIME_EXTRA_WORK_REVIEW_REQUIRED", "PART_TIME_EXTRA_WORK_DECISION_STALE", "TAX_PROFILE_REQUIRES_REVIEW", "TAX_POLICY_MISSING", "TAX_POLICY_INVALID", "OVERTIME_TAX_EXEMPTION_REQUIRES_REVIEW", "UNRESOLVED_ATTENDANCE"];
  for (const code of labelled) assert.notEqual(payrollReviewCategoryForCode(code), "other", code);
  assert.equal(payrollReviewCategoryForCode("CALCULATION_FAILED"), "other");
});

test("shortcuts keep the employee ID and month and only use existing screens", () => {
  assert.equal(payrollReviewCategoryHref("attendance", 7, "2026-10"), "/admin/payroll/attendance/7?month=2026-10");
  assert.equal(payrollReviewCategoryHref("contract", 7, "2026-10"), "/admin/payroll/settings?tab=employee&userId=7&month=2026-10");
  assert.equal(payrollReviewCategoryHref("insuranceTax", 7, "2026-10"), "/admin/payroll/settings?tab=employee&userId=7&month=2026-10");
  assert.equal(payrollReviewCategoryHref("extraWork", 7, "2026-10"), null);
  assert.match(card, /<div id=\{extraWorkAnchorId\} style=\{s\.extraWorkAnchor\}><PartTimeExtraWorkSection/);
  assert.match(card, /document\.getElementById\(extraWorkAnchorId\)\?\.scrollIntoView/);
  // 지급 불가 블록(마감 월)은 기존 문구를 유지하고 바로가기만 덧붙인다.
  assert.match(card, /<ul style=\{s\.blockingReasonList\}>[^\n]*<ReviewReasonActions/);
  assert.match(card, /settings\?tab=employee&userId=\$\{employee\.userId\}&month=\$\{month\}/);
});

// ---------------------------------------------------------------------------
// 2차-B 후속: 확인 필요 배지 위치 · 상세 접힘
// ---------------------------------------------------------------------------

test("non-calculable employees show the top-priority problem badge in the net-amount slot", () => {
  const strip = card.slice(card.indexOf("{!future && <span style={s.amountStripCell}>"), card.indexOf("{expanded && ("));
  assert.match(strip, /reviewReasons && reviewReasons\.categories\.length > 0 \? <>\n\s*<ReviewProblemBadge category=\{reviewReasons\.categories\[0\]\}/);
  assert.match(strip, /\+\{reviewReasons\.categories\.length - 1\}<\/button>/);
  assert.match(strip, /aria-expanded=\{moreReasonsOpen\}/);
  // 정상 계산 직원은 기존 계산 실수령 표시 유지
  assert.match(strip, /: <>\n\s*<span style=\{s\.amountStripLabel\}>\{lang === "vi" \? "Thực nhận đã tính" : "계산 실수령"\}<\/span>/);
  // 배지는 헤더 버튼 밖(형제)에 있어 버튼 중첩이 없다
  const headStart = card.indexOf("<button style={s.head} onClick={toggle}") + 1;
  const head = card.slice(headStart, card.indexOf("</button>", headStart));
  assert.doesNotMatch(head, /ReviewProblemBadge|<button|<a |<Link/);
  // 헤더 사유 칩 · 상세 상단 빨간 배너 · 추가근무 경고 강조 제거
  assert.doesNotMatch(card, /reviewReasonRow|reviewReasonChip|ReviewReasonPanel|extraWorkBadgeAlert|extraWorkNeedsReview/);
});

test("problem badge routes to the existing resolution place without closing the card", () => {
  const badge = card.slice(card.indexOf("function ReviewProblemBadge("), card.indexOf("function CollapsibleDetailSection("));
  assert.match(badge, /if \(category === "extraWork"\) return <button type="button"[^>]*onClick=\{onExtraWork\}>/);
  assert.match(badge, /const href = payrollReviewCategoryHref\(category, userId, month\);/);
  assert.match(badge, /href \? <Link href=\{href\}/);
  // 접혀 있을 때만 펼치고(닫지 않음), 렌더 후 추가근무 섹션으로 스크롤
  assert.match(card, /const focusExtraWork = \(\) => \{ if \(!expanded\) toggle\(\); setExtraWorkScrollRequested\(true\); \};/);
  assert.match(card, /if \(!extraWorkScrollRequested \|\| !expanded\) return;[\s\S]*document\.getElementById\(extraWorkAnchorId\)\?\.scrollIntoView/);
});

test("salary composition and month application are independent collapsed banners with existing values", () => {
  const section = card.slice(card.indexOf("function CollapsibleDetailSection("), card.indexOf("function ReviewReasonActions("));
  assert.match(section, /const \[open, setOpen\] = useState\(false\);/);
  assert.match(section, /aria-expanded=\{open\}/);
  assert.match(section, /\{open && <div id=\{bodyId\} style=\{\{ \.\.\.s\.sectionRows, \.\.\.s\.collapsibleBody \}\}>\{children\}<\/div>\}/);
  // 펼침 상태 시각 구분: 제목 왼쪽 화살표(› / ⌄), 연회색 헤더, 상세 구분선
  assert.match(section, /\{open \? "⌄" : "›"\}/);
  assert.match(section, /open \? s\.collapsibleHeaderOpen/);
  assert.match(section, /open \? s\.collapsibleGroupOpen/);
  assert.ok(section.indexOf("collapsibleChevron") < section.indexOf("{title}"), "chevron sits left of the title");
  assert.match(card, /collapsibleHeaderOpen: \{ backgroundColor:"#f3f4f6" \}/);
  // 접힘↔펼침에서 병합되는 스타일은 축약/개별 속성을 섞지 않는다(React shorthand 충돌 경고 방지).
  const styleLine = (name: string) => card.match(new RegExp(`^  ${name}: \\{.*\\},$`, "m"))?.[0] ?? "";
  assert.match(styleLine("collapsibleGroup"), /borderWidth:1, borderStyle:"solid", borderColor:"transparent"/);
  assert.doesNotMatch(styleLine("collapsibleGroup"), /\bborder:/);
  assert.doesNotMatch(styleLine("collapsibleHeader"), /\bbackground:/);
  assert.match(card, /collapsibleBody: \{ borderTop:"1px solid #e5e7eb"/);
  assert.match(card, /<CollapsibleDetailSection icon="💰" title=\{detailText\.salaryComposition\} summary=\{formatContractRate\(combined, employee\.contract\.payType, lang\)\} first>/);
  assert.match(card, /<CollapsibleDetailSection icon="📅" title=\{detailText\.monthApplication\} summary=\{employee\.amounts\.workAppliedAmount === null \? \(lang === "vi" \? "Cần kiểm tra" : "확인 필요"\) : formatVnd\(employee\.amounts\.workAppliedAmount\)\}/);
  // 다른 섹션은 기존 DetailSection 유지
  assert.match(card, /<DetailSection icon="🛡️" title=\{lang === "vi" \? "Tính thực nhận nhân viên" : "직원 지급 계산"\}>/);
});

// ---------------------------------------------------------------------------
// 2. 급여설정 통합 요약
// ---------------------------------------------------------------------------

test("summary reference distinguishes current, past and future months", () => {
  assert.deepEqual(resolveSettingsSummaryReference(null, "2026-11-04"), { month: "2026-11", date: "2026-11-04", kind: "current", fromPayrollMonth: false });
  assert.deepEqual(resolveSettingsSummaryReference("2026-09", "2026-11-04"), { month: "2026-09", date: "2026-09-30", kind: "past", fromPayrollMonth: true });
  assert.deepEqual(resolveSettingsSummaryReference("2027-02", "2026-11-04"), { month: "2027-02", date: "2027-02-01", kind: "future", fromPayrollMonth: true });
  assert.equal(resolveSettingsSummaryReference("2026-13", "2026-11-04").kind, "current");
});

test("versions are picked for the reference month with the same rules payroll uses, and later versions are shown as scheduled", () => {
  const insurance = [
    { id: 1, userId: 1, isEnrolled: false, insuranceBaseAmount: 0, effectiveMonth: "2026-01-01", revision: 1, createdBy: 1, createdAt: "", note: null },
    { id: 2, userId: 1, isEnrolled: true, insuranceBaseAmount: 5, effectiveMonth: "2026-10-01", revision: 1, createdBy: 1, createdAt: "", note: null },
    { id: 3, userId: 1, isEnrolled: false, insuranceBaseAmount: 0, effectiveMonth: "2026-12-01", revision: 1, createdBy: 1, createdAt: "", note: null },
  ];
  const past = resolveSettingsSummaryReference("2026-09", "2026-11-04");
  const current = resolveSettingsSummaryReference(null, "2026-11-04");
  assert.equal(pickInsurance(insurance, past).applied?.id, 1);
  assert.equal(pickInsurance(insurance, past).applied, selectInsuranceSetting(insurance, "2026-09"));
  assert.equal(pickInsurance(insurance, current).applied?.id, 2);
  assert.equal(pickInsurance(insurance, current).scheduled?.id, 3);
  // 과거 월에 적용 버전이 없으면 현재 설정을 끌어오지 않는다.
  assert.equal(pickInsurance(insurance.slice(1), past).applied, null);

  const contracts = [
    { id: 2, effectiveFrom: "2026-11-01", effectiveTo: null, payType: "monthly", baseSalary: 9, fixedRaiseAmount: 0 },
    { id: 1, effectiveFrom: "2026-01-01", effectiveTo: "2026-11-01", payType: "monthly", baseSalary: 8, fixedRaiseAmount: 0 },
    { id: 3, effectiveFrom: "2027-01-01", effectiveTo: null, payType: "monthly", baseSalary: 10, fixedRaiseAmount: 0 },
  ];
  assert.equal(pickContract(contracts, past).applied?.id, 1);
  assert.equal(pickContract(contracts, past).scheduled?.id, 2);
  assert.equal(pickContract(contracts.slice(0, 1), past).applied, null);

  const schedules = [{ id: 1, userId: 1, startTime: "09:00", endTime: "18:00", unpaidBreakMinutes: 60, effectiveFrom: "2026-10-15", effectiveTo: null, revision: 1, changeReason: null }];
  assert.equal(pickWorkSchedule(schedules, past).applied, null);
  assert.equal(pickWorkSchedule(schedules, current).applied?.id, 1);

  const meal = [{ isEligible: true, effectiveFrom: "2026-09-20", revision: 1 }, { isEligible: false, effectiveFrom: "2026-11-10", revision: 1 }];
  assert.equal(pickMealAllowance(meal, past).applied?.isEligible, true);
  assert.equal(pickMealAllowance(meal, current).scheduled?.effectiveFrom, "2026-11-10");

  const bonus = [{ isEligible: true, effectiveMonth: "2026-10", revision: 1 }, { isEligible: true, effectiveMonth: "2026-10", revision: 2 }];
  assert.equal(pickAttendanceBonus(bonus, past).applied, null);
  assert.equal(pickAttendanceBonus(bonus, current).applied?.revision, 2);
});

test("TNCN review flag mirrors the payroll profile checks only", () => {
  const version = { id: 1, userId: 1, effectiveMonth: "2026-10-01", taxMode: "resident_progressive" as const, dependentCount: 0, burdenMode: "employee_deducted" as const, accountingName: "A", insuranceDeductionMode: "none" as const, manualInsuranceDeductionAmount: 0, revision: 1, createdBy: 1, createdAt: "", note: null };
  const current = resolveSettingsSummaryReference(null, "2026-11-04");
  assert.equal(pickTax([version], current).requiresReview, false);
  assert.equal(pickTax([version], current).applied, selectEmployeeTaxSetting([version], "2026-11"));
  assert.equal(pickTax([{ ...version, accountingName: " " }], current).requiresReview, true);
  assert.equal(pickTax([{ ...version, taxMode: "not_applicable", accountingName: null }], current).requiresReview, false);
  assert.equal(pickTax([], current).requiresReview, true);
});

test("summary shows load failures separately from unset values and reuses card responses", () => {
  assert.match(summary, /if \(status === "error"\) return \{ key, label, anchor, tone: "error", value: t\.error \}/);
  assert.match(summary, /조회 실패 · 확인 불가/);
  assert.match(summary, /해당 월 적용 설정 없음/);
  assert.match(summary, /이후 변경/);
  assert.doesNotMatch(summary, /fetch\(/);
  assert.match(settingsPage, /resolveSettingsSummaryReference\(params\.get\("month"\), vietnamToday\)/);
  assert.match(settingsPage, /contractsLoading \? loadingHistory : contractsLoadFailed \? \{ status: "error", history: \[\] \}/);
  assert.match(settingsPage, /selectedId && taxHistoryState\?\.userId === selectedId \? taxHistoryState\.state : loadingHistory/);
  for (const file of ["EmployeeTaxSettings", "EmployeeMealAllowanceSettings", "EmployeeAttendanceBonusSettings"]) {
    const source = read(`components/payroll/${file}.tsx`);
    assert.match(source, /reportHistoryRef\.current\?\.\(\{ status: "error", history: \[\] \}\)/, file);
    assert.match(source, /reportHistoryRef\.current\?\.\(\{ status: "ready", history:/, file);
    assert.equal((source.match(/fetch\(/g) ?? []).length, file === "EmployeeAttendanceBonusSettings" ? 4 : 2, file);
  }
  for (const anchor of ["contract", "insurance", "tax", "meal", "bonus"]) assert.match(settingsPage, new RegExp(`EMPLOYEE_SETTING_ANCHORS\\.${anchor}`));
});
