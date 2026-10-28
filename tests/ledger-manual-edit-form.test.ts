import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
// @ts-expect-error Node's local strip-types test runner requires the extension.
import { manualBusinessDate, manualFormChanges, manualFormFromSource, manualFormMessage, vietnamDateTime, type ManualEditSource } from "../lib/ledger/manual-transaction-form.ts";
// @ts-expect-error Node's local strip-types test runner requires the extension.
import { parseManualTransactionCancel, parseManualTransactionUpdate } from "../lib/ledger/manual-transaction-request.ts";
// @ts-expect-error Node's local strip-types test runner requires the extension.
import { buildLedgerEntries, type TransactionRow } from "../lib/ledger/entries.ts";

// TX#2415 as stored (read only, 2026-10-28) after linking THỦY NAM (#35 ↔ business partner 34).
const CASH = { id: 1, code: "store_cash", display_name: "매장 현금" };
const BANK = { id: 2, code: "baba_corporate_bank", display_name: "BABA 법인계좌" };
const tx2415: TransactionRow = {
  id: 2415, type: "expense", status: "confirmed", business_date: "2026-10-02", recognition_month: "2026-10-01", amount: "500000.000",
  occurred_at: "2026-10-02T05:00:00+00:00", updated_at: "2026-10-09T07:20:51.718367+00:00", source_type: "manual", source_key: "sheet:2026-10:row20:manual",
  memo: "10/2 돼지고기 현금 구매, 거래처인지 미납금인지 확인안됨", economic_effect_sign: 1, party_id: 35, category: { id: 42, name: "육류" },
  source_snapshot: {}, display_snapshot: { titleOverride: "10/2 돼지고기 현금 구매" }, movements: [{ amount: -500000, fund_account: CASH }],
};
const partners = [{ id: 34, ledgerPartyId: 35, manualExpenseCategoryId: 42 }, { id: 40, ledgerPartyId: 41, manualExpenseCategoryId: 43 }];
const source = (row: TransactionRow) => buildLedgerEntries([row], [], new Map(), [], "2026-10")[0].manualEdit as ManualEditSource;

test("manual rows expose their current values and version; linked or special rows do not", () => {
  assert.deepEqual(source(tx2415), { type: "expense", occurredAt: "2026-10-02T05:00:00+00:00", amount: 500000, categoryId: 42, partyId: 35,
    fromAccountId: 1, toAccountId: null, title: "10/2 돼지고기 현금 구매", memo: tx2415.memo, updatedAt: "2026-10-09T07:20:51.718367+00:00" });
  const transfer = source({ ...tx2415, id: 9, type: "transfer", category: null, party_id: null, recognition_month: null, movements: [{ amount: -500000, fund_account: CASH }, { amount: 500000, fund_account: BANK }] });
  assert.deepEqual([transfer.fromAccountId, transfer.toAccountId], [1, 2]);
  for (const blocked of [
    { ...tx2415, source_snapshot: { requestId: "x" } }, { ...tx2415, source_type: "inventory_purchase_candidate" }, { ...tx2415, type: "payable_payment" },
    { ...tx2415, payable: { id: 1, original_amount: 1, status: "unpaid", allocations: [] } }, { ...tx2415, correction_of_id: 1 },
    { ...tx2415, updated_at: null }, { ...tx2415, movements: [{ amount: -1, fund_account: CASH }] },
  ]) assert.equal(buildLedgerEntries([blocked as TransactionRow], [], new Map(), [], "2026-10")[0]?.manualEdit, undefined);
});

test("form defaults are the stored values (Vietnam wall clock); 03:00 business-day rule", () => {
  const form = manualFormFromSource(source(tx2415), partners);
  assert.deepEqual(form, { type: "expense", date: "2026-10-02", time: "12:00", amount: "500000", partnerId: "34", categoryId: "42", fromAccountId: "1", toAccountId: "",
    title: "10/2 돼지고기 현금 구매", memo: tx2415.memo });
  assert.deepEqual(vietnamDateTime("2026-10-31T19:59:00Z"), { date: "2026-11-01", time: "02:59" });
  assert.equal(manualBusinessDate("2026-11-01", "02:59"), "2026-10-31");
  assert.equal(manualBusinessDate("2026-11-01", "03:00"), "2026-11-01");
  assert.equal(manualBusinessDate("2026-01-01", "00:30"), "2025-12-31");
});

