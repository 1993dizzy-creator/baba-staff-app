import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { buildDifferenceReview, countPaymentLedgerFilters, matchesPaymentLedgerFilter, matchesPaymentLedgerQuery, summarizePaymentSnapshot, type PaymentLedgerEmployee } from "../lib/payroll/payment-ledger-view.ts";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const detail = read("app/(protected)/admin/payroll/[runId]/page.tsx");
const payrollPage = read("app/(protected)/admin/payroll/page.tsx");
const dashboardSummary = read("components/payroll/PayrollDashboardSummary.tsx");

const row = (name: string, status: "paid" | "unpaid", calculated: number | null, actual: number | null, difference: number | null, reason: string | null = null): PaymentLedgerEmployee =>
  ({ employee_name: name, payment_status: status, calculated_net_amount: calculated, actual_paid_amount: actual, difference_amount: difference, difference_reason: reason });
const employees = [
  row("Nguyễn An", "paid", 8_000_000, 8_000_000, 0),
  row("Trần Bình", "paid", 7_000_000, 7_200_000, 200_000, "교통비 정산"),
  row("Lê Chi", "paid", 6_000_000, 5_900_000, -100_000, null),
  row("Phạm Dũng", "unpaid", null, null, null),
  row("김하나", "unpaid", 5_000_000, null, 300_000),
];

test("filters: 차액발생 = paid with a non-zero stored difference; unpaid is never a difference", () => {
  assert.deepEqual(countPaymentLedgerFilters(employees), { all: 5, paid: 3, unpaid: 2, difference: 2 });
  assert.deepEqual(employees.filter(e => matchesPaymentLedgerFilter(e, "difference")).map(e => e.employee_name), ["Trần Bình", "Lê Chi"]);
  assert.equal(matchesPaymentLedgerFilter(employees[4], "difference"), false);
});

test("name search is case-insensitive and does not mutate the records", () => {
  const before = JSON.stringify(employees);
  assert.deepEqual(employees.filter(e => matchesPaymentLedgerQuery(e, "  trần ")).map(e => e.employee_name), ["Trần Bình"]);
  assert.deepEqual(employees.filter(e => matchesPaymentLedgerQuery(e, "하나")).map(e => e.employee_name), ["김하나"]);
  assert.equal(employees.filter(e => matchesPaymentLedgerQuery(e, "")).length, 5);
  assert.equal(JSON.stringify(employees), before);
});

test("difference review uses stored values and marks missing reasons", () => {
  const review = buildDifferenceReview(employees);
  assert.deepEqual(review.map(r => [r.employee.employee_name, r.calculatedAmount, r.actualAmount, r.differenceAmount, r.reason]), [
    ["Trần Bình", 7_000_000, 7_200_000, 200_000, "교통비 정산"],
    ["Lê Chi", 6_000_000, 5_900_000, -100_000, null],
  ]);
  assert.deepEqual(buildDifferenceReview(employees.filter(e => !matchesPaymentLedgerFilter(e, "difference"))), []);
});

test("snapshot summary only reads verified fields and never invents values", () => {
  assert.deepEqual(summarizePaymentSnapshot(null), []);
  assert.deepEqual(summarizePaymentSnapshot({ legacy: { net: 1 } }), []);
  assert.deepEqual(summarizePaymentSnapshot({ employee: { amounts: { netPayoutAmount: "8000000" } } }), []);
  const items = summarizePaymentSnapshot({ employee: { contract: { payType: "monthly" }, recognizedWorkdays: 20, recognizedMinutes: 9600, amounts: { combinedSalary: 9_000_000, workAppliedAmount: 8_000_000, netPayoutAmount: 7_500_000, employeePitDeductionAmount: null } } });
  assert.deepEqual(items, [
    { key: "payType", value: "monthly" },
    { key: "combinedSalary", value: 9_000_000 },
    { key: "recognizedWorkdays", value: 20 },
    { key: "recognizedMinutes", value: 9600 },
    { key: "workAppliedAmount", value: 8_000_000 },
    { key: "netPayoutAmount", value: 7_500_000 },
  ]);
});

test("ledger page: stored totals, review only when differences exist, raw snapshot preserved", () => {
  assert.match(detail, /\{differenceRows\.length>0&&<section style=\{styles\.differenceCard\}/);
  // 배치 전체 차액은 상단 요약에서 저장값 그대로 한 번만 표시한다(차액 검토에서 중복 표시하지 않음).
  assert.equal((detail.match(/formatVnd\(run\.difference_total\)/g) ?? []).length, 1);
  assert.match(detail, /"차액 합계"\} value=\{formatVnd\(run\.difference_total\)\}/);
  assert.match(detail, /사유 미기록/);
  assert.match(detail, /<pre style=\{styles\.snapshot\}>\{JSON\.stringify\(employee\.calculation_snapshot,null,2\)\}<\/pre>/);
  assert.match(detail, /PAYMENT_LEDGER_FILTERS\.map\(value=><button key=\{value\} type="button" aria-pressed=\{filter===value\}/);
  assert.match(detail, /\{filterLabel\(value\)\} <span style=\{styles\.filterCount\}>\{counts\[value\]\}<\/span>/);
  // 읽기 전용: GET 조회 1회만, 필터 변경 시 추가 조회 없음
  assert.equal((detail.match(/fetch\(/g) ?? []).length, 1);
  assert.doesNotMatch(detail, /method:/);
  assert.match(detail, /\},\[runId,reloadKey\]\);/);
});

