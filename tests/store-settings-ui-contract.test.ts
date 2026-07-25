import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) =>
  readFileSync(join(process.cwd(), path), "utf8");
const page = read("app/(protected)/admin/settings/store/page.tsx");
const route = read("app/api/admin/store-settings/route.ts");
const posPanel = read("components/StorePosShadowPanel.tsx");

test("store settings opens directly on the three bilingual emoji tabs", () => {
  assert.doesNotMatch(page, /<header style=\{styles\.header\}>/);
  assert.doesNotMatch(page, /<span style=\{styles\.badge\}>STORE/);
  assert.match(page, /🏪 운영시간/);
  assert.match(page, /⏱️ 근태설정/);
  assert.match(page, /📊 근태비교/);
  assert.match(page, /🏪 Giờ hoạt động/);
  assert.match(page, /⏱️ Cài đặt chấm công/);
  assert.match(page, /📊 So sánh chấm công/);
  assert.match(page, /background: "#111827"/);
  assert.match(page, /whiteSpace: "nowrap"/);
});

test("hours, attendance, and shadow tabs retain their operator contracts", () => {
  assert.match(page, /🏪 현재 매장 운영시간/);
  assert.match(page, /🗓️ 운영시간 변경/);
  assert.match(page, /🧾 변경 기록/);
  assert.match(page, /weekdayColor\(hour\.weekday\)/);
  assert.match(page, /lateGraceMinutes: lateGrace/);
  assert.match(page, /earlyLeaveGraceMinutes: earlyLeaveGrace/);
  assert.match(page, /missingCheckoutGraceMinutes: missingCheckoutGrace/);
  assert.match(page, /lateGrace > 180/);
  assert.match(page, /Number\.isInteger\(lateGrace\)/);
  assert.match(page, /근태설정 DB 적용 전입니다/);
  assert.match(page, /comparisonTitle: "📊 근태 기준 비교"/);
  assert.match(page, /comparisonSummary: "📈 비교 요약"/);
  assert.match(page, /result\.rows[\s\S]*Object\.values\(row\.differences\)/);
  assert.match(route, /ATTENDANCE_SETTINGS_DB_PENDING/);
});

test("hours tab and attendance tab no longer share the same card header/emoji", () => {
  assert.match(page, /attendancePolicyTitle: "⏰ 지각·퇴근 판정 기준"/);
  assert.match(page, /attendancePolicyTitle: "⏰ Tiêu chuẩn đi muộn và tan ca"/);
  assert.doesNotMatch(page, /⚙️ \{t\.current\}/);
  assert.doesNotMatch(page, /✏️ \{t\.newSetting\}/);
});

test("attendance tab exposes late, early-leave, and missing-checkout grace cards", () => {
  assert.match(page, /lateGrace: "지각 기준"/);
  assert.match(page, /earlyLeaveGrace: "조퇴 기준"/);
  assert.match(page, /missingCheckoutGrace: "미퇴근 기준"/);
  assert.match(page, /lateGrace: "Tiêu chuẩn đi muộn"/);
  assert.match(page, /earlyLeaveGrace: "Tiêu chuẩn về sớm"/);
  assert.match(page, /missingCheckoutGrace: "Tiêu chuẩn thiếu chấm công ra"/);
  assert.doesNotMatch(page, /normalCheckout: /);
});

test("deprecated defaultNormalCheckoutTime is preserved on save, never overwritten with a fixed constant", () => {
  assert.match(
    page,
    /defaultNormalCheckoutTime:\s*\n\s*data\.overview\.current\?\.attendancePolicy[\s\S]{0,20}\?\.defaultNormalCheckoutTime \?\?\s*\n\s*DEFAULT_STORE_ATTENDANCE_POLICY\.defaultNormalCheckoutTime,/
  );
});

test("POS compare UI is feature-flagged off while reusable code remains", () => {
  assert.match(page, /const SHOW_POS_INTEGRATION_COMPARE = false/);
  assert.match(
    page,
    /\{SHOW_POS_INTEGRATION_COMPARE \? <StorePosShadowGate \/> : null\}/
  );
  assert.match(posPanel, /StorePosShadowGate/);
  assert.match(posPanel, /StorePosShadowPanel/);
  assert.match(
    read("app/api/admin/store-settings/pos-shadow/route.ts"),
    /export async function/
  );
});
