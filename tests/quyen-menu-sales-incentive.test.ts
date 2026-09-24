import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
// @ts-expect-error Node strip-types resolves the TypeScript source directly.
import { buildMenuSales } from "../lib/sales/menu-sales.ts";
// @ts-expect-error Node strip-types resolves the TypeScript source directly.
import { QUYEN_MENU_SALES_INCENTIVE_POLICY, calculateQuyenMenuSalesIncentive, resolveQuyenMenuSalesIncentiveCronTarget, syncQuyenMenuSalesIncentive } from "../lib/payroll/quyen-menu-sales-incentive.ts";
// @ts-expect-error Node strip-types resolves the TypeScript source directly.
import { calculateManualAdjustmentTotals, calculatePayrollPayoutAmounts, calculateSalesMenuIncentiveTotals } from "../lib/payroll/adjustments.ts";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const receipt = (id: number, overrides: Record<string, unknown> = {}) => ({
  id,
  ref_no: `R${id}`,
  business_date: "2026-09-30",
  ref_date: null,
  payment_status: 3,
  is_canceled: false,
  ...overrides,
});
const line = (id: number, receiptId: number, itemCode: string, finalAmount: number, overrides: Record<string, unknown> = {}) => ({
  id,
  receipt_id: receiptId,
  ref_detail_id: `L${id}`,
  parent_ref_detail_id: null,
  business_date: "2026-09-30",
  payment_status: 3,
  is_canceled: false,
  item_id: null,
  item_code: itemCode,
  item_name: itemCode,
  quantity: 1,
  final_amount: finalAmount,
  is_option: false,
  ref_detail_type: 1,
  mapping_status: "mapped",
  is_excluded: false,
  raw_json: {},
  ...overrides,
});
const menuItem = (itemCode: string, quantity: number, amount: number) => ({
  key: itemCode,
  itemId: null,
  itemCode,
  itemName: itemCode,
  categoryName: null,
  groupType: "uncategorized" as const,
  quantity,
  amount,
  receiptCount: 1,
  optionAmount: 0,
  options: [],
});

test("monthly menu projection includes only eligible paid C5/J7/J8 sales and attributes options to the parent", () => {
  const receipts = [
    receipt(1),
    receipt(2, { is_canceled: true }),
    receipt(3, { payment_status: 2 }),
  ];
  const lines = [
    line(1, 1, "C5", 1_000, { quantity: 2 }),
    line(2, 1, "OPT", 200, { parent_ref_detail_id: "L1", is_option: true, ref_detail_type: 2 }),
    line(3, 1, "J7", 3_000, { quantity: 3 }),
    line(4, 1, "J8", 1_800, { quantity: 2 }),
    line(5, 1, "C5", 9_000, { is_excluded: true }),
    line(6, 2, "C5", 8_000),
    line(7, 3, "J7", 7_000, { payment_status: 2 }),
    line(8, 1, "OTHER", 4_000),
  ];
  const menuSales = buildMenuSales(receipts, lines, [], []);
  const c5 = menuSales.items.find((item) => item.itemCode === "C5");
  assert.equal(c5?.quantity, 2);
  assert.equal(c5?.amount, 1_200);
  assert.equal(c5?.optionAmount, 200);

  const calculation = calculateQuyenMenuSalesIncentive("2026-09", menuSales.items);
  assert.deepEqual(calculation.items.map(({ itemCode, quantity, amount }) => ({ itemCode, quantity, amount })), [
    { itemCode: "C5", quantity: 2, amount: 1_200 },
    { itemCode: "J7", quantity: 3, amount: 3_000 },
    { itemCode: "J8", quantity: 2, amount: 1_800 },
  ]);
  assert.equal(calculation.totalQuantity, 7);
  assert.equal(calculation.totalSalesAmount, 6_000);
  assert.equal(calculation.incentiveAmount, 180);
  assert.equal(calculation.businessDate, "2026-09-30");
});

test("policy is Quyen-only, uses basis points, rounds VND, and has a deterministic source key", () => {
  assert.deepEqual(QUYEN_MENU_SALES_INCENTIVE_POLICY.itemCodes, ["C5", "J7", "J8"]);
  assert.equal(QUYEN_MENU_SALES_INCENTIVE_POLICY.username, "quyen");
  assert.equal(QUYEN_MENU_SALES_INCENTIVE_POLICY.rateBasisPoints, 300);
  assert.equal(QUYEN_MENU_SALES_INCENTIVE_POLICY.effectiveFromMonth, "2026-09");
  const result = calculateQuyenMenuSalesIncentive("2026-09", [menuItem("C5", 1, 1_017)]);
  assert.equal(result.incentiveAmount, 31);
  assert.equal(result.sourceKey, "quyen-menu-sales-incentive:2026-09:v1");
});

test("03:15 Vietnam cron runs only on day one for the previous month and respects effective month", () => {
  assert.deepEqual(
    resolveQuyenMenuSalesIncentiveCronTarget(new Date("2026-09-30T20:15:00Z")),
    { ok: true, targetMonth: "2026-09" },
  );
  assert.deepEqual(
    resolveQuyenMenuSalesIncentiveCronTarget(new Date("2026-09-29T20:15:00Z")),
    { ok: false, reason: "not_first_day" },
  );
  assert.deepEqual(
    resolveQuyenMenuSalesIncentiveCronTarget(new Date("2026-08-31T20:15:00Z")),
    { ok: false, reason: "before_effective_month", targetMonth: "2026-08" },
  );
});

