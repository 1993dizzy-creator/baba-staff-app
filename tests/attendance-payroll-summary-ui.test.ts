import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const page = readFileSync(
  join(process.cwd(), "app/(protected)/attendance/page.tsx"),
  "utf8",
);

test("employee calendar renders existing check-in and check-out values below the status dot", () => {
  assert.match(page, /calendarDotStyle[\s\S]*?record\.check_in_at \|\| record\.check_out_at[\s\S]*?calendarTimeTextStyle/);
  assert.match(page, /record\.check_in_at \? formatTimeForDisplay\(record\.check_in_at\) : "-"/);
  assert.match(page, /record\.check_out_at \? formatTimeForDisplay\(record\.check_out_at\) : "-"/);
  assert.match(page, /const calendarTimeTextStyle: CSSProperties = \{[\s\S]*?fontSize: 9/);
  assert.match(page, /minHeight: 54/);
});

test("monthly payroll request follows the visible calendar month and exposes no user id", () => {
  assert.match(page, /const \{ monthKey \} = getMonthRange\(calendarDate\)/);
  assert.match(page, /attendanceFetch\(`\/api\/attendance\/payroll-summary\?month=\$\{monthKey\}`\)/);
  assert.match(page, /\}, \[calendarDate\]\);/);
  assert.doesNotMatch(page, /payroll-summary[^\n]*userId/);
  assert.doesNotMatch(page, /\/api\/admin\/payroll\/overview/);
});

test("old five-item attendance summary is replaced by payout and four attendance metrics", () => {
  assert.doesNotMatch(page, /<SummaryStatCard|monthSummaryTitle|summaryTotalWorkTime/);
  assert.match(page, /estimatedPayout: "현재 예상 지급액"/);
  assert.match(page, /insuranceApplied: "보험 반영"/);
  assert.match(page, /adjustments: "조정 내역"/);
  assert.match(page, /afterAdjustment: "조정 후"/);
  assert.match(page, /estimatedPayout: "Dự tính nhận"/);
  assert.match(page, /insuranceApplied: "Đã trừ BH"/);
  assert.match(page, /adjustments: "Điều chỉnh"/);
  assert.match(page, /afterAdjustment: "Sau điều chỉnh"/);
  assert.doesNotMatch(page, /조정·보험 반영|Khoản chi trả ước tính|Đã gồm điều chỉnh và bảo hiểm/);
  assert.match(page, /formatVnd\(payrollSummary\.netPayoutAmount\)/);
  assert.match(page, /formatSignedVnd\(payrollSummary\.incentiveAmount, "\+"\)/);
  assert.match(page, /formatSignedVnd\(payrollSummary\.penaltyAmount, "-"\)/);
  assert.match(page, /calculationStatus === "requires_review"/);
  assert.match(page, /calculationStatus === "unavailable"/);
  assert.equal((page.match(/<AttendanceSummaryItem /g) ?? []).length, 4);
  for (const metric of ["workDays", "leaveDays", "lateCount", "earlyLeaveCount"]) {
    assert.match(page, new RegExp(`attendance\\.monthSummary\\.${metric}`));
  }
});

test("payout area is vertically centered and insurance help is conditional", () => {
  assert.match(page, /const payrollSummaryHeaderStyle: CSSProperties = \{[\s\S]*?alignItems: "stretch"/);
  assert.match(page, /const estimatedPayoutStyle: CSSProperties = \{[\s\S]*?justifyContent: "center"/);
  assert.match(page, /const estimatedPayoutStyle: CSSProperties = \{[\s\S]*?alignItems: "flex-end"[\s\S]*?textAlign: "right"/);
  assert.match(page, /payrollSummary\.employeeInsuranceDeductionAmount > 0/);
  assert.match(page, /ps\.afterAdjustment/);
  assert.match(page, /ps\.insuranceApplied/);
  assert.doesNotMatch(page, /Math\.max\([^\n]*netPayoutAmount|netPayoutAmount[^\n]*\? 0/);
});

test("summary card omits profile identity and uses two stacked adjustment buttons", () => {
  const start = page.indexOf("<div style={payrollSummaryHeaderStyle}>");
  const summaryHeader = page.slice(start, page.indexOf("<div style={attendanceSummaryGridStyle}>", start));
  assert.doesNotMatch(summaryHeader, /EmployeeNameWithLevel|getEmployeeRoleLabel/);
  assert.match(summaryHeader, /estimatedPayoutLabelStyle/);
  assert.match(summaryHeader, /adjustmentGroupLabelStyle/);
  assert.ok(summaryHeader.indexOf("adjustmentGroupStyle") < summaryHeader.indexOf("estimatedPayoutStyle"));
  assert.match(summaryHeader, /setPayrollDetailKind\("incentive"\)/);
  assert.match(summaryHeader, /setPayrollDetailKind\("penalty"\)/);
  assert.match(page, /const adjustmentButtonStackStyle: CSSProperties = \{[\s\S]*?flexDirection: "column"/);
  assert.match(page, /const incentiveButtonStyle: CSSProperties = \{[\s\S]*?border: "1px solid #86efac"/);
  assert.match(page, /const penaltyButtonStyle: CSSProperties = \{[\s\S]*?border: "1px solid #fca5a5"/);
});

test("detail modal is localized, scrollable through the shared modal, and handles empty lists and totals", () => {
  assert.match(page, /<PayrollModal[\s\S]*?placement="top"/);
  assert.match(page, /data\?\.incentives \?\? \[\]/);
  assert.match(page, /data\?\.penalties \?\? \[\]/);
  assert.match(page, /noIncentives: "등록된 인센티브 내역이 없습니다\."/);
  assert.match(page, /noPenalties: "등록된 패널티 내역이 없습니다\."/);
  assert.match(page, /incentiveDetails: "Chi tiết thưởng"/);
  assert.match(page, /penaltyDetails: "Chi tiết phạt"/);
  assert.match(page, /data\?\.summary\.incentiveAmount \?\? 0/);
  assert.match(page, /data\?\.summary\.penaltyAmount \?\? 0/);
  assert.match(page, /item\.businessDate\.slice\(5\)/);
  assert.match(page, /item\.note/);
  assert.match(page, /item\.minutes/);
});

test("four attendance chips match the admin icon-value-label border structure", () => {
  for (const icon of ["📅", "🌴", "⏰", "🏃"]) assert.match(page, new RegExp(`icon="${icon}"`));
  assert.match(page, /attendanceSummaryTopRowStyle/);
  assert.match(page, /<span aria-hidden="true">\{icon\}<\/span>/);
  assert.match(page, /const attendanceSummaryItemStyle: CSSProperties = \{[\s\S]*?borderRadius: 10,[\s\S]*?background: "#f9fafb",[\s\S]*?border: "1px solid #e5e7eb"/);
  assert.match(page, /borderTop: "1px dashed #e5e7eb"/);
});
