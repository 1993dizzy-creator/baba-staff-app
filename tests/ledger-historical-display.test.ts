import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { buildLedgerEntries, entryDisplaySubtotal } = require("../lib/ledger/entries.ts") as typeof import("../lib/ledger/entries");
const { entryDisplayBadgeKind, entryDisplayBadgeLabel } = require("../lib/ledger/entry-display-badge.ts") as typeof import("../lib/ledger/entry-display-badge");
const { entryCategoryEmoji } = require("../lib/ledger/entry-display-emoji.ts") as typeof import("../lib/ledger/entry-display-emoji");
const { entryDisplayAmount, entryDisplayAmountSign } = require("../lib/ledger/entry-display-amount.ts") as typeof import("../lib/ledger/entry-display-amount");
const { MANUAL_EXPENSE_CATEGORY_NAMES, manualExpenseCategoryEmoji, manualExpenseCategoryLabel } = require("../lib/ledger/manual-entry-policy.ts") as typeof import("../lib/ledger/manual-entry-policy");
const page = readFileSync("app/(protected)/admin/ledger/entries/page.tsx", "utf8");

const build = (rows: Parameters<typeof buildLedgerEntries>[0]) => buildLedgerEntries(rows, [], new Map());

test("investment recovery #1676 has investment identity, ⚖️ and negative display sign without changing direction", () => {
  const [entry] = build([{
    id: 1676, type: "investment", source_type: "owner_investment", status: "confirmed",
    business_date: "2026-09-10", amount: 5_000_000, memo: "MJK 투자금 회수",
    source_snapshot: { entryType: "recovery" }, movements: [{ amount: -5_000_000 }],
  }]);
  assert.equal(entry.title, "MJK 투자금 회수");
  assert.equal(entry.direction, "transfer");
  assert.equal(entry.systemDisplay?.kind, "investment");
  assert.equal(entryCategoryEmoji(entry), "⚖️");
  assert.equal(entryDisplayBadgeLabel(entryDisplayBadgeKind(entry), "ko"), "투자금");
  assert.equal(entryDisplayAmountSign(entry), "−");
  assert.deepEqual(entryDisplaySubtotal(entry), { income: 0, expense: 0 });
});

test("capital recovery and investment contribution have opposite signs; profit distribution stays ordinary transfer", () => {
  const entries = build([
    { id: 1, type: "investment", source_type: "owner_investment", status: "confirmed", business_date: "2026-09-10", amount: 2_000_000, memo: "MJK 투자금", source_snapshot: { entryType: "contribution" }, movements: [{ amount: 2_000_000 }] },
    { id: 2, type: "owner_settlement_payment", source_type: "owner_settlement_payment", status: "confirmed", business_date: "2026-09-10", amount: 1_000_000, memo: "MJK 투자금 회수", source_snapshot: { settlementType: "capital_recovery" }, movements: [{ amount: -1_000_000 }] },
    { id: 3, type: "owner_settlement_payment", source_type: "owner_settlement_payment", status: "confirmed", business_date: "2026-09-10", amount: 1_000_000, source_snapshot: { settlementType: "profit_distribution" }, movements: [{ amount: -1_000_000 }] },
  ]);
  const byId = (id: number) => entries.find(entry => entry.transactionId === id)!;
  assert.equal(entryDisplayAmountSign(byId(1)), "+");
  assert.equal(entryDisplayAmountSign(byId(2)), "−");
  assert.equal(entryDisplayBadgeKind(byId(2)), "investment");
  assert.equal(byId(3).systemDisplay?.kind, undefined);
  assert.equal(entryDisplayAmountSign(byId(3)), "");
});

