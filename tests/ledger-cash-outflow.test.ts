import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { computeActualCashOutflow } = require("../lib/ledger/cash-outflow.ts") as typeof import("../lib/ledger/cash-outflow");
const { computeReceivedIncome } = require("../lib/ledger/summary.ts") as typeof import("../lib/ledger/summary");
type CashOutflowTransaction = import("../lib/ledger/cash-outflow").CashOutflowTransaction;

const businessFunds = new Set([1, 2]);
const payment = (type: string, amount: number, businessDate = "2026-09-10", overrides: Partial<CashOutflowTransaction> = {}): CashOutflowTransaction => ({
  type,
  status: "confirmed",
  business_date: businessDate,
  source_type: "manual",
  movements: [{ amount: -amount, fund_account: { id: 1 } }],
  ...overrides,
});

test("legacy month uses its sheet cash outflow snapshot as the authoritative value", () => {
  const rows = [
    payment("expense", 10, "2026-08-03"),
    payment("balance_adjustment", 0, "2026-08-31", {
      source_key: "legacy_sheet_expense_reconciliation:2026-08",
      source_snapshot: { sheetCashOutflow: 778_924_465 },
    }),
  ];
  assert.equal(computeActualCashOutflow(rows, businessFunds, "2026-08"), 778_924_465);
});

test("normal month sums external net outflow of business funds in the payment month", () => {
  const rows = [
    payment("expense", 10),
    payment("payable_payment", 20, "2026-09-05"),
    payment("payroll_payment", 30),
    payment("prepaid_expense_payment", 40),
    payment("owner_settlement_payment", 50),
    payment("payable_payment", 100, "2026-08-31"),
    payment("payable_payment", 100, "2026-10-01"),
    payment("expense", 100, "2026-09-10", { status: "draft" }),
    payment("expense", 100, "2026-09-10", { movements: [{ amount: -100, fund_account: { id: 3 } }] }),
  ];
  assert.equal(computeActualCashOutflow(rows, businessFunds, "2026-09"), 100);
  assert.equal(computeActualCashOutflow(rows, businessFunds, "2026-08"), 100);
});

test("inventory purchase reversal offsets the erroneous expense before the rebook", () => {
  const rows = [
    payment("expense", 7_816_475_000, "2026-09-14", { source_type: "inventory_purchase" }),
    payment("expense", 7_816_475_000, "2026-09-14", {
      source_type: "inventory_purchase_reversal",
      movements: [{ amount: 7_816_475_000, fund_account: { id: 1 } }],
    }),
    payment("expense", 5_993_300, "2026-09-14", { source_type: "inventory_purchase_rebook" }),
  ];
  assert.equal(computeActualCashOutflow(rows, businessFunds, "2026-09"), 5_993_300);
});

test("same-month refunds reduce net cash outflow without adding internal transfers", () => {
  const rows = [
    payment("expense", 100),
    payment("expense", 30, "2026-09-10", { source_type: "supplier_refund", movements: [{ amount: 30, fund_account: { id: 1 } }] }),
    payment("transfer", 900),
    payment("balance_adjustment", 800),
  ];
  assert.equal(computeActualCashOutflow(rows, businessFunds, "2026-09"), 70);
});

test("internal transfers, investments, adjustments, corrections and technical reversals are excluded", () => {
  const rows = [
    payment("transfer", 10),
    payment("investment", 20),
    payment("balance_adjustment", 30),
    payment("expense", 40, "2026-09-10", { movements: [{ amount: -40, fund_account: { id: 1 } }, { amount: 40, fund_account: { id: 2 } }] }),
    payment("expense", 50, "2026-09-10", { source_type: "ledger_correction" }),
    payment("expense", 60, "2026-09-10", { source_type: "technical_adjustment_reversal" }),
    payment("expense", 70, "2026-09-10", { memo: "월말잔액 맞춤" }),
    payment("expense", 80, "2026-09-10", { memo: "상세 전환 상쇄" }),
    payment("expense", 90, "2026-09-10", { memo: "기술적 보정" }),
    payment("card_settlement_deposit", -100),
  ];
  assert.equal(computeActualCashOutflow(rows, businessFunds, "2026-09"), 0);
});

test("September operating cash outflow excludes 130M of capital recovery and includes actual operating payments", () => {
  const recoveries = [
    payment("owner_settlement_payment", 35_000_000, "2026-09-10"),
    payment("owner_settlement_payment", 30_000_000, "2026-09-17"),
    payment("owner_settlement_payment", 60_000_000, "2026-09-19"),
    payment("balance_adjustment", 5_000_000, "2026-09-17", {
      source_key: "owner-capital-recovery:2026-09-17:han-vuong",
    }),
  ];
  const operatingAdjustments = [
    payment("balance_adjustment", 182_400, "2026-09-02", {
      source_key: "historical-payable-bridge:2026-09-02:trung-dong:182400",
    }),
    payment("balance_adjustment", 940_516, "2026-09-10", {
      source_key: "historical-payable-bridge:2026-09-10:ok-mart:940516",
    }),
    payment("balance_adjustment", 24_464_000, "2026-09-02", {
      source_key: "sheet-balance-adjustment:2026-09-02:craft-beer:24464000",
    }),
    payment("balance_adjustment", 16_940_000, "2026-09-17", {
      source_key: "sheet-balance-adjustment:2026-09-17:craft-beer:16940000",
    }),
  ];
  const mealCorrections = [
    payment("expense", 240_000, "2026-09-19", {
      source_type: "ledger_correction",
      source_snapshot: { adjustmentType: "employee_meal", originalTransactionId: 1700 },
      memo: "직원 식대 추가지급",
    }),
  ];
  const excludedAdjustments = [
    payment("balance_adjustment", -30_000, "2026-09-17", {
      source_key: "sheet-balance-adjustment:2026-09-17:cho-pos:30000",
    }),
    payment("balance_adjustment", 50_000, "2026-09-19", {
      source_key: "sheet-balance-adjustment:2026-09-19:technical-reversal:50000",
      memo: "기술적 보정",
    }),
  ];

  assert.equal(computeActualCashOutflow(recoveries, businessFunds, "2026-09"), 0);
  assert.equal(computeActualCashOutflow(operatingAdjustments, businessFunds, "2026-09"), 42_526_916);
  assert.equal(computeActualCashOutflow(mealCorrections, businessFunds, "2026-09"), 240_000);
  assert.equal(computeActualCashOutflow(excludedAdjustments, businessFunds, "2026-09"), 0);
  assert.equal(computeActualCashOutflow([
    ...recoveries, ...operatingAdjustments, ...mealCorrections, ...excludedAdjustments,
  ], businessFunds, "2026-09"), 42_766_916);
});

