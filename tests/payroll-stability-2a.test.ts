import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { commonSettingsSaveApplied, type LatestCommonSettingsState, type SubmittedCommonSettingsState } from "../lib/payroll/common-settings-save.ts";
import { contractSaveApplied, type SavedContractLike } from "../lib/payroll/contract-save-verification.ts";
import { lookupEmployeePaymentStatus } from "../lib/payroll/payment-result-check.ts";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const page = read("app/(protected)/admin/payroll/page.tsx");
const card = read("components/payroll/CompensationCard.tsx");
const common = read("components/payroll/PayrollCommonSettings.tsx");
const settingsPage = ["app/(protected)/admin/payroll/settings/page.tsx", "components/payroll/EmployeePayrollSettingsPanel.tsx", "components/payroll/usePayrollContracts.ts"].map((path) => read(path)).join("\n");

// ---------------------------------------------------------------------------
// 1. 급여관리 조회 실패 복구
// ---------------------------------------------------------------------------

test("overview refresh ignores superseded responses and responses for another month", () => {
  assert.match(page, /const seq=\+\+requestSeqRef\.current;const requestedMonth=month;/);
  assert.match(page, /data\.month!==requestedMonth\)throw/);
  assert.match(page, /if\(signal\?\.aborted\|\|seq!==requestSeqRef\.current\)return false;setOverview\(data\)/);
  assert.match(page, /finally\{if\(seq===requestSeqRef\.current\)setLoading\(false\)\}/);
});

