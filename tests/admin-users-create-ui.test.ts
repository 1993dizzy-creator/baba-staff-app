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
  // 5차: 근태 기록 사용은 독립 스위치가 아니라 급여계약 유형에서 정해진다(고정급 OFF, 월급제 ON).
  assert.doesNotMatch(createPage, /<Toggle label=\{text\.attendanceTracking\}/);
  assert.match(createPage, /return form\.role === "owner" \? true : attendanceTrackingForPayKind\(form\.pay_kind\);/);
  // 앱 로그인 허용과 계정 활성은 별도 필드(합치지 않음)
  assert.match(createPage, /<Toggle label=\{text\.appLoginEnabled\} checked=\{form\.app_login_enabled\} onChange=\{\(value\) => update\("app_login_enabled", value\)\} \/>/);
  assert.match(createPage, /<Toggle label=\{text\.activeStatus\} checked=\{form\.is_active\} onChange=\{\(value\) => update\("is_active", value\)\} \/>/);
  // 5차: 레벨은 적용/미적용만(기준월 직접 지정 없음). 급여계약 유형·금액 기준은 중립 2분할.
  const level = createPage.slice(createPage.indexOf('<SubsectionTitle emoji="📈">'), createPage.indexOf('<SubsectionTitle emoji="🎁">'));
  assert.match(level, /<BenefitChoice\s+label=\{text\.levelParticipation\}\s+value=\{form\.level_program_enabled\}/);
  assert.doesNotMatch(level, /levelBasisShort|levelDirectShort|type="month"/);
  const pay = createPage.slice(createPage.indexOf('<SubsectionTitle emoji="💰">'), createPage.indexOf('<SubsectionTitle emoji="📈">'));
  assert.match(pay, /tone="neutral"\s+label=\{text\.createPayKind\}/);
  assert.match(pay, /tone="neutral"\s+label=\{text\.createPayUnit\}/);
  assert.doesNotMatch(pay, /"daily"/, "no daily option for new employees");
});

