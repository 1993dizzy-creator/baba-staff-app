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

test("B: detail cards carry an emoji header and a light tint; inputs stay white (3 top cards since the 2026-11 restructure)", () => {
  // 4차: 기본정보·근무·급여 are collapsible cards (same tint + emoji header); 앱 접근 stays a plain card
  for (const [tone, emoji, label] of [["basic", "🪪", "basicInfo"], ["workPay", "⏰", "workPayInfo"]]) {
    assert.ok(page.includes(`<CollapsibleSection tone="${tone}" emoji="${emoji}" title={text.${label}}`), label);
  }
  assert.ok(page.includes('<section style={sectionStyle("appAccess")}>'));
  assert.ok(page.includes('<SectionTitle emoji="🔐">{text.appAccess}</SectionTitle>'));
  assert.match(page, /return <section style=\{sectionStyle\(tone\)\}>\n\s+<button type="button" aria-expanded=\{open\} aria-controls=\{open \? bodyId : undefined\} onClick=\{onToggle\} style=\{styles\.sectionToggle\}>\n\s+<SectionTitle emoji=\{emoji\}>\{title\}<\/SectionTitle>/);
  // contract and benefits are subsections of work·pay, not top cards
  assert.ok(page.includes('<SubsectionTitle emoji="💰">{text.payrollContract}</SubsectionTitle>'));
  assert.ok(page.includes('<SubsectionTitle emoji="🎁">{text.benefits}</SubsectionTitle>'));
  assert.doesNotMatch(page, /sectionStyle\("(level|payroll|advanced)"\)/);
  assert.match(page, /\.\.\.ui\.input,\n\s+\/\/[^\n]*\n\s+background: "#fff",/);
});

test("C: neither the work·pay card nor the payroll sheet has a 급여설정 shortcut; the sheet footer is 닫기 only", () => {
  const status = page.slice(page.indexOf("function PayrollContractStatus("), page.indexOf("// 직원 상세 카드별 은은한 배경색"));
  assert.doesNotMatch(status, /managePayrollSettings|onOpenPayrollSettings|payrollLinkButton/);
  // 5차: the contract summary no longer carries the attendance mismatch notice (it moved under the attendance switch).
  assert.doesNotMatch(status, /payrollContractMismatch|attendanceOffRequiresFixedMonthly/);
  assert.match(status, /text\.payrollContract\}/);
  const sheetSection = page.slice(page.indexOf("function PayrollSettingSheet("), page.indexOf("function Toggle("));
  assert.doesNotMatch(sheetSection, /managePayrollSettings|onOpenPayrollSettings/);
  assert.match(sheetSection, /footer=\{<button type="button" style=\{styles\.secondaryButton\} onClick=\{onClose\}>\{text\.close\}<\/button>\}/);
  assert.match(page, /sheetFooter: \{ display: "grid", gridTemplateColumns: "minmax\(0, 1fr\)",/);
});

test("D (4차): contract and each benefit open their own sheet; closing goes through the unsaved-input guard; nested dialogs keep Escape", () => {
  assert.match(page, /onClose=\{\(\) => \{ payroll\.setOpen\(user\.id, false\); \}\}/);
  // a finished setting form (saved or cancelled) closes without asking — nothing is left to lose
  assert.match(page, /finish: \(id\) => \{\n\s+const key = String\(id\);\n\s+setPayrollSheet\(\(current\) => \(current\?\.userId === key \? null : current\)\);/);
  const sheet = page.slice(page.indexOf("function PayrollSheet("), page.indexOf("const SHEET_TITLES"));
  assert.match(sheet, /role="dialog" aria-modal="true" aria-labelledby=\{titleId\}/);
  assert.match(sheet, /if \(!isTopModal\(sheetRef\.current\)\) return;/);
  assert.match(sheet, /if \(event\.target === event\.currentTarget\) onClose\(\);/);
  assert.match(sheet, /document\.body\.style\.overflow = previousOverflow;/);
});
