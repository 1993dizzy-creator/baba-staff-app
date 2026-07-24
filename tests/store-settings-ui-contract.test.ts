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
  assert.match(page, /🗓️ 설정 예약/);
  assert.match(page, /🧾 변경 기록/);
  assert.match(page, /weekdayColor\(hour\.weekday\)/);
  assert.match(page, /lateGraceMinutes: lateGrace/);
  assert.match(page, /defaultNormalCheckoutTime: normalCheckout/);
  assert.match(page, /lateGrace > 180/);
  assert.match(page, /Number\.isInteger\(lateGrace\)/);
  assert.match(page, /근태설정 DB 적용 전입니다/);
  assert.match(page, /comparisonTitle: "📊 근태 기준 비교"/);
  assert.match(page, /comparisonSummary: "📈 비교 요약"/);
  assert.match(page, /result\.rows[\s\S]*Object\.values\(row\.differences\)/);
  assert.match(route, /ATTENDANCE_SETTINGS_DB_PENDING/);
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
