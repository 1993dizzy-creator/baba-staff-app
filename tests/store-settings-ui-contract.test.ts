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

test("hours tab and attendance tab save buttons both read the unified schedule label", () => {
  assert.match(page, /save: "통합설정 예약"/);
  assert.match(page, /saveAttendance: "통합설정 예약"/);
  assert.match(page, /save: "Lên lịch cài đặt chung"/);
  assert.match(page, /saveAttendance: "Lên lịch cài đặt chung"/);
  // state and copy keys stay separate even though the text now matches.
  assert.match(page, /onLateGrace: \(value: number\) => void;/);
  assert.match(page, /earlyLeaveGrace: number;\s*\n\s*missingCheckoutGrace: number;/);
});

test("both tabs open a confirmation dialog before saving instead of calling the API directly", () => {
  assert.match(page, /function requestSave\(\)/);
  assert.match(page, /setConfirmOpen\(true\)/);
  assert.match(page, /onSave=\{requestSave\}/g);
  assert.doesNotMatch(page, /onSave=\{save\}/);
  assert.match(page, /function ConfirmScheduleModal/);
  assert.match(page, /role="dialog"/);
  assert.match(page, /aria-modal="true"/);
  assert.match(page, /confirmScheduleTitle: "통합설정을 예약할까요\?"/);
  assert.match(page, /confirmScheduleTitle: "Bạn có muốn lên lịch cài đặt chung không\?"/);
  assert.match(page, /modalCancel: "취소"/);
  assert.match(page, /modalConfirm: "예약하기"/);
  assert.match(page, /onConfirm=\{save\}/);
  assert.match(page, /onCancel=\{\(\) => setConfirmOpen\(false\)\}/);
  // cancelling never calls the save API; only the modal's confirm button does.
  assert.match(page, /disabled=\{props\.busy\}\s*\n\s*onClick=\{props\.onCancel\}/);
});

test("the confirm modal is fed the current hours and attendance values regardless of which tab opened it", () => {
  assert.match(page, /<ConfirmScheduleModal[\s\S]{0,300}hours=\{hours\}/);
  assert.match(page, /<ConfirmScheduleModal[\s\S]{0,300}lateGrace=\{lateGrace\}/);
  assert.match(page, /<ConfirmScheduleModal[\s\S]{0,300}earlyLeaveGrace=\{earlyLeaveGrace\}/);
  assert.match(page, /<ConfirmScheduleModal[\s\S]{0,300}missingCheckoutGrace=\{missingCheckoutGrace\}/);
  assert.match(page, /groupStoreHours\(props\.hours\)/);
});

test("the mismatch filter row keeps the warning label on one line and lets the select shrink", () => {
  assert.match(page, /filterRow: \{[\s\S]*?gridTemplateColumns: "auto minmax\(0, 1fr\)"/);
  assert.match(page, /filterLabel: \{[\s\S]*?whiteSpace: "nowrap"/);
  assert.match(page, /filterLabel: \{[\s\S]*?flexShrink: 0/);
  assert.match(page, /<div style=\{styles\.filterRow\}>/);
  assert.match(page, /<h2 style=\{styles\.filterLabel\}>/);
});

test("early leave grace accepts up to 180 minutes, so 90 is a valid input", () => {
  assert.match(
    page,
    /t\.earlyLeaveGrace[\s\S]{0,300}max=\{180\}[\s\S]{0,150}value=\{props\.earlyLeaveGrace\}/
  );
  assert.match(page, /earlyLeaveGrace < 0 \|\|\s*\n\s*earlyLeaveGrace > 180/);
});

test("mismatch cards show a specific change-type badge and label statuses for people, not raw codes", () => {
  assert.match(page, /changeTypeLate: "지각 판정 변경"/);
  assert.match(page, /changeTypeEarly: "조퇴 판정 변경"/);
  assert.match(page, /changeTypeUnresolved: "미퇴근 판정 변경"/);
  assert.match(page, /changeTypeStatus: "상태 판정 변경"/);
  assert.match(page, /changeTypeMultiple: "복수 판정 변경"/);
  assert.match(page, /changeTypeLate: "Thay đổi đánh giá đi muộn"/);
  assert.match(page, /changeTypeEarly: "Thay đổi đánh giá về sớm"/);
  assert.match(page, /changeTypeUnresolved: "Thay đổi đánh giá thiếu chấm công ra"/);
  assert.match(page, /changeTypeStatus: "Thay đổi trạng thái"/);
  assert.match(page, /changeTypeMultiple: "Thay đổi nhiều tiêu chí"/);
  assert.match(page, /changeTypeBadgeLabel\(props\.lang, primary\)/);
  assert.match(page, /statusLabels: \{[\s\S]*?done: "정상 완료"/);
  assert.match(page, /statusLabels: \{[\s\S]*?working: "근무 중"/);
});

test("developer-verification detail stays collapsed by default and preserves the old raw fields", () => {
  assert.match(page, /showDetails: "상세 보기"/);
  assert.match(page, /hideDetails: "상세 닫기"/);
  assert.match(page, /const \[showDetails, setShowDetails\] = useState\(false\)/);
  assert.match(page, /\{showDetails \? t\.hideDetails : t\.showDetails\}/);
  // the collapsible block still contains every field the old always-visible card had.
  assert.match(page, /\{showDetails \? \(\s*\n\s*<div style=\{styles\.comparisonGrid\}>/);
  assert.match(page, /t\.status\}: \{props\.row\.legacy\.status\}/);
  assert.match(page, /t\.status\}: \{props\.row\.configured\.status\}/);
  assert.match(page, /manualLateBadge/);
});

test("shadow card times are shown in Vietnam time via the shared formatter, never a raw ISO slice", () => {
  assert.doesNotMatch(page, /\.slice\(11,\s*16\)/);
  assert.match(page, /import \{ formatVietnamTime \} from "@\/lib\/common\/business-time"/);
  assert.match(page, /const hhmm = formatVietnamTime;/);
  // hhmm/formatVietnamTime never take a language argument, so Korean and
  // Vietnamese screens necessarily render the exact same clock time.
  assert.doesNotMatch(page, /hhmm\([^)]*lang/);
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