test("overview failure keeps previous data marked stale, offers retry and locks payment actions", () => {
  assert.match(page, /error&&overview\?<div role="alert"[\s\S]*최신이 아닐 수 있습니다[\s\S]*onClick=\{\(\)=>void refresh\(\)\}>\{vi\?"Tải lại":"다시 조회"\}/);
  assert.match(page, /error&&!overview\?<div role="alert" style=\{styles\.error\}><span>\{error\}<\/span><button/);
  assert.match(page, /const overviewUnreliable=loading\|\|Boolean\(error\)\|\|!overview\|\|overview\.month!==month;/);
  assert.match(page, /paymentLocked=\{overviewUnreliable\}/);
  assert.match(card, /disabled=\{employee\.payment\?\.payment_status !== "paid" && \(paymentLocked \|\|/);
  assert.match(card, /disabled=\{busy\|\|!accountsLoaded\|\|!fundAccountId\|\|paymentLocked\|\|/);
  assert.match(card, /disabled=\{busy\|\|paymentLocked\|\|cancelMode/);
});

// ---------------------------------------------------------------------------
// 3. 급여 지급 결과 확인 (응답 유실 / 지급 후 조회 실패 / 중복 지급 방지)
// ---------------------------------------------------------------------------

function fakeFetch(routes: Record<string, { ok: boolean; body: unknown } | Error>) {
  const calls: string[] = [];
  const fetcher = async (input: string) => {
    calls.push(input);
    const route = routes[input];
    if (!route) throw new Error(`unexpected ${input}`);
    if (route instanceof Error) throw route;
    return { ok: route.ok, json: async () => route.body };
  };
  return { fetcher, calls };
}

test("payment lookup: lost response but payment committed → paid (read-only GETs only)", async () => {
  const { fetcher, calls } = fakeFetch({
    "/api/admin/payroll/runs": { ok: true, body: { ok: true, runs: [{ id: 7, payroll_month: "2026-10-01" }, { id: 6, payroll_month: "2026-09-01" }] } },
    "/api/admin/payroll/runs/7": { ok: true, body: { ok: true, employees: [{ user_id: 3, payment_status: "paid" }, { user_id: 4, payment_status: "unpaid" }] } },
  });
  assert.equal(await lookupEmployeePaymentStatus("2026-10", 3, fetcher), "paid");
  assert.deepEqual(calls, ["/api/admin/payroll/runs", "/api/admin/payroll/runs/7"]);
  assert.equal(await lookupEmployeePaymentStatus("2026-10", 4, fetcher), "unpaid");
});

test("payment lookup: no batch for the month → unpaid; lookup failure → null (unknown)", async () => {
  const noBatch = fakeFetch({ "/api/admin/payroll/runs": { ok: true, body: { ok: true, runs: [{ id: 6, payroll_month: "2026-09-01" }] } } });
  assert.equal(await lookupEmployeePaymentStatus("2026-10", 3, noBatch.fetcher), "unpaid");
  const runsDown = fakeFetch({ "/api/admin/payroll/runs": { ok: false, body: { ok: false, code: "PAYROLL_RUNS_READ_FAILED" } } });
  assert.equal(await lookupEmployeePaymentStatus("2026-10", 3, runsDown.fetcher), null);
  const network = fakeFetch({ "/api/admin/payroll/runs": new TypeError("Failed to fetch") });
  assert.equal(await lookupEmployeePaymentStatus("2026-10", 3, network.fetcher), null);
  const detailDown = fakeFetch({
    "/api/admin/payroll/runs": { ok: true, body: { ok: true, runs: [{ id: 7, payroll_month: "2026-10-01" }] } },
    "/api/admin/payroll/runs/7": { ok: false, body: null },
  });
  assert.equal(await lookupEmployeePaymentStatus("2026-10", 3, detailDown.fetcher), null);
});

test("payment modal never re-sends the payment POST automatically and verifies uncertain results first", () => {
  const modal = card.slice(card.indexOf("function PaymentModal("), card.indexOf("function PaymentSalarySummary("));
  assert.equal((modal.match(/method:"POST"/g) ?? []).length, 1);
  // 네트워크 오류 · 응답 본문 유실 → 기존 지급 기록 조회
  assert.match(modal, /\}catch\{await confirmPaymentResult\(\);return\}/);
  assert.match(modal, /if\(!data\|\|typeof data!=="object"\)\{await confirmPaymentResult\(\);return\}/);
  // 결과가 정해졌거나 확인 중이면 지급 버튼 자체를 내리고, 제출 함수도 막는다
  assert.match(modal, /async function submit\(\)\{if\(busy\|\|outcome\|\|paymentLocked\|\|/);
  assert.match(modal, /outcome\?\.kind==="unknown"\?<button[^>]*onClick=\{\(\)=>void recheckPaymentResult\(\)\}/);
  assert.match(modal, /outcome\?null:<button type="button" style=\{\{\.\.\.s\.primary/);
  // 확인 결과 지급되지 않은 경우에만 다시 지급할 수 있다
  assert.match(modal, /if\(status==="unpaid"\)\{setOutcome\(null\)/);
  assert.match(modal, /setOutcome\(\{kind:"unknown"\}\)/);
});

test("payment success with failed list refresh is reported as paid, not as a payment failure", () => {
  const modal = card.slice(card.indexOf("function PaymentModal("), card.indexOf("function PaymentSalarySummary("));
  assert.match(modal, /const refreshed=await refresh\(\);if\(refreshed\)\{close\(\);return\}setOutcome\(\{kind:"paid",confirmed:false,refreshed:false\}\)/);
  assert.match(modal, /onClick=\{\(\)=>void reloadAfterPayment\(\)\}>\{vi\?"Tải lại danh sách lương":"급여 목록 다시 조회"\}/);
  assert.match(card, /다만 급여 목록을 다시 불러오지 못했습니다\. 다시 지급하지 말고 목록을 다시 조회해주세요\./);
});

test("already-paid response is shown as an existing payment (duplicate prevented), and the server guard stays", () => {
  assert.match(card, /if\(data\.code==="PAYROLL_EMPLOYEE_ALREADY_PAID"\)\{setOutcome\(\{kind:"alreadyPaid",refreshed:await refresh\(\)\}\);return\}/);
  assert.match(card, /이미 지급된 기록이 있어 중복 지급하지 않았습니다\./);
  const route = read("app/api/admin/payroll/payments/route.ts");
  assert.match(route, /if\(message\.includes\("ALREADY_PAID"\)\)return payrollJson\(\{ok:false,code:"PAYROLL_EMPLOYEE_ALREADY_PAID"\},409\)/);
  assert.match(route, /payroll_pay_employee_v3/);
});

// ---------------------------------------------------------------------------
// 2. 급여설정 저장 안정화
// ---------------------------------------------------------------------------

const row = {
  payment_day: 5,
  employee_insurance_rate_bp: 1050,
  employer_insurance_rate_bp: 2150,
  director_insurance_enabled: true,
  director_insurance_base_amount: 5_000_000,
  director_insurance_rate_bp: 3200,
  late_major_threshold_minutes: 30,
  late_minor_penalty_minutes: 30,
  late_major_penalty_rate_bp: 5000,
  unauthorized_absence_penalty_days: 2,
};
const payload = {
  paymentDay: 5,
  employeeInsuranceRateBp: 1050,
  employerInsuranceRateBp: 2150,
  directorInsuranceEnabled: true,
  directorInsuranceBaseAmount: 5_000_000,
  directorInsuranceRateBp: 3200,
  lateMajorThresholdMinutes: 30,
  lateMinorPenaltyMinutes: 30,
  lateMajorPenaltyRateBp: 5000,
  unauthorizedAbsencePenaltyDays: 2,
};
const bonus = { effectiveMonth: "2026-12", minimumActualWorkdays: 24, allowedLateCount: 1, allowedEarlyLeaveCount: 0, bonusAmount: 500_000, revision: 2, note: "연말" };
const latest: LatestCommonSettingsState = {
  settings: row,
  mealCurrent: { dailyAmount: 30_000, effectiveFrom: "2026-08-01", revision: 1 },
  mealHistory: [{ dailyAmount: 35_000, effectiveFrom: "2026-12-01", revision: 2 }, { dailyAmount: 33_000, effectiveFrom: "2026-12-01", revision: 1 }, { dailyAmount: 30_000, effectiveFrom: "2026-08-01", revision: 1 }],
  bonusCurrent: null,
  bonusHistory: [bonus],
};

test("common settings verification: committed save is recognised as applied", () => {
  const submitted: SubmittedCommonSettingsState = {
    payload,
    meal: { dailyAmount: 35_000, effectiveFrom: "2026-12-01" },
    bonus: { effectiveMonth: "2026-12", minimumActualWorkdays: "24", allowedLateCount: "1", allowedEarlyLeaveCount: "0", bonusAmount: "500000", note: " 연말 " },
  };
  assert.equal(commonSettingsSaveApplied(latest, submitted), true);
});

test("common settings verification: lost save (server still has old values) is not applied", () => {
  assert.equal(commonSettingsSaveApplied(latest, { payload: { ...payload, paymentDay: 10 }, meal: null, bonus: null }), false);
  // 같은 적용일의 최신 revision 금액만 인정한다(이전 revision 금액과 일치해도 미반영).
  assert.equal(commonSettingsSaveApplied(latest, { payload, meal: { dailyAmount: 33_000, effectiveFrom: "2026-12-01" }, bonus: null }), false);
  assert.equal(commonSettingsSaveApplied(latest, { payload, meal: null, bonus: { effectiveMonth: "2026-12", minimumActualWorkdays: "24", allowedLateCount: "1", allowedEarlyLeaveCount: "0", bonusAmount: "600000", note: "연말" } }), false);
  assert.equal(commonSettingsSaveApplied({ ...latest, bonusHistory: [] }, { payload, meal: null, bonus: { effectiveMonth: "2026-12", minimumActualWorkdays: "24", allowedLateCount: "1", allowedEarlyLeaveCount: "0", bonusAmount: "500000", note: "" } }), false);
});

test("common settings save: network error releases saving state and uncertain results are verified, not re-saved", () => {
  const saveFn = common.slice(common.indexOf("async function save()"), common.indexOf("async function recheck()"));
  assert.match(saveFn, /\} finally \{\n      setSaving\(false\);\n    \}/);
  assert.match(saveFn, /\} catch \{\n        \/\/ 네트워크 오류·응답 유실[^\n]*\n        await verifyPendingSave\(submitted\);\n        return;/);
  assert.equal((saveFn.match(/method: "PUT"/g) ?? []).length, 1);
  assert.match(saveFn, /if \(!draft \|\| !bonusDraft \|\| pendingSaveRef\.current\) return;/);
  // 저장 성공 후 재조회 실패: 저장 성공으로 안내 + 제출값을 snapshot으로 고정(같은 값 재저장 방지)
  assert.match(saveFn, /setSnapshot\(submittedDraft\);[\s\S]*setBonusSnapshot\(submittedBonusDraft\);[\s\S]*setError\("reload"\);/);
  const verifyFn = common.slice(common.indexOf("async function verifyPendingSave("), common.indexOf("async function save()"));
  assert.match(verifyFn, /pendingSaveRef\.current = submitted;\n      setError\("unverified"\);/);
  assert.match(verifyFn, /if \(commonSettingsSaveApplied\(latest, submitted\)\) \{\n      apply\(latest\);/);
  assert.match(verifyFn, /setError\("notApplied"\);/);
  assert.doesNotMatch(verifyFn, /setDraft\(|method: "PUT"/);
  assert.match(common, /error === "reload" \|\| error === "unverified" \? \([\s\S]*onClick=\{\(\) => void recheck\(\)\}/);
  assert.match(common, /onClick=\{retryInitialLoad\}/);
});

test("contract verification: create/correct are recognised only when the server shows the submitted change", () => {
  const history: SavedContractLike[] = [
    { id: 12, effectiveFrom: "2026-11-01", payType: "monthly", baseSalary: 9_000_000, fixedRaiseAmount: 500_000, auditVersion: 40 },
    { id: 11, effectiveFrom: "2026-08-01", payType: "monthly", baseSalary: 8_000_000, fixedRaiseAmount: 0, auditVersion: 31 },
  ];
  const create = { mode: "create" as const, effectiveFrom: "2026-11-01", payType: "monthly", baseSalary: 9_000_000, fixedRaiseAmount: 500_000 };
  assert.equal(contractSaveApplied(history, { ...create, knownContractIds: [11] }), true);
  assert.equal(contractSaveApplied(history, { ...create, knownContractIds: [11, 12] }), false);
  assert.equal(contractSaveApplied(history, { ...create, knownContractIds: [11], baseSalary: 9_100_000 }), false);
  const correct = { mode: "correct" as const, contractId: 12, effectiveFrom: "2026-11-01", payType: "monthly", baseSalary: 9_000_000, fixedRaiseAmount: 500_000 };
  assert.equal(contractSaveApplied(history, { ...correct, expectedAuditVersion: 39 }), true);
  assert.equal(contractSaveApplied(history, { ...correct, expectedAuditVersion: 40 }), false);
});

test("settings page separates HTTP errors from an empty employee list and offers retry", () => {
  assert.match(settingsPage, /if \(!response\.ok \|\| !data \|\| data\.ok === false \|\| !Array\.isArray\(data\.users\)\) throw new Error\("PAYROLL_USERS_READ_FAILED"\);/);
  assert.match(settingsPage, /onClick=\{\(\) => setUsersReloadKey\(\(key\) => key \+ 1\)\}/);
});

test("contract save distinguishes failure, uncertain result and post-save reload failure", () => {
  const submitFn = settingsPage.slice(settingsPage.indexOf("async function submit("), settingsPage.indexOf("async function verifyContractSave("));
  assert.equal((submitFn.match(/method: "POST"/g) ?? []).length, 1);
  assert.match(submitFn, /if \(pendingContractSave\) return;/);
  assert.match(submitFn, /\} catch \{\n        \/\/ 네트워크 오류·응답 유실[^\n]*\n        await verifyContractSave\(submitted\);\n        return;/);
  assert.match(submitFn, /const history = await load\(\);\n      setOpen\(false\);\n      setNotice\(history/);
  assert.match(submitFn, /급여계약은 저장되었지만 계약 목록을 다시 불러오지 못했습니다/);
  const verifyFn = settingsPage.slice(settingsPage.indexOf("async function verifyContractSave("), settingsPage.indexOf("async function recheckContracts("));
  assert.match(verifyFn, /setPendingContractSave\(submitted\);/);
  assert.match(verifyFn, /if \(contractSaveApplied\(history, submitted\)\)/);
  assert.doesNotMatch(verifyFn, /method: "POST"/);
  assert.match(settingsPage, /pendingContractSave \? \(\n\s*<button type="button" style=\{s\.modalSave\}[^>]*onClick=\{\(\) => void recheckContracts\(\)\}/);
});
