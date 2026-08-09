import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const page = readFileSync(join(process.cwd(), "app/(protected)/attendance/leave/page.tsx"), "utf8");
const birthdayBlock = page.slice(page.indexOf("const birthdayUsersByDate = useMemo"), page.indexOf("const staffSummaryGroups"));
const cellBlock = page.slice(page.indexOf("const isHoliday = holidayByDate.has"), page.indexOf("</button>\n              );\n            })}"));

test("the top total/pending/approved cards and their dedicated calculation/component/styles are removed", () => {
  assert.doesNotMatch(page, /<SummaryCard|function SummaryCard|summaryCardsStyle|summaryCardStyle|summaryCardLabelStyle|summaryCardValueStyle/);
  assert.doesNotMatch(page, /copy\.total|copy\.pending|copy\.approved|const summary = useMemo/);
  assert.doesNotMatch(page, /total: "전체 신청"|pending: "승인 대기"|approved: "승인 완료"/);
  assert.doesNotMatch(page, /total: "Tổng số đơn"|pending: "Chờ duyệt"|approved: "Đã duyệt"/);
  assert.match(page, /const staffSummaryGroups = useMemo/);
  assert.match(page, /const leaveCountByDate = useMemo/);
});

test("the calendar card starts without a monthly-calendar section title", () => {
  assert.doesNotMatch(page, /<SectionTitle title=\{t\.monthCalendar\} \/>/);
  assert.match(page, /\{feedback\.message\}[\s\S]*?<\/div>[\s\S]*?\)\}[\s\S]*?<div style=\{cardStyle\}>/);
  assert.match(page, /<SectionTitle title=\{t\.staffSummary\} \/>/);
});

test("birthday dates require non-owner/master, attendance tracking, non-system status, and employment on the exact birthday", () => {
  assert.match(birthdayBlock, /isOwnerOrMasterRole\(user\.role\)/);
  assert.match(birthdayBlock, /!isAttendanceTrackingUser\(user\)/);
  assert.match(birthdayBlock, /!user\.birthdayMonthDay/);
  assert.match(birthdayBlock, /!isDateKey\(birthdayDate\) \|\| !isEmployedOn\(user, birthdayDate\)/);
  assert.match(page, /attendance_tracking_enabled: boolean;/);
  assert.match(page, /is_system_account: boolean;/);
});

test("birthday month/day maps to the viewed calendar year and invalid dates such as non-leap Feb 29 are not shifted", () => {
  assert.match(birthdayBlock, /const calendarYear = calendarDate\.getFullYear\(\);/);
  assert.match(birthdayBlock, /const birthdayDate = `\$\{calendarYear\}-\$\{user\.birthdayMonthDay\}`;/);
  assert.match(birthdayBlock, /isDateKey\(birthdayDate\)/);
  assert.doesNotMatch(birthdayBlock, /setUTCDate|setDate|Date\.UTC/);
});

test("calendar renders one cake marker by date and ordinary dates have none", () => {
  assert.match(cellBlock, /const hasBirthday = birthdayUsersByDate\.has\(cell\.dateKey \|\| ""\);/);
  assert.match(cellBlock, /\{hasBirthday && \(\s*<span style=\{birthdayMarkerStyle\} aria-hidden="true">🎂<\/span>/);
  assert.equal((cellBlock.match(/🎂/g) ?? []).length, 1);
});

test("2X, birthday, and leave-count badges are independent siblings so all may coexist", () => {
  assert.match(cellBlock, /\{isHoliday && \([\s\S]*?2X[\s\S]*?\)\}/);
  assert.match(cellBlock, /\{hasBirthday && \([\s\S]*?🎂[\s\S]*?\)\}/);
  assert.match(cellBlock, /\{\(hasApproved \|\| hasPending\) && \(/);
  const birthdayRender = cellBlock.slice(cellBlock.indexOf("{hasBirthday && ("), cellBlock.indexOf("{(hasApproved || hasPending) && ("));
  assert.doesNotMatch(birthdayRender, /isHoliday|hasApproved|hasPending/);
});

test("birthday marker is absolutely positioned outside the date/count layout flow", () => {
  assert.match(page, /const calendarCellStyle: CSSProperties = \{\s*\n\s*position: "relative",/);
  assert.match(page, /const birthdayMarkerStyle: CSSProperties = \{\s*\n\s*position: "absolute",\s*\n\s*top: 2,\s*\n\s*right: 2,/);
  const dateSpan = cellBlock.slice(cellBlock.indexOf("<span>"), cellBlock.indexOf("{(hasApproved || hasPending) && ("));
  assert.doesNotMatch(dateSpan, /birthdayMarkerStyle|🎂/);
});

test("the shared birthday map retains all eligible users for selected-date names", () => {
  assert.match(birthdayBlock, /const usersByDate = new Map<string, UserRow\[\]>\(\);/);
  assert.match(birthdayBlock, /const birthdayUsers = usersByDate\.get\(birthdayDate\) \?\? \[\];/);
  assert.match(birthdayBlock, /birthdayUsers\.push\(user\);/);
  assert.match(page, /const selectedBirthdayUsers = birthdayUsersByDate\.get\(selectedDate\) \?\? \[\];/);
  assert.match(page, /selectedBirthdayUsers\.map\(\(user\) => user\.name\)\.join\(", "\)/);
});

test("selected-date display uses MM-DD only while all internal selectedDate lookups keep YYYY-MM-DD", () => {
  assert.match(page, /\{copy\.selectedDate\} · \{selectedDate\.slice\(5\)\}/);
  assert.match(page, /birthdayUsersByDate\.get\(selectedDate\)/);
  assert.match(page, /holidayByDate\.get\(selectedDate\)/);
  assert.doesNotMatch(page, /setSelectedDate\(selectedDate\.slice/);
});

test("selected header can show holiday and one or multiple birthday names in the same wrapping indicator group", () => {
  const header = page.slice(page.indexOf("<div style={selectedDateHeaderStyle}>"), page.indexOf("{isInitialLoading ? ("));
  assert.match(header, /selectedHoliday \|\| selectedBirthdayUsers\.length > 0/);
  assert.match(header, /selectedHoliday && selectedBirthdayUsers\.length > 0 \? <span>·<\/span> : null/);
  assert.match(header, /🎂 \{selectedBirthdayUsers\.map\(\(user\) => user\.name\)\.join\(", "\)\}/);
  assert.match(page, /const selectedDateIndicatorsStyle: CSSProperties = \{[\s\S]*?flexWrap: "wrap"/);
});