test("only changed fields are sent; a type change sends every field the new type needs", () => {
  const src = source(tx2415);
  const initial = manualFormFromSource(src, partners);
  assert.deepEqual(manualFormChanges(src, initial, initial, partners), { changes: null, error: "unchanged" });
  assert.deepEqual(manualFormChanges(src, initial, { ...initial, amount: "600000", fromAccountId: "2" }, partners).changes, { amount: 600000, fromAccountId: 2 });
  assert.deepEqual(manualFormChanges(src, initial, { ...initial, date: "2026-10-20", time: "10:00" }, partners).changes, { occurredAt: "2026-10-20T10:00:00+07:00" });
  assert.deepEqual(manualFormChanges(src, initial, { ...initial, partnerId: "40" }, partners).changes, { partyId: 41 });
  assert.deepEqual(manualFormChanges(src, initial, { ...initial, partnerId: "" }, partners).changes, { partyId: null });
  assert.deepEqual(manualFormChanges(src, initial, { ...initial, title: "  ", memo: "새 메모 " }, partners).changes, { title: null, memo: "새 메모" });
  assert.deepEqual(manualFormChanges(src, initial, { ...initial, type: "transfer", categoryId: "", partnerId: "", toAccountId: "2" }, partners).changes,
    { type: "transfer", fromAccountId: 1, toAccountId: 2 });
  assert.deepEqual(manualFormChanges(src, initial, { ...initial, type: "income", categoryId: "9", fromAccountId: "", toAccountId: "2" }, partners).changes,
    { type: "income", categoryId: 9, toAccountId: 2 });
  for (const [patch, error] of [[{ amount: "0" }, "amount"], [{ amount: "" }, "amount"], [{ categoryId: "" }, "category"], [{ fromAccountId: "" }, "fromAccount"],
    [{ type: "transfer", toAccountId: "1" }, "sameAccount"], [{ type: "income", categoryId: "9", toAccountId: "" }, "toAccount"], [{ date: "10/20" }, "date"]] as const) {
    assert.equal(manualFormChanges(src, initial, { ...initial, ...patch }, partners).error, error, JSON.stringify(patch));
  }
  assert.match(manualFormMessage("STALE", "ko"), /먼저 수정/);
  assert.match(manualFormMessage("LINKED_TRANSACTION", "vi"), /liên kết/);
});

test("request bodies: exact version string, known fields only, reason required", () => {
  const version = "2026-10-09T07:20:51.718367+00:00";
  assert.deepEqual(parseManualTransactionUpdate({ expectedUpdatedAt: version, reason: " 거래처 확인 ", changes: { partyId: 35, memo: null } }),
    { expectedUpdatedAt: version, reason: "거래처 확인", changes: { partyId: 35, memo: null } });
  for (const bad of [
    { expectedUpdatedAt: version, reason: "r", changes: {} }, { expectedUpdatedAt: version, reason: "", changes: { memo: "x" } },
    { expectedUpdatedAt: "yesterday", reason: "r", changes: { memo: "x" } }, { expectedUpdatedAt: version, reason: "r", changes: { status: "cancelled" } },
    { expectedUpdatedAt: version, reason: "r", changes: { amount: 1.5 } }, { expectedUpdatedAt: version, reason: "r", changes: { type: "sales" } },
    { expectedUpdatedAt: version, reason: "r", changes: { partyId: "35" } }, { expectedUpdatedAt: version, reason: "r", changes: { memo: "x" }, actorUserId: 1 },
  ]) assert.equal(parseManualTransactionUpdate(bad), null, JSON.stringify(bad));
  assert.deepEqual(parseManualTransactionCancel({ expectedUpdatedAt: version, reason: "중복 입력" }), { expectedUpdatedAt: version, reason: "중복 입력" });
  assert.equal(parseManualTransactionCancel({ expectedUpdatedAt: version, reason: "  " }), null);
  assert.equal(parseManualTransactionCancel({ expectedUpdatedAt: version }), null);
});

test("UI wiring: shared form, 삭제 needs reason + confirmation, cancelled rows listed separately", () => {
  const page = readFileSync("app/(protected)/admin/ledger/entries/page.tsx", "utf8");
  const form = readFileSync("app/(protected)/admin/ledger/entries/ManualTransactionForm.tsx", "utf8");
  assert.match(page, /import \{ AccountField, ManualTransactionDelete, ManualTransactionEditor, manualCategoryOptions \} from "\.\/ManualTransactionForm";/);
  assert.doesNotMatch(page, /^function AccountField\(/m, "one shared AccountField");
  assert.match(page, /const categories = manualCategoryOptions\(type, data\.categories\),/);
  assert.match(page, /data-manual-action="delete"/);
  assert.match(page, /<CancelledManualTransactions lang=\{lang\} month=\{month\} version=\{cancelledVersion\} \/>/);
  assert.match(form, /if \(!reason\.trim\(\)\) \{ setError\(manualFormMessage\("reason", lang\)\); return; \}\n    const amount = [^\n]+\n    if \(!window\.confirm\(/);
  assert.match(form, /\/api\/admin\/ledger\/transactions\/\$\{transactionId\}\/cancel/);
  assert.match(form, /expectedUpdatedAt: source\.updatedAt/);
  const route = readFileSync("app/api/admin/ledger/route.ts", "utf8");
  assert.match(route, /const TRANSACTION_SELECT = "id,operation_id,type,occurred_at,updated_at,/);
});
