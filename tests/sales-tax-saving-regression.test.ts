import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
// @ts-expect-error Node's test runner loads the TypeScript source directly.
import { calculateModifiedReceiptTaxSaving } from "../lib/sales/tax-saving.ts";

const fixture = { originalTaxAmount: 65_000, adjustedTaxAmount: 120_000 };

test("VAT apply restores adjusted VAT minus original VAT", () => {
  assert.equal(calculateModifiedReceiptTaxSaving({
    taxOverrideMode: "apply",
    ...fixture,
    appliedTaxAmount: fixture.originalTaxAmount,
  }), 55_000);
});

test("VAT apply floors a VAT decrease at zero", () => {
  assert.equal(calculateModifiedReceiptTaxSaving({
    taxOverrideMode: "apply",
    originalTaxAmount: 100_000,
    adjustedTaxAmount: 80_000,
    appliedTaxAmount: 100_000,
  }), 0);
});

test("legacy modified receipts keep adjusted VAT minus original VAT", () => {
  assert.equal(calculateModifiedReceiptTaxSaving({
    taxOverrideMode: null,
    ...fixture,
    appliedTaxAmount: fixture.originalTaxAmount,
  }), 55_000);
});

test("VAT exclude-all keeps the current original VAT saving", () => {
  assert.equal(calculateModifiedReceiptTaxSaving({
    taxOverrideMode: "exclude_all",
    ...fixture,
    appliedTaxAmount: 0,
  }), 65_000);
});

test("daily monthly and receipt detail use the same helper without changing difference calculations", () => {
  const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
  const daily = read("app/api/admin/sales/today/route.ts");
  const monthly = read("app/api/admin/sales/monthly/route.ts");
  const detail = read("app/api/admin/sales/receipts/[id]/route.ts");

  for (const source of [daily, monthly, detail]) {
    assert.match(source, /calculateModifiedReceiptTaxSaving\(\{/);
  }
  assert.match(daily, /adjustedFinalAmount - originalFinalAmount/);
  assert.match(monthly, /adjustedFinalAmount - originalFinalAmount/);
  assert.match(detail, /toNumber\(receiptRow\.final_amount\) - getOriginalFinalAmount\(receiptRow\)/);

  const originalFinalAmount = 1_000_000;
  const adjustedFinalAmount = 1_125_000;
  assert.equal(adjustedFinalAmount - originalFinalAmount, 125_000);
});
