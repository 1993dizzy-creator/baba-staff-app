import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node strips TypeScript extensions in tests.
import { buildPaymentVerificationItems, isPaymentVerification } from "../lib/ledger/payment-verification.ts";
// @ts-expect-error Node strips TypeScript extensions in tests.
import { calculatePayableBalances } from "../lib/ledger/payables.ts";
// @ts-expect-error Node strips TypeScript extensions in tests.
import { computeActualCashOutflow } from "../lib/ledger/cash-outflow.ts";
// @ts-expect-error Node strips TypeScript extensions in tests.
import { calculateMonthCloseOperatingSummary } from "../lib/ledger/month-close-operating.ts";

const receipt = (pending = true) => ({
  id: 1, party_id: 10, original_amount: 1_900_000, status: "unpaid",
  party: { name: "Chợ" }, expense: { id: 11, business_date: "2026-08-29", status: "confirmed",
    source_snapshot: { item_name: "켄트 담배", supplier: "Chợ", change_quantity: 50, purchase_price: 38_000, ...(pending ? { paymentVerification: "pending" } : {}) } },
});
const payment = (date: string) => ({ payable_id: 1, allocated_amount: 1_900_000, payment: { business_date: date, status: "confirmed" } });

test("receipt with no linked payment remains verification pending and separate from ordinary partner debt", () => {
  const source = receipt();
  const result = buildPaymentVerificationItems([source], []);
  assert.equal(result.totalPending, 1_900_000);
  assert.equal(result.pendingCount, 1);
  assert.equal(result.items[0].itemName, "켄트 담배");
  assert.equal(result.items[0].quantity, 50);
  assert.equal(result.items[0].unitPrice, 38_000);
  assert.equal(calculatePayableBalances([source].filter(row => !isPaymentVerification(row)), []).totalOutstanding, 0);
});

test("same-day confirmed payment clears verification; ordinary payable never appears twice", () => {
  const settled = buildPaymentVerificationItems([receipt()], [payment("2026-08-29")]);
  assert.equal(settled.pendingCount, 0);
  assert.equal(settled.items[0].appPaymentStatus, "confirmed");
  assert.equal(settled.items[0].paymentDate, "2026-08-29");
  const ordinary = receipt(false);
  assert.equal(buildPaymentVerificationItems([ordinary], []).items.length, 0);
  assert.equal(calculatePayableBalances([ordinary], []).totalOutstanding, 1_900_000);
});

test("next-month linked payment retains August expense and creates September outflow only", () => {
  const source = receipt();
  const before = buildPaymentVerificationItems([source], []);
  const after = buildPaymentVerificationItems([source], [payment("2026-09-04")]);
  assert.equal(before.totalPending, 1_900_000);
  assert.equal(after.totalPending, 0);
  assert.equal(after.items[0].paymentDate, "2026-09-04");
  const expense = { type: "expense", source_type: "inventory_purchase_candidate", source_key: "candidate:1", amount: 1_900_000, economic_effect_sign: 1, category: { name: "재고" } };
  const august = calculateMonthCloseOperatingSummary("2026-08", [expense], []);
  const september = calculateMonthCloseOperatingSummary("2026-09", [], []);
  assert.equal(august.expense.total, 1_900_000);
  assert.equal(september.expense.total, 0);
  const movements = [
    { type: "expense", status: "confirmed", business_date: "2026-08-29", source_type: "inventory_purchase_candidate", movements: [] },
    { type: "payable_payment", status: "confirmed", business_date: "2026-09-04", source_type: "manual", movements: [{ amount: -1_900_000, fund_account: { id: 4 } }] },
  ];
  assert.equal(computeActualCashOutflow(movements, new Set([4]), "2026-08"), 0);
  assert.equal(computeActualCashOutflow(movements, new Set([4]), "2026-09"), 1_900_000);
});