test("ledger page: load failure vs not found, retry, and stale-batch protection", () => {
  assert.match(detail, /if\(controller\.signal\.aborted\)return;if\(response\.status===404/);
  assert.match(detail, /String\(data\.run\.id\)!==String\(runId\)/);
  assert.match(detail, /const ledger=state\.status==="ready"&&state\.ledger\.runId===runId\?state\.ledger:null;/);
  assert.match(detail, /해당 급여 지급내역이 없습니다\./);
  assert.match(detail, /onClick=\{\(\)=>setReloadKey\(key=>key\+1\)\}>\{vi\?"Tải lại":"다시 조회"\}/);
  // 실패 화면은 금액·인원수 없이 렌더링된다(run 사용 전 반환)
  const errorReturn = detail.indexOf('if(state.status==="error"||!ledger)return');
  assert.ok(errorReturn > -1 && errorReturn < detail.indexOf("const run=ledger.run;"));
});

test("compact ledger: spinner loading, stored totals, cost details folded, one expanded row, unpaid shows no amount", () => {
  assert.match(detail, /import LoadingState from "@\/components\/LoadingState";/);
  assert.match(detail, /if\(state\.status==="loading"\)return <Container><main style=\{styles\.page\}>\{back\}<LoadingState label=\{vi\?"[^"]+":"급여 지급내역을 불러오는 중입니다…"\} variant="page"\/>/);
  assert.match(payrollPage, /loading&&!overview\?<LoadingState label=\{overviewText\.loading\} variant="page"\/>/);
  assert.match(detail, /"실제 지급 합계"\}<\/span><b style=\{styles\.mainMetricValue\}>\{formatVnd\(run\.actual_paid_total\)\}/);
  assert.match(detail, /"계산 실수령 합계"\} value=\{formatVnd\(run\.calculated_net_total\)\}/);
  const cost = detail.slice(detail.indexOf("<details style={styles.costDetails}>"), detail.indexOf("</details>", detail.indexOf("<details style={styles.costDetails}>")));
  for (const field of ["employer_insurance_total", "director_insurance_amount", "insurance_remittance_total", "actual_company_cost_total", "started_at", "completed_at"]) assert.match(cost, new RegExp(`run\\.${field}`), field);
  assert.match(detail, /const open=expandedId===employee\.id;/);
  assert.match(detail, /onToggle=\{id=>setExpandedId\(current=>current===id\?null:id\)\}/);
  assert.match(detail, /aria-expanded=\{open\} aria-controls=\{panelId\}/);
  assert.match(detail, /\{paid\?<b style=\{styles\.rowAmount\}>\{formatVnd\(employee\.actual_paid_amount\?\?0\)\}<\/b>:null\}/);
  assert.match(detail, /\{paid&&difference!==0\?<span style=\{styles\.rowDifference\}>/);
  // 원본 JSON은 스냅샷 영역 안의 별도 접힘 영역에 그대로 보존
  assert.match(detail, /<details><summary style=\{styles\.summary\}>\{vi\?"Dữ liệu gốc \(JSON\)":"원본 JSON"\}<\/summary><pre style=\{styles\.snapshot\}>/);
});

test("top payment status links to the batch ledger only when the batch is completed", () => {
  assert.doesNotMatch(payrollPage, /PaymentBatchCard|ledgerLink|지급내역 보기/);
  assert.match(payrollPage, /<PayrollDashboardSummary summary=\{dashboardSummary\} paymentBatch=\{overview\.paymentBatch\}/);
  assert.match(dashboardSummary, /if \(paymentBatch\?\.status === "completed" && paymentBatch\.id\) \{/);
  assert.match(dashboardSummary, /<Link href=\{`\/admin\/payroll\/\$\{paymentBatch\.id\}`\}[^>]*>\s*\{count\}\s*<span>\{t\.completed\}<\/span>\s*<span aria-hidden="true">›<\/span>/);
  // 지급 중·배치 없음: 기존 인원 + 급여지급현황 표기 유지
  assert.match(dashboardSummary, /\{count\}\s*<span>\{t\.title\}<\/span>/);
  for (const phrase of ['completed: "지급완료"', 'completed: "Đã trả xong"']) assert.ok(dashboardSummary.includes(phrase), phrase);
});