class MemoryRepository {
  rows = new Map<string, { id: number; amount: number; businessDate: string; reason: string; note: string | null; cancelledAt: string | null }>();
  paid = false;
  creates = 0;
  updates = 0;
  resolved: Array<[string, boolean]> = [];
  async resolveUserId(username: string, systemAccount: boolean) {
    this.resolved.push([username, systemAccount]);
    return username === "quyen" ? 3 : username === "pos" ? 22 : null;
  }
  async isPayrollPaid() { return this.paid; }
  async findAdjustment(sourceType: string, sourceKey: string) { return this.rows.get(`${sourceType}:${sourceKey}`) ?? null; }
  async createAdjustment(input: { sourceType: string; sourceKey: string; amount: number; businessDate: string; reason: string; note: string }) {
    this.creates++;
    const key = `${input.sourceType}:${input.sourceKey}`;
    if (!this.rows.has(key)) this.rows.set(key, { id: 1, amount: input.amount, businessDate: input.businessDate, reason: input.reason, note: input.note, cancelledAt: null });
  }
  async updateAdjustment(id: number, input: { sourceType: string; sourceKey: string; amount: number; businessDate: string; reason: string; note: string }) {
    this.updates++;
    this.rows.set(`${input.sourceType}:${input.sourceKey}`, { id, amount: input.amount, businessDate: input.businessDate, reason: input.reason, note: input.note, cancelledAt: null });
  }
}

test("automatic adjustment is idempotent, refreshes unpaid drift, and respects paid lock", async () => {
  const repository = new MemoryRepository();
  const first = calculateQuyenMenuSalesIncentive("2026-09", [menuItem("C5", 8, 1_200_000)]);
  assert.equal((await syncQuyenMenuSalesIncentive({ calculation: first, repository })).status, "created");
  assert.equal((await syncQuyenMenuSalesIncentive({ calculation: first, repository })).status, "unchanged");
  assert.equal(repository.rows.size, 1);
  assert.equal(repository.creates, 1);
  assert.deepEqual(repository.resolved.slice(0, 2), [["quyen", false], ["pos", true]]);

  const changed = calculateQuyenMenuSalesIncentive("2026-09", [menuItem("C5", 9, 1_300_000)]);
  assert.equal((await syncQuyenMenuSalesIncentive({ calculation: changed, repository })).status, "updated");
  assert.equal(repository.updates, 1);
  repository.paid = true;
  const later = calculateQuyenMenuSalesIncentive("2026-09", [menuItem("C5", 10, 1_400_000)]);
  assert.equal((await syncQuyenMenuSalesIncentive({ calculation: later, repository })).status, "locked");
  assert.equal(repository.updates, 1);
});

test("zero sales creates no adjustment", async () => {
  const repository = new MemoryRepository();
  const calculation = calculateQuyenMenuSalesIncentive("2026-09", []);
  assert.equal((await syncQuyenMenuSalesIncentive({ calculation, repository })).status, "no_sales");
  assert.equal(repository.rows.size, 0);
  assert.equal(repository.creates, 0);
});

test("manual and automatic sales incentives are classified separately but both affect payout", () => {
  const rows = [
    { kind: "incentive" as const, amount: 100_000, sourceType: "manual" },
    { kind: "incentive" as const, amount: 174_600, sourceType: "sales_menu_incentive" },
    { kind: "penalty" as const, amount: 20_000, sourceType: "manual" },
  ];
  const manual = calculateManualAdjustmentTotals(rows);
  const automatic = calculateSalesMenuIncentiveTotals(rows);
  assert.equal(manual.manualIncentiveAmount, 100_000);
  assert.equal(manual.manualPenaltyAmount, 20_000);
  assert.equal(automatic.salesMenuIncentiveAmount, 174_600);
  const payout = calculatePayrollPayoutAmounts({ automaticPreInsuranceAmount: 1_000_000, manualIncentiveAmount: manual.manualIncentiveAmount + automatic.salesMenuIncentiveAmount, manualPenaltyAmount: manual.manualPenaltyAmount, employeeInsuranceDeductionAmount: 50_000, employeePitDeductionAmount: 10_000, advanceAmount: 0 });
  assert.equal(payout.preInsurancePayoutAmount, 1_254_600);
  assert.equal(payout.netPayoutAmount, 1_194_600);
});

test("monthly API, payroll overview, readonly KO/VI UI, cron, and schema source contract are wired", () => {
  const monthly = read("app/api/admin/sales/monthly/route.ts");
  const overviewServer = read("lib/payroll/overview-server.ts");
  const overview = read("lib/payroll/overview.ts");
  const card = read("components/payroll/CompensationCard.tsx");
  const adjustmentRoute = read("app/api/admin/payroll/adjustments/route.ts");
  const migration = read("supabase/migrations/202609240001_allow_payroll_sales_menu_incentive_source.sql");
  const crons = JSON.parse(read("vercel.json")).crons as Array<{ path: string; schedule: string }>;
  assert.match(monthly, /import \{ buildMenuSales \} from "@\/lib\/sales\/menu-sales"/);
  assert.doesNotMatch(monthly, /function buildMenuSales/);
  assert.match(overviewServer, /source_type,source_key/);
  assert.match(overview, /payrollAdjustmentIncentiveAmount=manualIncentiveAmount\+salesMenuIncentiveAmount/);
  assert.match(overview, /calculateAccountingTaxableCompensationAmount\(\{preInsurancePayoutAmount/);
  assert.match(card, /자동 판매 인센티브/);
  assert.match(card, /Thưởng doanh số menu tự động/);
  assert.match(card, /!automaticSales && <button/);
  assert.match(adjustmentRoute, /\.eq\("source_type","manual"\)/);
  assert.match(migration, /source_type in \('manual', 'sales_menu_incentive'\)/);
  assert.deepEqual(crons.find((cron) => cron.path === "/api/cron/payroll-quyen-menu-incentive"), { path: "/api/cron/payroll-quyen-menu-incentive", schedule: "15 20 * * *" });
});
