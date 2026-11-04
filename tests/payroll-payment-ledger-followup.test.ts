import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { getPaymentApplicabilityBadges } from "../lib/payroll/payment-ledger-view.ts";
import { parsePayrollMonthParam, payrollOverviewHref } from "../lib/payroll/payroll-month-param.ts";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const detail = read("app/(protected)/admin/payroll/[runId]/page.tsx");
const payrollPage = read("app/(protected)/admin/payroll/page.tsx");
const keys = (snapshot: unknown, mealAllowanceEligible = false) => getPaymentApplicabilityBadges({ snapshot, month: "2026-09", mealAllowanceEligible, lang: "ko" }).map(badge => badge.key);

test("status badges come only from the payment snapshot (full snapshot uses the shared rule)", () => {
  const full = { employee: { insuranceEnrolled: true, tax: { taxMode: "resident_progressive", status: "calculated" }, automaticIncentives: [{ category: "attendance_bonus", sourceSnapshot: { payrollMonth: "2026-09" } }] } };
  assert.deepEqual(keys(full, true), ["attendance", "meal", "insurance", "tax"]);
  // 다른 달 개근 보너스·미반영은 표시하지 않는다(지급 월은 종료 월 기준: 실제 반영분만).
  assert.deepEqual(keys({ employee: { automaticIncentives: [{ category: "attendance_bonus", sourceSnapshot: { payrollMonth: "2026-08" } }] } }), []);
  // 명시적 미가입·비과세는 금액이 있어도 명시값 우선
  assert.deepEqual(keys({ employee: { insuranceEnrolled: false, amounts: { employeeInsuranceDeductionAmount: 100 }, tax: { taxMode: "not_applicable", status: "calculated", employeePitDeductionAmount: 0 } } }), []);
  // 검토 중 세금은 확정 상태가 아니므로 표시하지 않음
  assert.deepEqual(keys({ employee: { tax: { taxMode: "resident_progressive", status: "requires_review" } } }), []);
  const ko = getPaymentApplicabilityBadges({ snapshot: full, month: "2026-09", mealAllowanceEligible: true, lang: "ko" });
  const vi = getPaymentApplicabilityBadges({ snapshot: full, month: "2026-09", mealAllowanceEligible: true, lang: "vi" });
  assert.deepEqual(ko.map(b => b.description), ["2026-09 · 개근 보너스 반영", "2026-09 · 식대 대상", "2026-09 · 보험 가입 대상", "2026-09 · TNCN 적용 대상"]);
  assert.ok(vi.every(b => b.description.startsWith("2026-09 · ") && !/[가-힣]/.test(b.description)));
});

test("reduced (reconciled) snapshots: only confirmed positive insurance/TNCN amounts show; unknown shows nothing", () => {
  // 운영 지급 스냅샷 일부는 employee에 amounts/tax 금액만 있다(insuranceEnrolled·taxMode·인센티브 없음).
  assert.deepEqual(keys({ employee: { amounts: { employeeInsuranceDeductionAmount: 0, employerInsuranceAmount: 0 }, tax: { employeePitDeductionAmount: 0, companyPitAmount: 0 } } }), []);
  assert.deepEqual(keys({ employee: { amounts: { employeeInsuranceDeductionAmount: 525000, employerInsuranceAmount: 1050000 }, tax: { employeePitDeductionAmount: 0, companyPitAmount: 0 } } }), ["insurance"]);
  assert.deepEqual(keys({ employee: { amounts: { employeeInsuranceDeductionAmount: 0 }, tax: { employeePitDeductionAmount: 120000 } } }), ["tax"]);
  assert.deepEqual(keys({ employee: { tax: { companyPitAmount: 50000 } } }), ["tax"]);
  // 문자열 금액·스냅샷 없음(미지급)·형식 불명은 추측하지 않는다. 식대는 급여월 eligibility만 반영.
  assert.deepEqual(keys({ employee: { amounts: { employeeInsuranceDeductionAmount: "525000" } } }), []);
  assert.deepEqual(keys(null), []);
  assert.deepEqual(keys(null, true), ["meal"]);
  assert.deepEqual(keys({ legacy: true }), []);
  const snapshot = { employee: { amounts: { employerInsuranceAmount: 1 } } };
  const before = JSON.stringify(snapshot);
  keys(snapshot);
  assert.equal(JSON.stringify(snapshot), before);
});

test("ledger page renders status badges after the name from the snapshot, never from current settings", () => {
  assert.match(detail, /<b style=\{styles\.name\}>\{employee\.employee_name\}<\/b><span style=\{styles\.metaLine\}>\{meta\?<small style=\{styles\.meta\}>\{meta\}<\/small>:null\}<StatusBadges badges=\{getPaymentApplicabilityBadges\(\{snapshot:employee\.calculation_snapshot,month,mealAllowanceEligible:mealAllowanceEligibleSet\.has\(employee\.user_id\),lang\}\)\}/);
  assert.match(detail, /badge\.key==="attendance"\?"💯":badge\.key==="meal"\?"🍚":badge\.key==="insurance"\?"🛡️":badge\.label/);
  assert.match(detail, /title=\{label\} aria-label=\{label\}/);
  assert.equal((detail.match(/fetch\(/g) ?? []).length, 1);
});

test("filter buttons use border longhands only (no shorthand mixed with borderColor)", () => {
  const filterStyle = detail.match(/\n\s*filter:\{[^\n]*\},/)?.[0] ?? "";
  assert.match(filterStyle, /borderWidth:1,borderStyle:"solid",borderColor:"#d1d5db"/);
  assert.doesNotMatch(filterStyle, /border:/);
  assert.match(detail, /filterActive:\{background:"#111827",borderColor:"#111827",color:"#fff"\}/);
});

test("back button returns to the ledger's payroll month and the payroll page reads ?month safely", () => {
  assert.equal(payrollOverviewHref("2026-09-01"), "/admin/payroll?month=2026-09");
  assert.equal(payrollOverviewHref(undefined), "/admin/payroll");
  assert.equal(payrollOverviewHref("bad"), "/admin/payroll");
  assert.equal(parsePayrollMonthParam("2026-09"), "2026-09");
  for (const bad of [null, "", "2026-13", "2026-00", "2026-9", "abcd-01", "1999-12", "2026-09-01"]) assert.equal(parsePayrollMonthParam(bad), null, String(bad));
  assert.match(detail, /<Link href=\{payrollOverviewHref\(ledger\?\.run\.payroll_month\)\} style=\{styles\.back\}>/);
  assert.match(payrollPage, /const urlMonth=parsePayrollMonthParam\(searchParams\.get\("month"\)\);/);
  assert.match(payrollPage, /useState\(\(\)=>urlMonth\?\?currentMonth\(\)\)/);
  assert.match(payrollPage, /query\.set\("month",next\);router\.replace\(`\$\{pathname\}\?\$\{query\.toString\(\)\}`,\{scroll:false\}\)/);
  assert.match(payrollPage, /if\(urlMonth!==syncedUrlMonth\)\{setSyncedUrlMonth\(urlMonth\);if\(urlMonth&&urlMonth!==month\)/);
});

test("difference review is collapsed by default and toggled from its title", () => {
  assert.match(detail, /const\[differenceOpen,setDifferenceOpen\]=useState\(false\);/);
  assert.match(detail, /aria-expanded=\{differenceOpen\} aria-controls="payroll-ledger-difference-review"/);
  assert.match(detail, /\{differenceOpen&&<ul id="payroll-ledger-difference-review"/);
  assert.match(detail, /\{differenceRows\.length>0&&<section style=\{styles\.differenceCard\}/);
});
