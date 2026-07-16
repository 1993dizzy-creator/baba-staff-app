import assert from "node:assert/strict";
import test from "node:test";
// Node's built-in TypeScript runner requires the source extension; the app compiler
// intentionally keeps allowImportingTsExtensions disabled.
// @ts-expect-error test-runner-only TypeScript extension
import { calculateReceiptFinancials, parseVndInteger } from "../lib/sales/receipt-financials.ts";

const lines = [{ finalAmount: 10_470_000, taxRate: 10 }];

test("VAT apply separates calculated and applied VAT", () => {
  assert.deepEqual(
    calculateReceiptFinancials({ lines, taxMode: "apply", originalTaxAmount: 900_000 }),
    {
      totalAmount: 10_470_000,
      calculatedVatAmount: 1_047_000,
      calculatedFinalAmount: 11_517_000,
      finalAmountOverride: null,
      finalAmount: 11_517_000,
      appliedVatAmount: 900_000,
      manualAdjustmentAmount: 0,
    }
  );
});

test("VAT exclude and positive/negative overrides", () => {
  const excluded = calculateReceiptFinancials({
    lines,
    taxMode: "exclude_all",
    originalTaxAmount: 900_000,
    finalAmountOverride: 10_000_000,
  });
  assert.equal(excluded.calculatedVatAmount, 0);
  assert.equal(excluded.appliedVatAmount, 0);
  assert.equal(excluded.manualAdjustmentAmount, -470_000);

  const increased = calculateReceiptFinancials({
    lines,
    taxMode: "apply",
    originalTaxAmount: 900_000,
    finalAmountOverride: 12_000_000,
  });
  assert.equal(increased.manualAdjustmentAmount, 483_000);
});

test("normal total clears override and VND parser rejects invalid values", () => {
  assert.equal(
    calculateReceiptFinancials({
      lines,
      taxMode: "apply",
      originalTaxAmount: 900_000,
      finalAmountOverride: 11_517_000,
    }).finalAmountOverride,
    null
  );
  assert.equal(parseVndInteger(0), 0);
  assert.equal(parseVndInteger("1000"), 1000);
  assert.equal(parseVndInteger(-1), undefined);
  assert.equal(parseVndInteger(1.5), undefined);
  assert.equal(parseVndInteger("bad"), undefined);
  assert.equal(parseVndInteger(1_000_000_000_000), undefined);
});
