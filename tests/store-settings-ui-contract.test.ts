import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const page = read("app/(protected)/admin/settings/store/page.tsx");
const route = read("app/api/admin/store-settings/route.ts");
const posPanel = read("components/StorePosShadowPanel.tsx");
const dateRow = page.slice(
  page.indexOf("function DateSummaryRow"),
  page.indexOf("function SettingCard")
);

test("store settings keeps its bilingual tabs and existing save contracts", () => {
  assert.match(page, /tabs: \{ hours: "운영시간", attendance: "근태설정", shadow: "근태비교" \}/);
  assert.match(page, /hours: "Giờ mở cửa"/);
  assert.match(page, /attendance: "Chấm công"/);
  assert.match(page, /shadow: "So sánh"/);
  assert.match(page, /lateGraceMinutes: lateGrace/);
  assert.match(page, /earlyLeaveGraceMinutes: earlyLeaveGrace/);
  assert.match(page, /missingCheckoutGraceMinutes: missingCheckoutGrace/);
  assert.match(route, /ATTENDANCE_SETTINGS_DB_PENDING/);
});

test("both setting tabs still confirm the unified schedule before saving", () => {
  assert.match(page, /function requestSave\(\)/);
  assert.match(page, /setConfirmOpen\(true\)/);
  assert.match(page, /onSave=\{requestSave\}/g);
  assert.doesNotMatch(page, /onSave=\{save\}/);
  assert.match(page, /role="dialog"/);
  assert.match(page, /aria-modal="true"/);
  assert.match(page, /onConfirm=\{save\}/);
});

