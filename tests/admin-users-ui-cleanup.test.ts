import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { scheduledMinutesPerDay } from "../lib/payroll/work-schedule.ts";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const page = read("app/(protected)/admin/users/page.tsx");
const text = read("lib/text/admin-users.ts");

test("A: total hours use the payroll schedule rule (midnight wrap, no break) and minutes are kept", () => {
  assert.equal(scheduledMinutesPerDay("16:00", "01:00", 0), 540);
  assert.equal(scheduledMinutesPerDay("17:30", "01:00", 0), 450);
  assert.equal(scheduledMinutesPerDay("09:00", "18:00", 0), 540);
  assert.equal(scheduledMinutesPerDay("10:00", "10:00", 0), null, "same start/end → no total");
  assert.match(page, /const minutes = scheduledMinutesPerDay\(user\.work_start_time\.slice\(0, 5\), user\.work_end_time\.slice\(0, 5\), 0\);/);
  assert.match(page, /if \(!user\.work_start_time \|\| !user\.work_end_time\) return "";/);
  assert.match(page, /hours \? `\$\{hours\}\$\{text\.durationHours\}` : "", rest \? `\$\{rest\}\$\{text\.durationMinutes\}` : ""/);
  assert.match(text, /durationHours: "시간",\n\s+durationMinutes: "분",/);
  assert.match(text, /durationHours: " giờ",\n\s+durationMinutes: " phút",/);
  // shown only next to an existing work time (owner/master/terminated rules unchanged)
  assert.match(page, /const workDuration = workTime \? workDurationLabel\(user, text\) : "";/);
});

test("B: detail cards carry an emoji header and a light tint; inputs stay white", () => {
  for (const [tone, emoji, label] of [["basic", "🪪", "basicInfo"], ["workPay", "⏰", "workPayInfo"], ["level", "📈", "longTermLevel"], ["appAccess", "🔐", "appAccess"]]) {
    assert.ok(page.includes(`<section style={sectionStyle("${tone}")}>`), tone);
    assert.ok(page.includes(`<SectionTitle emoji="${emoji}">{text.${label}}</SectionTitle>`), label);
  }
  assert.ok(page.includes('<SectionTitle emoji="💳">{text.payrollBenefits}</SectionTitle>'));
  assert.ok(page.includes('<summary style={styles.advancedSummary}><span aria-hidden="true">🛠️</span> {text.advancedSettings}</summary>'));
  assert.match(page, /\.\.\.ui\.input,\n\s+\/\/[^\n]*\n\s+background: "#fff",/);
  assert.match(page, /payroll: \{ background: "#fffbeb", borderColor: "#fef3c7" \}/);
});

test("C: the work·pay card no longer has its own 급여설정 shortcut; the payroll sheet keeps one", () => {
  const status = page.slice(page.indexOf("function PayrollContractStatus("), page.indexOf("// 직원 상세 카드별 은은한 배경색"));
  assert.doesNotMatch(status, /managePayrollSettings|onOpenPayrollSettings|payrollLinkButton/);
  assert.match(status, /text\.payrollContractMismatch/);
  assert.match(status, /text\.payrollContractCurrent/);
  const sheetSection = page.slice(page.indexOf("function PayrollBenefitsSection("), page.indexOf("function Toggle("));
  assert.match(sheetSection, /onClick=\{onOpenPayrollSettings\}>\{text\.managePayrollSettings\} →<\/button>/);
});

test("D: payroll·benefits opens a dedicated sheet; closing goes through the unsaved-input guard; nested dialogs keep Escape", () => {
  assert.match(page, /onOpen=\{\(\) => payroll\.setOpen\(user\.id, true\)\}\n\s+onClose=\{\(\) => payroll\.setOpen\(user\.id, false\)\}/);
  const sheet = page.slice(page.indexOf("function PayrollSheet("), page.indexOf("function PayrollBenefitsSection("));
  assert.match(sheet, /role="dialog" aria-modal="true" aria-labelledby=\{titleId\}/);
  // 안쪽 계약 창·레벨 설정 dialog가 열려 있으면 시트는 Escape를 무시한다(최상단 모달 판정은 useModalFocusTrap).
  assert.match(sheet, /if \(!isTopModal\(sheetRef\.current\)\) return;/);
  assert.match(sheet, /if \(event\.target === event\.currentTarget\) onClose\(\);/);
  assert.match(sheet, /document\.body\.style\.overflow = previousOverflow;/);
  assert.match(page, /aria-haspopup="dialog" aria-expanded=\{open\}/);
});
