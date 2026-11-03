import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
// @ts-expect-error Node strip-types resolves the TypeScript source directly.
import { buildPayrollDashboardSummary, buildPayrollPartTotals, countPayrollDashboardFilters, getPayrollActualPaidAmount, getPayrollCalculatedNetAmount, matchesPayrollDashboardFilter } from "../lib/payroll/payroll-dashboard.ts";
// @ts-expect-error Node strip-types resolves the TypeScript source directly.
import { getPayrollHeaderAmount } from "../lib/payroll/payroll-page-display.ts";

type Status = "calculable" | "requires_review" | "unavailable";
const employee = (userId: number, values: { status?: Status; combined?: number | null; monthly?: number | null; current?: number | null; net?: number; paid?: number | null; contract?: boolean } = {}) => ({
  userId,
  name: `E${userId}`,
  contract: values.contract === false ? null : { payType: "monthly" },
  calculationStatus: values.status ?? "calculable",
  amounts: {
    combinedSalary: values.combined === undefined ? 10_000_000 : values.combined,
    contractMonthlyEquivalent: values.monthly === undefined ? null : values.monthly,
    currentAmount: values.current === undefined ? 1 : values.current,
    netPayoutAmount: values.net ?? 9_000_000,
  },
  payment: values.paid === undefined ? null : { payment_status: values.paid === null ? "unpaid" as const : "paid" as const, actual_paid_amount: values.paid },
});

const roster = [
  employee(1, { paid: 9_000_000 }),
  employee(2, { paid: null }),
  employee(3, { status: "requires_review" }),
  employee(4, { status: "unavailable", contract: false, combined: null }),
  // Hourly contract: rate 30,000 with a 7,800,000 monthly equivalent.
  employee(5, { combined: 30_000, monthly: 7_800_000, net: 5_000_000, paid: 5_200_000 }),
];

test("summary counts target, calculable, review and paid from the overview payload only", () => {
  assert.deepEqual(buildPayrollDashboardSummary(roster), { target: 5, calculable: 3, review: 2, paid: 2, unpaid: 3 });
  assert.deepEqual(countPayrollDashboardFilters(roster), { all: 5, review: 2, unpaid: 3, paid: 2 });
  assert.deepEqual(roster.filter((row) => matchesPayrollDashboardFilter(row, "review")).map((row) => row.userId), [3, 4]);
  assert.deepEqual(roster.filter((row) => matchesPayrollDashboardFilter(row, "unpaid")).map((row) => row.userId), [2, 3, 4]);
  assert.deepEqual(roster.filter((row) => matchesPayrollDashboardFilter(row, "paid")).map((row) => row.userId), [1, 5]);
  assert.equal(roster.every((row) => matchesPayrollDashboardFilter(row, "all")), true);
});

test("card amounts separate calculated net from actual paid and hide net when not calculable", () => {
  assert.equal(getPayrollCalculatedNetAmount(roster[0]), 9_000_000);
  assert.equal(getPayrollCalculatedNetAmount(roster[2]), null);
  assert.equal(getPayrollCalculatedNetAmount(employee(9, { current: null })), null);
  assert.equal(getPayrollCalculatedNetAmount(roster[0], true), null);
  assert.equal(getPayrollActualPaidAmount(roster[4]), 5_200_000);
  assert.equal(getPayrollActualPaidAmount(roster[1]), null);
  assert.equal(getPayrollActualPaidAmount(roster[2]), null);
});

test("department totals never add an hourly rate to monthly salaries and list excluded staff", () => {
  const totals = buildPayrollPartTotals(roster, getPayrollHeaderAmount);
  // 10M x3 monthly + 7.8M hourly monthly-equivalent; E4 has no contract.
  assert.equal(totals.contractMonthlyTotal, 37_800_000);
  assert.deepEqual(totals.contractExcluded, ["E4"]);
  assert.equal(totals.netTotal, 9_000_000 + 9_000_000 + 5_000_000);
  assert.deepEqual(totals.netExcluded, ["E3", "E4"]);
  assert.equal(totals.paidTotal, 14_200_000);
  assert.equal(totals.paidCount, 2);
  const future = buildPayrollPartTotals(roster, getPayrollHeaderAmount, true);
  assert.equal(future.contractMonthlyTotal, 0);
  assert.equal(future.netTotal, 0);
});

test("payroll page wires summary and filters without changing payment or calculation calls", () => {
  const page = readFileSync(join(process.cwd(), "app/(protected)/admin/payroll/page.tsx"), "utf8");
  const card = readFileSync(join(process.cwd(), "components/payroll/CompensationCard.tsx"), "utf8");
  const summary = readFileSync(join(process.cwd(), "components/payroll/PayrollDashboardSummary.tsx"), "utf8");
  assert.match(page, /<PayrollDashboardSummary summary=\{dashboardSummary\}/);
  assert.match(page, /<PayrollDashboardFilters value=\{filter\}/);
  assert.match(page, /group\.visibleEmployees\.map\(employee=><CompensationCard/);
  // Department totals stay department-wide regardless of the active filter.
  assert.match(page, /<CombinedPartTotal employees=\{group\.employees\}/);
  assert.match(page, /fetch\(`\/api\/admin\/payroll\/overview\?month=\$\{month\}`/);
  assert.match(card, /buildPayrollPartTotals\(employees, getPayrollHeaderAmount, future\)/);
  for (const phrase of ["급여 대상", "계산 가능", "확인 필요", "지급완료", "미지급", "전체", "Nhân viên tính lương", "Tính được", "Cần kiểm tra", "Đã trả", "Chưa trả", "Tất cả"]) assert.ok(summary.includes(phrase), phrase);
  for (const phrase of ["계산 실수령", "실제 지급", "Thực nhận đã tính", "Thực trả", "계약급여 (월 환산)", "Lương hợp đồng (quy đổi tháng)"]) assert.ok(card.includes(phrase), phrase);
});