test("current hours metadata stays 2-by-2 and renders a numeric revision without a hash", () => {
  assert.match(page, /currentMetaGrid: \{[\s\S]*?gridTemplateColumns: "repeat\(2, minmax\(0, 1fr\)\)"/);
  assert.match(page, /<CompactMetric label=\{t\.metaRevision\} value=\{String\(props\.setting\.revision\)\} \/>/);
  assert.doesNotMatch(page, /value=\{`#\$\{props\.setting\.revision\}`\}/);
  assert.match(page, /metaRevision: "변경번호"/);
  assert.match(page, /metaRevision: "Lần thay đổi"/);
});

test("current attendance metadata also renders its revision as digits", () => {
  const attendance = page.slice(
    page.indexOf("function AttendanceTab"),
    page.indexOf("function AttendanceScheduledBody")
  );
  assert.match(attendance, /label=\{t\.metaRevision\} value=\{currentSetting \? String\(currentSetting\.revision\) : "-"\}/);
  assert.doesNotMatch(attendance, /`#\$\{currentSetting\.revision\}`/);
});

test("date summary header has only the title, business-day count, and mismatch total", () => {
  assert.match(page, /style=\{styles\.dateSummaryHeader\}[\s\S]{0,180}result\.businessDayCount/);
  assert.match(page, /dateSummaryHeader: \{[\s\S]*?flexWrap: "wrap"[\s\S]*?gap: "4px 14px"/);
  assert.match(page, /dateSummaryTitle: \{ flexShrink: 0 \}/);
  const header = page.slice(
    page.indexOf("<span style={styles.dateSummaryHeader}>"),
    page.indexOf("</span>", page.indexOf("<span style={styles.dateSummaryHeader}>"))
  );
  assert.doesNotMatch(header, /verification|excluded|검증|제외/);
});

test("collapsed date rows show short dates, revision badges, compared and mismatched only", () => {
  assert.match(dateRow, /\{shortDate\(day\.businessDate\)\}/);
  assert.match(dateRow, /`#\$\{day\.settingsRevision\}`/);
  assert.match(dateRow, /\{t\.comparisonShort\} \{day\.compared\} · \{t\.mismatched\} \{day\.mismatched\}/);
  const button = dateRow.slice(dateRow.indexOf("<button"), dateRow.indexOf("</button>"));
  assert.doesNotMatch(button, /verification|excluded|검증|제외|day\.matched|day\.totalRecords/);
  assert.match(page, /dateKey\.length === 10 \? dateKey\.slice\(2\) : dateKey/);
});

test("standalone mismatch and excluded sections and their state/filter are removed", () => {
  assert.doesNotMatch(page, /showMismatches|showExcluded|differenceFilter|setDifferenceFilter/);
  assert.doesNotMatch(page, /attendance-shadow-mismatches|attendance-shadow-verification-excluded/);
  assert.doesNotMatch(page, /<ShadowRow|function ShadowRow/);
  assert.doesNotMatch(page, /<div style=\{styles\.filterRow\}>/);
});

test("date details derive mismatch employees from the requested row conditions", () => {
  assert.match(dateRow, /row\.businessDate === day\.businessDate/);
  assert.match(dateRow, /row\.comparisonStatus === "compared"/);
  assert.match(dateRow, /Object\.values\(row\.differences\)\.some\(Boolean\)/);
  assert.match(dateRow, /row\.configured\.lateMinutes > 0[\s\S]*row\.configured\.earlyLeaveMinutes > 0[\s\S]*row\.configured\.unresolved/);
  assert.match(dateRow, /outcomes\.join\(" · "\)/);
  assert.match(dateRow, /<strong>\{row\.userName\}<\/strong>/);
  assert.match(dateRow, /mismatchRows\.length \? \(/);
});

test("date details show one compact attendance-policy line without duplicate counts or hours", () => {
  const details = dateRow.slice(dateRow.indexOf("<div id={detailsId}"));
  assert.match(details, /styles\.datePolicyLine[\s\S]{0,220}\{t\.late\}[\s\S]{0,220}\{t\.early\}[\s\S]{0,220}\{t\.unresolved\}/);
  assert.doesNotMatch(details, /day\.storeOpenTime|day\.storeCloseTime|day\.businessDayCutoffTime/);
  assert.doesNotMatch(details, /day\.compared|day\.mismatched|day\.matched|day\.totalRecords/);
  assert.doesNotMatch(details, /displayExcluded|excludedReasonText/);
});

test("verification-needed rows merge no-check-in and manual-late reasons and hide leave", () => {
  assert.match(dateRow, /row\.exclusionReason !== "leave"/);
  assert.match(dateRow, /row\.comparisonStatus === "excluded" &&\s*row\.exclusionReason === "no_check_in"/);
  assert.match(dateRow, /row\.metricComparison\.late\.comparisonStatus === "excluded"/);
  assert.match(dateRow, /reasons\.join\(" · "\)/);
  assert.match(dateRow, /verificationRows\.length \? \(/);
  assert.doesNotMatch(dateRow, /verificationNeeded\} 0|excludedRows|검증 제외/);
});

test("special early close remains a conditional badge only", () => {
  assert.match(dateRow, /day\.hasBusinessOverride \? <span style=\{styles\.specialCloseBadge\}>\{t\.specialCloseApplied\}<\/span> : null/);
  assert.doesNotMatch(page, /specialCloseInput|saveSpecialClose|cancelSpecialClose/);
});

test("date-detail labels are complete in Korean and Vietnamese", () => {
  assert.match(page, /comparisonShort: "비교"/);
  assert.match(page, /verificationNeeded: "검증 필요"/);
  assert.match(page, /verificationNoCheckIn: "출근 기록 없음"/);
  assert.match(page, /verificationManualLate: "수동 지각 정상처리"/);
  assert.match(page, /specialCloseApplied: "특별 조기마감 적용"/);
  assert.match(page, /comparisonShort: "So sánh"/);
  assert.match(page, /mismatched: "Không khớp"/);
  assert.match(page, /late: "Đi muộn"/);
  assert.match(page, /early: "Về sớm"/);
  assert.match(page, /unresolved: "Chưa chấm công ra"/);
  assert.match(page, /verificationNeeded: "Cần kiểm tra"/);
  assert.match(page, /verificationNoCheckIn: "Không có ghi nhận chấm công vào"/);
  assert.match(page, /verificationManualLate: "Đi muộn đã được xử lý thủ công"/);
  assert.match(page, /specialCloseApplied: "Áp dụng giờ đóng cửa sớm đặc biệt"/);
});

test("date details never render raw status booleans", () => {
  assert.doesNotMatch(dateRow, /\.status\}|String\([^)]*\.unresolved\)|\{row\.configured\.unresolved\}/);
});

test("attendance policy descriptions remain short bilingual labeled lines", () => {
  assert.match(page, /lateHelp: "예정 출근시간 \+ 설정값 이후 출근"/);
  assert.match(page, /earlyLeaveHelp: "기준 퇴근시간보다 설정값 이상 일찍 퇴근하면 조퇴"/);
  assert.match(page, /missingCheckoutHelp: "기준 퇴근시간 \+ 설정값까지 퇴근 기록 없음"/);
  assert.match(page, /lateHelp: "Chấm công vào sau giờ vào dự kiến \+ giá trị cài đặt"/);
  assert.match(page, /aria-expanded=\{showPolicyDescription\}/);
});

test("POS compare remains feature-flagged off", () => {
  assert.match(page, /const SHOW_POS_INTEGRATION_COMPARE = false/);
  assert.match(page, /\{SHOW_POS_INTEGRATION_COMPARE \? <StorePosShadowGate \/> : null\}/);
  assert.match(posPanel, /StorePosShadowGate/);
});
