import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildLedgerEntries } from "../lib/ledger/entries.ts";
import { findInventoryLedgerFocus, parseInventoryLedgerFocus } from "../lib/ledger/inventory-entry-focus.ts";

const snapshot = (id: number, amount: number, category: string) => ({
  inventory_log_id: id, item_id: id === 13561 ? 620 : 621, item_name: `품목${id}`, category, unit: "ea",
  change_quantity: 1, purchase_price: amount, purchase_amount: amount, supplier: "Unspecified Mart",
});
// Production-shaped rows: pending candidates 1900/1901 of partner #33 plus an unrelated posted receipt.
const candidates = [
  { id: 1900, business_date: "2026-10-19", proposed_amount: 270000, proposed_category_id: 31, proposed_party_id: 33, source_key: "inventory-log:13561", source_snapshot: snapshot(13561, 270000, "가공식품"), category: { name: "가공식품" }, party: { name: "Unspecified Mart" } },
  { id: 1901, business_date: "2026-10-19", proposed_amount: 65000, proposed_category_id: 31, proposed_party_id: 33, source_key: "inventory-log:13563", source_snapshot: snapshot(13563, 65000, "가공식품"), category: { name: "가공식품" }, party: { name: "Unspecified Mart" } },
];
const transactions = [{
  id: 2944, type: "expense", status: "confirmed", business_date: "2026-10-18", amount: 900000, party_id: 7,
  source_type: "inventory_purchase_candidate", source_key: "candidate:1899", source_snapshot: snapshot(13626, 900000, "Decor"),
  category: { id: 66, name: "기타 재고매입" }, party: { name: "Shopee" }, movements: [],
  payable: { id: 1397, original_amount: 900000, due_date: null, status: "unpaid", allocations: [] },
}];
const partnerDefaults = new Map([[33, { paymentMode: "unspecified" as const, defaultFundAccountId: null, defaultFundAccountName: null }]]);
const params = (query: string) => new URLSearchParams(query);

test("ledger focus parameters must name the same receipt; malformed links are ignored", () => {
  assert.deepEqual(parseInventoryLedgerFocus(params("month=2026-10&inventoryLogId=13561&sourceKey=inventory-log%3A13561")), { logId: 13561, sourceKey: "inventory-log:13561" });
  assert.deepEqual(parseInventoryLedgerFocus(params("inventoryLogId=13563")), { logId: 13563, sourceKey: "inventory-log:13563" });
  for (const query of ["inventoryLogId=13561&sourceKey=inventory-log%3A13563", "inventoryLogId=0", "inventoryLogId=-1", "inventoryLogId=1e3", "inventoryLogId=abc", "month=2026-10"])
    assert.equal(parseInventoryLedgerFocus(params(query)), null, query);
});

test("focus opens the exact pending candidate of 13561/13563 within the shared partner group, and posted receipts by snapshot id", () => {
  const entries = buildLedgerEntries(transactions, candidates, partnerDefaults, [], "2026-10");
  const first = findInventoryLedgerFocus(entries, { logId: 13561, sourceKey: "inventory-log:13561" });
  const second = findInventoryLedgerFocus(entries, { logId: 13563, sourceKey: "inventory-log:13563" });
  assert.equal(first?.entry.status, "pending"); assert.equal(first?.entry.id, second?.entry.id);
  assert.equal(first?.itemKey, "1900"); assert.equal(second?.itemKey, "1901");
  assert.equal(first?.item.amount, 270000); assert.equal(second?.item.amount, 65000);
  const posted = findInventoryLedgerFocus(entries, { logId: 13626, sourceKey: "inventory-log:13626" });
  assert.equal(posted?.entry.status, "confirmed"); assert.equal(posted?.itemKey, "2944");
  assert.equal(findInventoryLedgerFocus(entries, { logId: 99999, sourceKey: "inventory-log:99999" }), null);
});

test("Ledger focus and receipt status notices survive sync banner retirement", () => {
 const page=readFileSync("app/(protected)/inventory/snapshots/page.tsx","utf8");
 assert.doesNotMatch(page,/MonthlyNameSyncPanel|InventoryDailySyncResults/);
 assert.match(page,/setReceiptEditNotice/);
 assert.match(page,/ledgerSyncNotice/);
 assert.match(page,/장부는 아직 완료되지 않아 관리자 확인이 필요합니다/);
 const ledger=readFileSync("app/(protected)/admin/ledger/entries/page.tsx","utf8");
 assert.match(ledger,/parseInventoryLedgerFocus\(searchParams\)/);
 assert.match(ledger,/inventory-projection-row-/);
});
