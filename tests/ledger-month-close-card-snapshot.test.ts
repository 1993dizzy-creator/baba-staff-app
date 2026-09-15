import assert from "node:assert/strict";
import test from "node:test";
import { calculateMonthCloseCardSnapshot } from "../lib/ledger/month-close-card.ts";

const sale = (id: number, amount: number) => ({ id, amount });
const reconciliation = (
  id: number,
  status: string,
  depositAmount: number,
  matchedGross: number,
  difference: number
) => ({
  id,
  status,
  deposit_amount: depositAmount,
  matched_gross_amount: matchedGross,
  difference_amount: difference,
});
const line = (saleId: number, amount: number, depositDate: string, status = "matched") => ({
  pos_card_transaction_id: saleId,
  allocated_gross_amount: amount,
  reconciliation: { deposit_date: depositDate, status },
});

test("August deposit confirmed in September is included in the August matched snapshot", () => {
  const result = calculateMonthCloseCardSnapshot(
    [reconciliation(1, "matched", 980, 1_000, 20)],
    [line(10, 1_000, "2026-08-20")],
    [sale(10, 1_000)],
    "2026-09-01"
  );

  assert.deepEqual(result, {
    unsettledGross: 0,
    unmatchedDeposits: 0,
    completedGross: 1_000,
    settlementDifference: 20,
  });
});

test("September deposit allocation is excluded from August and included in September", () => {
  const septemberLine = line(10, 1_000, "2026-09-05");
  const august = calculateMonthCloseCardSnapshot([], [septemberLine], [sale(10, 1_000)], "2026-09-01");
  const september = calculateMonthCloseCardSnapshot(
    [reconciliation(2, "matched", 980, 1_000, 20)],
    [septemberLine],
    [sale(10, 1_000)],
    "2026-10-01"
  );

  assert.equal(august.unsettledGross, 1_000);
  assert.deepEqual(september, {
    unsettledGross: 0,
    unmatchedDeposits: 0,
    completedGross: 1_000,
    settlementDifference: 20,
  });
});

test("cancelled reconciliation and its allocation remain excluded", () => {
  const result = calculateMonthCloseCardSnapshot(
    [reconciliation(3, "cancelled", 980, 1_000, 20)],
    [line(10, 1_000, "2026-08-20", "cancelled")],
    [sale(10, 1_000)],
    "2026-09-01"
  );

  assert.deepEqual(result, {
    unsettledGross: 1_000,
    unmatchedDeposits: 0,
    completedGross: 0,
    settlementDifference: 0,
  });
});
