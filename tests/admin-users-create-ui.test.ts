import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { adminUsersText } from "../lib/text/admin-users.ts";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const createPage = read("app/(protected)/admin/users/create/page.tsx");
const listPage = read("app/(protected)/admin/users/page.tsx");

// 2026-11 직원 생성 화면 리뉴얼: 직원 상세(/admin/users)의 리뉴얼 디자인과 같은 값·부품을 쓴다.
test("create page mirrors the employee detail section, switch and input styles exactly (no separate design system)", () => {
  const shared = [
    'detailSection: { display: "grid", gap: 8, padding: 10, border: "1px solid #e5e7eb", borderRadius: 9, minWidth: 0 },',
    'sectionTitle: { display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 800, color: "#111827" },',
    'sectionBody: { display: "grid", gap: 8, minWidth: 0 },',
    'switchControl: { flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 6 },',
    'switchText: { minWidth: 26, fontSize: 11, fontWeight: 900, textAlign: "right", color: "#374151" },',
    'switchTrack: { position: "relative", display: "inline-block", flexShrink: 0, width: 44, height: 24, borderRadius: 999, background: "#d1d5db", transition: "background-color 0.18s ease" },',
    'switchTrackOn: { background: "#16a34a" },',
    'switchKnob: { position: "absolute", top: 2, left: 2, width: 20, height: 20, borderRadius: 999, background: "#fff", boxShadow: "0 1px 3px rgba(0,0,0,.3)", transition: "transform 0.18s ease" },',
    'switchKnobOn: { transform: "translateX(20px)" },',
    'toggleLabel: { minWidth: 0, overflowWrap: "anywhere" },',
    'subsection: { display: "grid", gap: 8, paddingTop: 10, marginTop: 2, borderTop: "1px solid #bae6fd", minWidth: 0 },',
    'subsectionTitle: { display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 800, color: "#0f172a" },',
    'modalHint: { margin: "7px 0 0", fontSize: 11, color: "#6b7280", lineHeight: 1.5, overflowWrap: "anywhere" },',
    'basic: { background: "#f8fafc", borderColor: "#e2e8f0" },',
    'workPay: { background: "#f0f9ff", borderColor: "#e0f2fe" },',
    'appAccess: { background: "#f0fdf4", borderColor: "#dcfce7" },',
  ];
  for (const line of shared) {
    assert.ok(listPage.includes(line), `detail page still has: ${line}`);
    assert.ok(createPage.includes(line), `create page mirrors: ${line}`);
  }
  const toggleRow = listPage.match(/ {2}toggleRow: \{[^\n]*\},/)?.[0];
  assert.ok(toggleRow && createPage.includes(toggleRow), "toggle row style matches the detail page");
  const input = /input: \{\n {4}\.\.\.ui\.input,\n[^}]*background: "#fff",\n {4}padding: "7px 8px",\n {4}borderRadius: 7,\n {4}fontSize: 12,\n {4}minWidth: 0,\n {2}\},/;
  assert.match(listPage, input);
  assert.match(createPage, input);
});

