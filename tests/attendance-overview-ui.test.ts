import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(
  new URL("../app/(protected)/admin/payroll/attendance/page.tsx", import.meta.url),
  "utf8"
);
const detailPage = readFileSync(
  new URL("../app/(protected)/admin/payroll/attendance/[userId]/page.tsx", import.meta.url),
  "utf8"
);
const text = readFileSync(new URL("../lib/text/attendance.ts", import.meta.url), "utf8");

test("overview keeps the single-row layout and always renders work and leave statistics", () => {
  assert.doesNotMatch(page, /<h1 style=\{pageTitleStyle\}/);
  assert.match(page, /gridTemplateColumns: "minmax\(0, 1fr\) auto 12px"/);
  assert.match(page, /<IconStat icon="📅"/);
  assert.match(page, /<IconStat icon="🌴"/);
});

test("late and early-leave statistics render only for positive counts", () => {
  assert.match(
    page,
    /summary\.lateCount > 0 && \([\s\S]*?<IconStat icon="⏰" label=\{t\.workLate\} value=\{summary\.lateCount\}/
  );
  assert.match(
    page,
    /summary\.earlyLeaveCount > 0 && \([\s\S]*?<IconStat icon="🏃" label=\{t\.workEarlyLeave\} value=\{summary\.earlyLeaveCount\}/
  );
  assert.doesNotMatch(page, /summary\.(?:lateCount|earlyLeaveCount) >= 0/);
});

test("zero anomalies show two stats and both positive anomalies show four", () => {
  const alwaysVisibleCount = (page.match(/<IconStat icon="(?:📅|🌴)"/g) || []).length;
  const conditionalCount = (page.match(/<IconStat icon="(?:⏰|🏃)"/g) || []).length;
  assert.equal(alwaysVisibleCount, 2);
  assert.equal(conditionalCount, 2);
  assert.equal(alwaysVisibleCount + conditionalCount, 4);
});

test("statistics use icon-number spacing without separator dots", () => {
  assert.match(page, /const staffStatsStyle[\s\S]*?gap: 5/);
  assert.doesNotMatch(page, /staffStatsStyle[\s\S]*?[>}]·[<{]/);
});

test("mobile identity and seven-day rows keep shrink and overflow guards", () => {
  assert.equal(
    page.match(/gridTemplateColumns: "repeat\(7, minmax\(0, 1fr\)\)"/g)?.length,
    2
  );
  assert.match(page, /const staffLeftStyle[\s\S]*?minWidth: 0,[\s\S]*?overflow: "hidden"/);
  assert.match(page, /const staffNameStyle[\s\S]*?textOverflow: "ellipsis"/);
  assert.match(page, /const staffMetaStyle[\s\S]*?textOverflow: "ellipsis"/);
});

test("recent weekdays are separate, ordered by date, and use calendar weekend colors", () => {
  assert.match(page, /key=\{`weekday-\$\{dateKey\}`\}/);
  assert.match(page, /weekdayIndex === 0[\s\S]*?"#dc2626"/);
  assert.match(page, /weekdayIndex === 6[\s\S]*?"#2563eb"/);
  assert.match(page, /\{Number\(dateKey\.slice\(-2\)\)\}/);
  assert.doesNotMatch(page, /calendarWeekdays\[getDateKeyWeekdayIndex\(dateKey\)\].*Number/);
});

test("employee detail removes the duplicate attendance back link", () => {
  assert.doesNotMatch(detailPage, /backToAttendance|backLinkStyle|<Link/);
  assert.match(detailPage, /const headerCardStyle[\s\S]*?marginTop: 8/);
});

test("recent attendance title is available in Korean and Vietnamese", () => {
  assert.match(text, /recent7Days: "최근 7일"/);
  assert.match(text, /recent7Days: "7 ngày gần đây"/);
});
