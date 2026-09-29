import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const { buildLedgerEntries } = createRequire(import.meta.url)("../lib/ledger/entries.ts") as typeof import("../lib/ledger/entries");
const page = readFileSync("app/(protected)/admin/ledger/entries/page.tsx", "utf8");

test("outing pork remains a manual cash expense with its display title, memo and Chợ party", () => {
  const [entry] = buildLedgerEntries([{
    id: 1767, type: "expense", status: "confirmed", source_type: "manual",
    business_date: "2026-09-06", amount: 515_000, memo: "7~8일 직원 야유회용 시장 구매",
    display_snapshot: { titleOverride: "야유회 돼지고기 구입" },
    party_id: 7, party: { name: "Chợ" }, category: { name: "복리후생" },
    movements: [{ amount: -515_000, fund_account: { display_name: "매장 현금" } }],
  }], [], new Map());
  assert.equal(entry.title, "야유회 돼지고기 구입");
  assert.equal(entry.memo, "7~8일 직원 야유회용 시장 구매");
  assert.equal(entry.partyId, 7);
  assert.equal(entry.categoryName, "복리후생");
  assert.equal(entry.accountName, "매장 현금");
  assert.equal(entry.amount, 515_000);
  assert.equal(entry.businessDate, "2026-09-06");
  assert.equal(entry.drilldown, "generic");
});

const original = {
  id: 1768, type: "expense", status: "confirmed", source_type: "manual",
  business_date: "2026-09-06", amount: 3_555_000, economic_effect_sign: 1,
  memo: "양주 매입", category: { name: "주류 매입" },
};
const reversal = {
  id: 1969, type: "expense", status: "confirmed", source_type: "ledger_correction",
  correction_of_id: 1768, business_date: "2026-09-06", amount: 3_555_000,
  economic_effect_sign: -1,
};
const payment = {
  id: 1970, type: "payable_payment", status: "confirmed", source_type: "payable_payment",
  business_date: "2026-09-06", amount: 3_555_000, party: { name: "Kim Dung Hàng Buồm" },
};

test("fully reversed #1768 and #1969 stay out of the daily list while actual payment #1970 stays", () => {
  const entries = buildLedgerEntries([original, reversal, payment], [], new Map());
  assert.deepEqual(entries.map(entry => entry.transactionId), [1970]);
  assert.equal(entries[0].paymentTransaction, true);
  assert.equal(entries[0].amount, 3_555_000);
});

test("partial, unconfirmed and unrelated corrections do not hide the original", () => {
  for (const correction of [
    { ...reversal, amount: 1_000_000 },
    { ...reversal, status: "cancelled" },
    { ...reversal, source_type: "inventory_purchase_reversal" },
  ]) {
    const entries = buildLedgerEntries([original, correction, payment], [], new Map());
    assert.ok(entries.some(entry => entry.transactionId === 1768));
    assert.ok(entries.some(entry => entry.transactionId === 1970));
  }
});

test("current supplier name displays for confirmed Shopee and unmapped Tiktok inventory", () => {
  const inventory = (id: number, supplier: string | null, currentSupplier?: string) => ({
    id, type: "expense", status: "confirmed", source_type: "inventory_purchase_candidate",
    business_date: "2026-09-06", amount: id === 10 ? 153_000 : 159_000,
    party_id: null, source_snapshot: { inventory_log_id: id, item_name: id === 10 ? "Giấy thấm dầu 15*15" : "Loa bếp", supplier },
    ...(currentSupplier === undefined ? {} : { display_snapshot: { supplier: currentSupplier } }),
    movements: [{ amount: -159_000, fund_account: { display_name: "매장 현금" } }],
  });
  const entries = buildLedgerEntries([
    inventory(10, null, "Shopee"), inventory(11, "Tiktok"), inventory(12, null),
  ], [], new Map());
  const shopee = entries.find(entry => entry.title === "Shopee");
  const tiktok = entries.find(entry => entry.title === "Tiktok");
  const missing = entries.find(entry => entry.title === "");
  assert.equal(shopee?.amount, 153_000);
  assert.equal(shopee?.items.length, 1);
  assert.equal(tiktok?.amount, 159_000);
  assert.equal(tiktok?.items.length, 1);
  assert.equal(tiktok?.partyId, null);
  assert.equal(missing?.systemDisplay?.kind, "inventory");
  assert.match(page, /display\.partyMissing && !entry\.title\.trim\(\)/);
});