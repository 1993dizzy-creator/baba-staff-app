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
  assert.equal(computeActualCashOutflow(rows, businessFunds, "2026-09"), 150);
  assert.equal(computeActualCashOutflow(rows, businessFunds, "2026-08"), 100);
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