test("create page keeps the create API contract: same defaults, explicit payload (hire-month base), client checks", () => {
  assert.match(createPage, /work_start_time: "16:00",\n {2}work_end_time: "01:00",\n {2}is_active: true,\n {2}level_program_enabled: true,\n {2}app_login_enabled: true,\n {2}pay_kind: "monthly",\n {2}pay_unit: "monthly",\n {2}pay_amount: "",\n {2}meal_enabled: false,\n {2}bonus_enabled: false,/);
  assert.match(createPage, /attendanceFetch\("\/api\/admin\/users\/create", \{\n\s+method: "POST",/);
  assert.match(createPage, /body: JSON\.stringify\(payload\),/);
  const payload = createPage.slice(createPage.indexOf("function createPayload("), createPage.indexOf("function planSetup("));
  assert.match(payload, /level_base_mode: "hire_month" as const,/);
  assert.match(payload, /attendance_tracking_enabled: attendanceFor\(form\),/);
  assert.doesNotMatch(payload, /pay_|meal|bonus|position|level_base_month/);
  assert.match(createPage, /if \(!form\.username\.trim\(\) \|\| !form\.password\.trim\(\) \|\| !form\.name\.trim\(\)\)/);
  assert.match(createPage, /if \(!hireValid\) \{\n\s+setMessage\(text\.createHireDateRequired\);/);
  assert.match(createPage, /if \(attendance && \(!form\.work_start_time \|\| !form\.work_end_time\)\)/);
  assert.match(createPage, /if \(applies && !\(amount > 0\)\)/);
  assert.match(createPage, /level_program_enabled: role !== "owner"/);
});

test("fixed pay turns meal/bonus OFF, disables them and never plans their requests", () => {
  assert.match(createPage, /pay_kind: kind, \.\.\.\(kind === "fixed" \? \{ meal_enabled: false, bonus_enabled: false \} : null\)/);
  assert.match(createPage, /<Toggle label=\{text\.benefitMeal\} checked=\{monthlyPay && form\.meal_enabled\} disabled=\{!monthlyPay \|\| !applies\}/);
  assert.match(createPage, /<Toggle label=\{text\.benefitBonus\} checked=\{monthlyPay && form\.bonus_enabled\} disabled=\{!monthlyPay \|\| !applies\}/);
  assert.match(createPage, /meal: monthly && form\.meal_enabled \?/);
  assert.match(createPage, /bonus: monthly && form\.bonus_enabled \?/);
});

test("create page sends one POST at a time, keeps input on failure, re-checks a lost create response and guards unsaved input", () => {
  const submit = createPage.slice(createPage.indexOf("async function submit()"), createPage.indexOf("async function retrySetup()"));
  assert.match(submit, /if \(submitting\.current\) return;/);
  assert.match(submit, /submitting\.current = true;/);
  assert.match(submit, /finally \{\n\s+submitting\.current = false;/);
  // the form is reset only after the employee is confirmed created
  assert.ok(submit.indexOf("setForm(initialForm)") > submit.indexOf("if (response && result?.ok)"));
  assert.ok(submit.indexOf("setForm(initialForm)") < submit.indexOf("} catch (error) {"));
  assert.match(submit, /response\.status === 409 \? text\.duplicateUsername : result\.error \|\| text\.createFailed/);
  assert.match(submit, /userId = await findCreatedUser\(payload\);/);
  assert.match(createPage, /useLeaveGuard\(leaveFor\(setup, form\), \(\) => leaveFor\(setupRef\.current, formRef\.current\)\);/);
});

test("first payroll setup reuses the existing APIs, checks before writing and is never shown complete while a step is missing", () => {
  assert.match(createPage, /fetch\("\/api\/admin\/payroll\/contracts", json\(\{ userId, \.\.\.request \}\)\)/);
  assert.match(createPage, /fetch\("\/api\/admin\/payroll\/meal-allowance\/eligibility", json\(\{ userId, isEligible: true, effectiveFrom \}\)\)/);
  assert.match(createPage, /fetch\("\/api\/admin\/payroll\/attendance-bonus\/eligibility", json\(\{ userId, isEligible: true, effectiveMonth \}\)\)/);
  const ensure = createPage.slice(createPage.indexOf("async function ensureStep"), createPage.indexOf("async function readHistory"));
  // read first: same value → done (no write), different value → conflict (no overwrite); after a failed/lost write read again
  assert.ok(ensure.indexOf("rows.some(input.matches)") < ensure.indexOf("input.write()"));
  assert.match(ensure, /if \(rows\.length > 0\) return \{ ok: false, message: input\.conflictMessage \};/);
  assert.ok(ensure.lastIndexOf("input.read()") > ensure.indexOf("input.write()"));
  assert.match(createPage, /return setup\.mode !== "inactive" && setup\.mode !== "noId" && plannedSteps\(setup\)\.every\(\(key\) => setup\.status\[key\] === "done"\);/);
  assert.match(createPage, /if \(current\.status\[key\] === "done"\) continue;/);
  assert.match(createPage, /window\.sessionStorage\.setItem\(SETUP_KEY, JSON\.stringify\(setup\)\)/);
  // owner / inactive accounts never call the contract API (existing constraints are not bypassed)
  assert.match(createPage, /if \(form\.role === "owner"\) return \{ \.\.\.base, mode: "owner" \};\n\s+if \(!form\.is_active\) return \{ \.\.\.base, mode: "inactive" \};/);
  // the users page opens ?userId=&section=payroll as the detail with 근무·급여 expanded
  assert.match(createPage, /router\.push\(current\.userId \? `\/admin\/users\?userId=\$\{encodeURIComponent\(current\.userId\)\}&section=payroll` : "\/admin\/users"\)/);
  assert.match(listPage, /const userId = search\.get\("userId"\);/);
  assert.match(listPage, /search\.get\("section"\) === "payroll" \? "payroll" : "detail"/);
});

test("create API requires a hire date regardless of the level choice (the create RPC already requires it)", () => {
  const route = read("app/api/admin/users/create/route.ts");
  assert.match(route, /if \(!hireDate\) \{\n\s+return NextResponse\.json\(\n\s+\{ ok: false, code: "HIRE_DATE_REQUIRED"/);
  assert.doesNotMatch(route, /levelProgramEnabled && !hireDate/);
});

test("detail page warns that a hire-date edit does not move saved contract/benefit dates", () => {
  assert.match(listPage, /\(draft\.hire_date \|\| null\) !== \(user\.hire_date \|\| null\) \? \(\n\s+<span role="status" style=\{styles\.fieldNotice\}>\{text\.hireDateChangeNotice\}<\/span>/);
});

test("new create texts exist in both languages", () => {
  for (const key of ["createdNextStep", "createPayrollNote", "createOpenPayroll", "createAnother", "createLeaveConfirm", "createLevelHireDateRequired",
    "createHireDateRequired", "createPayKind", "createPayFixed", "createPayMonthly", "createPayUnit", "createPayUnitMonthly", "createPayUnitHourly",
    "createAmountMonthly", "createAmountHourly", "createAmountRequired", "createAttendanceOnByPay", "createAttendanceOffByPay", "createContractEffective",
    "createFixedProrationNotice", "createBenefitFixedOff", "createMealFrom", "createBonusFrom", "createOwnerNoPayroll", "createInactiveNoPayroll",
    "createSetupIncompleteTitle", "createSetupIncompleteHelp", "createSetupRetry", "createSetupOpenDetail", "createSetupLeaveConfirm", "createStepEmployee",
    "createStepContract", "createStepDone", "createStepFailed", "createStepPending", "createStepRunning", "createStepConflict", "createStepFailedGeneric",
    "createdComplete", "createOpenDetail", "hireDateChangeNotice"] as const) {
    assert.ok(adminUsersText.ko[key] && adminUsersText.vi[key], key);
    assert.notEqual(adminUsersText.ko[key], adminUsersText.vi[key], key);
  }
  assert.ok(adminUsersText.ko.createdNextStep.includes("{name}") && adminUsersText.vi.createdNextStep.includes("{name}"));
  assert.match(adminUsersText.ko.createLeaveConfirm, /\n\n이동할까요\?$/);
});