test("create page uses sliding switches and shared 2-way choices instead of checkboxes, native radios and the purple level card", () => {
  assert.doesNotMatch(createPage, /type="checkbox"|type="radio"/);
  assert.doesNotMatch(createPage, /#faf5ff|#ddd6fe|#eef2ff|#4f46e5/);
  assert.match(createPage, /role="switch" aria-checked=\{checked\}/);
  assert.match(createPage, /from "@\/components\/payroll\/BenefitModalParts"/);
  assert.match(createPage, /<Toggle label=\{text\.attendanceTracking\} checked=\{form\.attendance_tracking_enabled\}/);
  // 앱 로그인 허용과 계정 활성은 별도 필드(합치지 않음)
  assert.match(createPage, /<Toggle label=\{text\.appLoginEnabled\} checked=\{form\.app_login_enabled\} onChange=\{\(value\) => update\("app_login_enabled", value\)\} \/>/);
  assert.match(createPage, /<Toggle label=\{text\.activeStatus\} checked=\{form\.is_active\} onChange=\{\(value\) => update\("is_active", value\)\} \/>/);
  const level = createPage.slice(createPage.indexOf('<SubsectionTitle emoji="📈">'), createPage.indexOf('<SubsectionTitle emoji="💰">'));
  assert.match(level, /<BenefitChoice\s+label=\{text\.levelParticipation\}\s+value=\{form\.level_program_enabled\}/);
  assert.match(level, /tone="neutral"\s+label=\{text\.levelBasisShort\}/);
});

test("create page keeps the create contract: same defaults, payload, client checks and API", () => {
  assert.match(createPage, /work_start_time: "16:00",\n {2}work_end_time: "01:00",\n {2}is_active: true,\n {2}level_program_enabled: true,\n {2}level_base_mode: "hire_month",\n {2}level_base_month: "",\n {2}attendance_tracking_enabled: true,\n {2}app_login_enabled: true,/);
  assert.match(createPage, /attendanceFetch\("\/api\/admin\/users\/create", \{\n\s+method: "POST",/);
  assert.match(createPage, /body: JSON\.stringify\(\{\n\s+lang,\n\s+\.\.\.form,\n\s+\}\),/);
  assert.match(createPage, /if \(!form\.username\.trim\(\) \|\| !form\.password\.trim\(\) \|\| !form\.name\.trim\(\)\)/);
  assert.match(createPage, /form\.attendance_tracking_enabled &&\s+\(!form\.work_start_time \|\| !form\.work_end_time\)/);
  assert.match(createPage, /if \(form\.level_program_enabled && !form\.hire_date\)/);
  assert.match(createPage, /level_program_enabled: role !== "owner"/);
});

test("create page sends one POST at a time, keeps input on failure and guards unsaved input", () => {
  const submit = createPage.slice(createPage.indexOf("async function submit()"), createPage.indexOf("if (checked && !canAccess)"));
  assert.match(submit, /if \(submitting\.current\) return;/);
  assert.match(submit, /submitting\.current = true;/);
  assert.match(submit, /finally \{\n\s+submitting\.current = false;/);
  // the form is reset only after a successful response
  assert.ok(submit.indexOf("setForm(initialForm)") > submit.indexOf("if (!res.ok || !result.ok)"));
  assert.ok(submit.indexOf("setForm(initialForm)") < submit.indexOf("} catch (error) {"));
  assert.match(submit, /res\.status === 409 \? text\.duplicateUsername : result\.error \|\| text\.createFailed/);
  assert.match(createPage, /useLeaveGuard\(leaveMessage,/);
  assert.match(createPage, /const leaveMessage = !created && isDirty\(form\) \? text\.createLeaveConfirm : null;/);
});

test("after creation the page offers the new employee's detail (근무·급여) for payroll settings; nothing payroll is saved before", () => {
  assert.match(createPage, /router\.push\(created\.id \? `\/admin\/users\?userId=\$\{encodeURIComponent\(created\.id\)\}&section=payroll` : "\/admin\/users"\)/);
  assert.match(createPage, /const id = result\.user\?\.id;/);
  // the users page opens ?userId=&section=payroll as the detail with 근무·급여 expanded
  assert.match(listPage, /const userId = search\.get\("userId"\);/);
  assert.match(listPage, /search\.get\("section"\) === "payroll" \? "payroll" : "detail"/);
  assert.doesNotMatch(createPage, /\/api\/admin\/payroll\//);
});

test("new create texts exist in both languages", () => {
  for (const key of ["createdNextStep", "createPayrollNote", "createOpenPayroll", "createAnother", "createLeaveConfirm", "createLevelHireDateRequired"] as const) {
    assert.ok(adminUsersText.ko[key] && adminUsersText.vi[key], key);
    assert.notEqual(adminUsersText.ko[key], adminUsersText.vi[key], key);
  }
  assert.ok(adminUsersText.ko.createdNextStep.includes("{name}") && adminUsersText.vi.createdNextStep.includes("{name}"));
  assert.match(adminUsersText.ko.createLeaveConfirm, /\n\n이동할까요\?$/);
});
