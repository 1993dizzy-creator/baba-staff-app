import assert from "node:assert/strict";
import test from "node:test";
import {
  getReceiptContentFingerprintCanonical,
  type ReceiptContentFingerprintInput,
  type ReceiptContentFingerprintLineInput,
} from "../lib/sales/inventory-deduction-fingerprint-core";

function line(
  overrides: Partial<ReceiptContentFingerprintLineInput> = {}
): ReceiptContentFingerprintLineInput {
  return {
    itemId: "product-1",
    itemCode: "P1",
    optionIdentity: null,
    refDetailId: "line-1",
    parentRefDetailId: null,
    quantity: 1,
    isOption: false,
    isExcluded: false,
    isCanceled: false,
    refDetailType: 1,
    inventoryItemType: 1,
    ...overrides,
  };
}

function receipt(
  lines: ReceiptContentFingerprintLineInput[]
): ReceiptContentFingerprintInput {
  return {
    receiptId: 10,
    refId: "receipt-10",
    source: "cukcuk",
    paymentStatus: 3,
    isCanceled: false,
    lines,
  };
}

test("line and DB query order do not change the canonical fingerprint", () => {
  const first = line();
  const second = line({ refDetailId: "line-2", itemId: "product-2" });
  assert.equal(
    getReceiptContentFingerprintCanonical(receipt([first, second])),
    getReceiptContentFingerprintCanonical(receipt([second, first]))
  );
});

test("integer and decimal quantity representations normalize equally", () => {
  assert.equal(
    getReceiptContentFingerprintCanonical(receipt([line({ quantity: 1 })])),
    getReceiptContentFingerprintCanonical(receipt([line({ quantity: "1.0" })]))
  );
});

test("quantity, option identity, parent relation, exclusion and cancellation affect it", () => {
  const baseline = getReceiptContentFingerprintCanonical(receipt([line()]));
  for (const changed of [
    line({ quantity: 2 }),
    line({ optionIdentity: "option-2", isOption: true }),
    line({ parentRefDetailId: "parent-2" }),
    line({ isExcluded: true }),
    line({ isCanceled: true }),
  ]) {
    assert.notEqual(
      getReceiptContentFingerprintCanonical(receipt([changed])),
      baseline
    );
  }
});

test("duplicate products on separate receipt lines remain distinguishable", () => {
  const oneLine = receipt([line()]);
  const twoLines = receipt([line(), line({ refDetailId: "line-2" })]);
  assert.notEqual(
    getReceiptContentFingerprintCanonical(oneLine),
    getReceiptContentFingerprintCanonical(twoLines)
  );
});

test("amount, VAT, payment and memo fields are intentionally ignored", () => {
  const baseline = receipt([line()]);
  const commercialOnlyChange = {
    ...baseline,
    totalAmount: 999_000,
    vatAmount: 99_000,
    paymentMethod: "cash",
    memo: "changed",
  };
  assert.equal(
    getReceiptContentFingerprintCanonical(baseline),
    getReceiptContentFingerprintCanonical(commercialOnlyChange)
  );
});

test("T-code option container relation and selected option identity are preserved", () => {
  const parent = line({ refDetailId: "t-parent", itemId: "T-CODE" });
  const option = line({
    refDetailId: "t-option",
    parentRefDetailId: "t-parent",
    itemId: null,
    itemCode: "OPTION",
    optionIdentity: "addition-1",
    isOption: true,
    refDetailType: 2,
  });
  const changedOption = { ...option, optionIdentity: "addition-2" };
  assert.notEqual(
    getReceiptContentFingerprintCanonical(receipt([parent, option])),
    getReceiptContentFingerprintCanonical(receipt([parent, changedOption]))
  );
});