test("only evidenced operating adjustments and corrections with business-fund outflow count", () => {
  const rows = [
    payment("balance_adjustment", 50, "2026-09-10", {
      source_key: "sheet-balance-adjustment:operating",
      movements: [{ amount: -50, fund_account: { id: 3 } }],
    }),
    payment("balance_adjustment", 60, "2026-09-10", {
      source_key: "historical-payable-bridge:internal",
      movements: [{ amount: -60, fund_account: { id: 1 } }, { amount: 60, fund_account: { id: 2 } }],
    }),
    payment("balance_adjustment", 70, "2026-09-10", {
      source_key: "sheet-balance-adjustment:technical-rebook",
      memo: "rebook",
    }),
    payment("expense", 80, "2026-09-10", {
      source_type: "ledger_correction",
      source_snapshot: { adjustmentType: "employee_meal" },
      movements: [{ amount: 80, fund_account: { id: 1 } }],
    }),
    payment("expense", 90, "2026-09-10", {
      source_type: "ledger_correction",
      source_snapshot: { economicDelta: 90, movementAdjustments: [{ fundAccountId: 1, signedAmount: -90 }] },
      memo: "기술적 보정",
    }),
    payment("expense", 100, "2026-09-10", { source_type: "ledger_correction" }),
    payment("expense", 110, "2026-09-10", {
      source_type: "ledger_correction",
      source_snapshot: { economicDelta: 110, movementAdjustments: [{ fundAccountId: 1, signedAmount: -110 }] },
    }),
    payment("expense", 120, "2026-09-10", {
      source_type: "ledger_correction",
      source_snapshot: { economicDelta: 120, movementAdjustments: [{ fundAccountId: 1, signedAmount: -120 }] },
      memo: "reversal of accounting entry",
    }),
    payment("expense", 130, "2026-09-10", {
      source_type: "ledger_correction",
      source_snapshot: { adjustmentType: "technical_reversal", economicDelta: 130, movementAdjustments: [{ fundAccountId: 1, signedAmount: -130 }] },
    }),
  ];
  assert.equal(computeActualCashOutflow(rows, businessFunds, "2026-09"), 110);
});

test("card clearing and settlement difference do not add a second cash outflow", () => {
  const rows = [
    payment("expense", 100, "2026-09-10", { movements: [{ amount: -100, fund_account: { id: 3 } }] }),
    payment("expense_recognition", 4_338_130, "2026-09-10", { source_type: "card_settlement_difference" }),
    payment("payable_payment", 25),
  ];
  assert.equal(computeActualCashOutflow(rows, businessFunds, "2026-09"), 25);
});

test("August reference amounts reconcile opening cash to closing cash", () => {
  const salesIncome = 734_634_810;
  const otherIncome = 51_743;
  const actualCardDeposits = 197_348_230;
  const receivedIncome = computeReceivedIncome(salesIncome + otherIncome, 225_925_720, actualCardDeposits);
  const cashOutflow = computeActualCashOutflow([
    payment("balance_adjustment", 0, "2026-08-31", {
      source_key: "legacy_sheet_expense_reconciliation:2026-08",
      source_snapshot: { sheetCashOutflow: 778_924_465 },
    }),
  ], businessFunds, "2026-08");
  const cardSettlementDifference = 4_338_130;
  assert.equal(receivedIncome, 706_109_063);
  const actualSalesDeposits = receivedIncome - otherIncome;
  assert.equal(actualSalesDeposits, 706_057_320);
  assert.equal(cashOutflow, 778_924_465);
  assert.equal(cardSettlementDifference, 4_338_130);
  assert.equal(300_353_642 + actualSalesDeposits + otherIncome + 100_000_000 - cashOutflow, 327_538_240);
});

test("ledger route exposes cash outflow alongside unchanged accounting summary fields", () => {
  const route = readFileSync("app/api/admin/ledger/route.ts", "utf8");
  assert.match(route, /const actualCashOutflow = computeActualCashOutflow\(transactions, businessFundAccountIds, month\)/);
  assert.match(route, /const displayedExpense = computeDisplayedExpense\(paidExpense, transactions\)/);
  assert.match(route, /operatingProfit: recognizedIncome - expense, paidExpense, displayedExpense, actualCashOutflow, cardSettlementDifference/);
  assert.match(route, /const receivedIncome = computeReceivedIncome\(recognizedIncome, cardGrossSales, actualCardDeposits\)/);
});