test("income, expense, payroll outflow, payable payment and card settlement have their requested signs", () => {
  const entries = build([
    { id: 1, type: "income", source_type: "manual", status: "confirmed", business_date: "2026-09-10", amount: 100 },
    { id: 2, type: "expense", source_type: "manual", status: "confirmed", business_date: "2026-09-10", amount: 100 },
    { id: 3, type: "payroll_payment", source_type: "payroll_employee_payment", status: "confirmed", business_date: "2026-09-10", amount: 100, movements: [{ amount: -100 }] },
    { id: 4, type: "payable_payment", source_type: "payable_payment", status: "confirmed", business_date: "2026-09-10", amount: 100, movements: [{ amount: -100 }] },
    { id: 5, type: "card_settlement_deposit", source_type: "card_settlement_deposit", status: "confirmed", business_date: "2026-09-10", amount: 100, movements: [{ amount: -100 }, { amount: 100 }] },
    { id: 6, type: "transfer", source_type: "manual", status: "confirmed", business_date: "2026-09-10", amount: 100, movements: [{ amount: -100 }, { amount: 100 }] },
  ]);
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(id => entryDisplayAmountSign(entries.find(entry => entry.transactionId === id)!)),
    ["+", "−", "−", "", "", ""]);
  assert.equal((page.match(/entryDisplayAmountSign\(entry\)/g) ?? []).length, 2);
  assert.equal((page.match(/entryDisplayAmount\(entry\)/g) ?? []).length, 2);
});

test("Mega Market payment displays 11,862,600 once while the 600 expense remains in the daily expense subtotal", () => {
  const entries = build([
    { id: 931, type: "expense", source_type: "inventory_purchase_candidate", status: "confirmed", business_date: "2026-09-11", amount: 11_862_000, party_id: 5, party: { name: "Mega Market" }, source_snapshot: { item_name: "매입" } },
    { id: 1640, type: "payable_payment", source_type: "payable_payment", status: "confirmed", business_date: "2026-09-11", amount: 11_862_000, party_id: 5, party: { name: "Mega Market" }, display_snapshot: { actualPaidAmount: 11_862_600, paymentDifferenceAmount: 600, linkedDifferenceTransactionId: 1643 }, movements: [{ amount: -11_862_000 }] },
    { id: 1643, type: "expense", source_type: "manual", status: "confirmed", business_date: "2026-09-11", amount: 600, memo: "Mega Market 차액", movements: [{ amount: -600 }] },
  ]);
  const payment = entries.find(entry => entry.transactionId === 1640)!;
  assert.equal(entries.some(entry => entry.transactionId === 1643), false);
  assert.equal(payment.amount, 11_862_000);
  assert.equal(entryDisplayAmount(payment), 11_862_600);
  assert.equal(entryDisplayAmountSign(payment), "");
  assert.equal(payment.direction, "transfer");
  assert.deepEqual(entryDisplaySubtotal(payment), { income: 0, expense: 600 });
  assert.equal(entries.some(entry => entry.drilldown === "inventory"), true);
});

test("insurance and welfare are separate manual categories and water filter is equipment", () => {
  assert.ok(MANUAL_EXPENSE_CATEGORY_NAMES.includes("보험"));
  assert.ok(MANUAL_EXPENSE_CATEGORY_NAMES.includes("복리후생"));
  assert.equal(MANUAL_EXPENSE_CATEGORY_NAMES.includes("보험·복리후생" as never), false);
  assert.equal(manualExpenseCategoryEmoji("보험"), "🛡️");
  assert.equal(manualExpenseCategoryEmoji("복리후생"), "🎉");
  assert.match(manualExpenseCategoryLabel("복리후생", "vi"), /Phúc lợi/);
  const [entry] = build([{ id: 1657, type: "expense", source_type: "manual", status: "confirmed", business_date: "2026-09-11", amount: 2_100_000, category: { id: 26, name: "설비·비품" }, display_snapshot: { titleOverride: "정수기·필터기 임대" }, movements: [{ amount: -2_100_000 }] }]);
  assert.equal(entry.title, "정수기·필터기 임대");
  assert.equal(entry.categoryName, "설비·비품");
  assert.equal(entry.amount, 2_100_000);
});