import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const page = read("app/(protected)/admin/settings/store/page.tsx");
const route = read("app/api/admin/store-settings/route.ts");

test("store settings has hours/attendance/holidays tabs — the attendance comparison (shadow) tab is removed and never reintroduced", () => {
  assert.match(page, /type Tab = "hours" \| "attendance" \| "holidays"/);
  assert.match(page, /tabs: \{ hours: "운영시간", attendance: "근태설정", holidays: "공휴일" \}/);
  assert.match(page, /hours: "Giờ mở cửa"/);
  assert.match(page, /attendance: "Chấm công"/);
  assert.match(page, /holidays: "Ngày lễ"/);
  assert.doesNotMatch(page, /근태비교/);
  assert.doesNotMatch(page, /So sánh/);
  assert.doesNotMatch(
    page,
    /ShadowTab|DateSummaryRow|AttendanceShadow|shadow-period|shadow-settings|attendance-shadow/
  );
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

test("attendance policy descriptions remain short bilingual labeled lines", () => {
  assert.match(page, /lateHelp: "예정 출근시간 \+ 설정값 이후 출근"/);
  assert.match(page, /earlyLeaveHelp: "기준 퇴근시간보다 설정값 이상 일찍 퇴근하면 조퇴"/);
  assert.match(page, /missingCheckoutHelp: "기준 퇴근시간 \+ 설정값까지 퇴근 기록 없음"/);
  assert.match(page, /lateHelp: "Chấm công vào sau giờ vào dự kiến \+ giá trị cài đặt"/);
  assert.match(page, /aria-expanded=\{showPolicyDescription\}/);
});

test("POS Shadow no longer exists in the store settings page or its API capabilities", () => {
  assert.doesNotMatch(
    page,
    /StorePosShadowGate|StorePosShadowPanel|SHOW_POS_INTEGRATION_COMPARE|posShadow/
  );
  assert.doesNotMatch(route, /posShadow/);
  assert.match(route, /capabilities: \{ mutate: canMutateStoreSettings\(auth\.actor\), audit: canMutateStoreSettings\(auth\.actor\) \}/);
});
