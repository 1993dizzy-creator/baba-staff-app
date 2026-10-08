import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildLedgerEntries,
  buildReserveLedgerEntries,
  compareLedgerEntriesByDisplayTime,
  entryDisplaySubtotal,
  type LedgerEntry,
  type TransactionRow,
} from "../lib/ledger/entries.ts";
import { entryMatchesListFilter, LEDGER_ENTRY_FILTERS } from "../lib/ledger/entry-list-filter.ts";
import { getBusinessDate } from "../lib/common/business-time.ts";
import { entryDisplayAmountSign, entryDisplayAmountTone } from "../lib/ledger/entry-display-amount.ts";
import { entryDisplayBadgeKind, entryDisplayBadgeLabel } from "../lib/ledger/entry-display-badge.ts";
import { entryCategoryEmoji } from "../lib/ledger/entry-display-emoji.ts";

const route = readFileSync("app/api/admin/ledger/route.ts", "utf8");
const page = readFileSync("app/(protected)/admin/ledger/entries/page.tsx", "utf8");

const plans = [{ id: 7, name: "다음 연간 임대료 준비금", fund_account_id: 2 }];
const accounts = new Map([[1, "매장 현금"], [2, "BABA 법인계좌"]]);
const rentReserveAllocate = {
  id: 41, reserve_plan_id: 7, entry_type: "allocate", amount: "60000000.000",
  occurred_at: "2026-09-30T12:00:00+07:00", memo: "9월 임대료 준비금 적립",
};

const septemberTransactions: TransactionRow[] = [
  { id: 101, type: "expense", status: "confirmed", business_date: "2026-09-30", amount: 500_000, occurred_at: "2026-09-30T10:00:00+07:00", source_type: "manual", memo: "소모품", movements: [{ amount: -500_000, fund_account: { id: 1, display_name: "매장 현금" } }] },
  { id: 102, type: "income", status: "confirmed", business_date: "2026-09-30", amount: 200_000, occurred_at: "2026-09-30T14:00:00+07:00", source_type: "manual", memo: "기타 수입", movements: [{ amount: 200_000, fund_account: { id: 1, display_name: "매장 현금" } }] },
  { id: 103, type: "sales", status: "confirmed", business_date: "2026-09-30", amount: 3_000_000, occurred_at: "2026-09-30T03:00:00+07:00", source_type: "pos_sales_daily_payment", source_key: "pos:2026-09-30:cash", source_snapshot: { syncedAt: "2026-10-01T03:05:00+07:00", receiptCount: 12 } },
];

function reserveRows(rows = [rentReserveAllocate]) {
  return buildReserveLedgerEntries(rows, plans, accounts, "2026-09", getBusinessDate);
}

function daySubtotals(entries: readonly LedgerEntry[], date: string) {
  return entries.filter(entry => entry.businessDate === date).reduce((sum, entry) => {
    const subtotal = entryDisplaySubtotal(entry);
    return { income: sum.income + subtotal.income, expense: sum.expense + subtotal.expense };
  }, { income: 0, expense: 0 });
}

test("9/30 12:00 rent reserve allocate shows as an informational 60M row on 9/30", () => {
  const [row] = reserveRows();
  assert.equal(row.businessDate, "2026-09-30");
  assert.equal(row.displayTime, "12:00");
  assert.equal(row.amount, 60_000_000);
  assert.equal(row.title, "다음 연간 임대료 준비금");
  assert.equal(row.accountName, "BABA 법인계좌");
  assert.equal(row.memo, "9월 임대료 준비금 적립");
  assert.equal(row.transactionId, null);
  assert.equal(row.editableManualDisplay, undefined);
  assert.equal(row.participatesInProfit, false);
  assert.equal(row.fundFlow, "none");
  assert.deepEqual(row.systemDisplay, {
    kind: "reserve", reserveEntryId: 41, reservePlanId: 7,
    reserveName: "다음 연간 임대료 준비금", entryType: "allocate", signedAmount: 60_000_000,
  });
  // 준비금 🏦 … · 적립 / 법인 60,000,000₫ with no sign and neutral tone.
  assert.equal(entryDisplayBadgeLabel(entryDisplayBadgeKind(row), "ko"), "준비금");
  assert.equal(entryCategoryEmoji(row), "🏦");
  assert.equal(entryDisplayAmountSign(row), "");
  assert.equal(entryDisplayAmountTone(row), "transfer");
  assert.match(readFileSync("lib/ledger/reserve-text.ts", "utf8"), /ko: \{ allocate: "적립", release: "해제", consume: "사용", adjustment: "조정" \}/);
  assert.match(page, /import \{ reserveEntryTypeLabel \} from "@\/lib\/ledger\/reserve-text";/);
  assert.match(page, /if \(display\?\.kind === "reserve"\) return display\.reserveName;/);
});

test("reserve rows follow occurred_at in Asia/Ho_Chi_Minh with the 03:00 business-day cutoff", () => {
  const rows = reserveRows([
    { ...rentReserveAllocate, id: 1, occurred_at: "2026-10-01T02:30:00+07:00" },
    { ...rentReserveAllocate, id: 2, occurred_at: "2026-10-01T03:00:00+07:00" },
    { ...rentReserveAllocate, id: 3, occurred_at: "2026-09-01T02:59:00+07:00" },
    { ...rentReserveAllocate, id: 4, occurred_at: "2026-09-01T03:00:00+07:00" },
  ]);
  assert.deepEqual(rows.map(row => [row.id, row.businessDate]), [
    ["reserve-entry:1", "2026-09-30"],
    ["reserve-entry:4", "2026-09-01"],
  ]);
});

test("entry types map to labels and keep amounts unsigned", () => {
  const rows = reserveRows([
    { ...rentReserveAllocate, id: 1, entry_type: "release", amount: 1_000 },
    { ...rentReserveAllocate, id: 2, entry_type: "consume", amount: 2_000 },
    { ...rentReserveAllocate, id: 3, entry_type: "adjustment", amount: -3_000 },
  ]);
  assert.deepEqual(rows.map(row => [row.amount, row.systemDisplay?.kind === "reserve" ? row.systemDisplay.signedAmount : null]), [
    [1_000, -1_000], [2_000, -2_000], [3_000, -3_000],
  ]);
  for (const row of rows) assert.equal(entryDisplayAmountSign(row), "");
});

test("daily income/expense subtotal is unchanged while the reserve row counts in the date group", () => {
  const ledger = buildLedgerEntries(septemberTransactions, [], new Map(), [], "2026-09");
  const withReserve = [...ledger, ...reserveRows()];
  assert.deepEqual(daySubtotals(withReserve, "2026-09-30"), daySubtotals(ledger, "2026-09-30"));
  assert.deepEqual(daySubtotals(withReserve, "2026-09-30"), { income: 3_200_000, expense: 500_000 });
  assert.equal(withReserve.filter(entry => entry.businessDate === "2026-09-30").length, ledger.length + 1);
  assert.deepEqual(entryDisplaySubtotal(reserveRows()[0]), { income: 0, expense: 0 });
});

test("monthly P&L, cash report and account balances never read reserve history rows", () => {
  const ledger = buildLedgerEntries(septemberTransactions, [], new Map(), [], "2026-09");
  const profit = (entries: readonly LedgerEntry[]) => entries
    .filter(entry => entry.participatesInProfit)
    .reduce((sum, entry) => sum + (entry.direction === "income" ? 1 : -1) * entry.amount * entry.economicEffectSign, 0);
  assert.equal(profit([...ledger, ...reserveRows()]), profit(ledger));
  assert.equal(profit(ledger), 2_700_000);

  // The route's P&L comes from ledger_transactions queries only; reserve rows are
  // appended to `entries` after every summary, cash and balance computation.
  const summaryAt = route.indexOf("summary: { income: recognizedIncome");
  const reserveRowsAt = route.indexOf("...buildReserveLedgerEntries(");
  assert.ok(reserveRowsAt > route.indexOf("computePaidExpenseTotal(paidExpenseRoots)"));
  assert.ok(reserveRowsAt > route.indexOf("buildDashboardCashReport("));
  assert.ok(reserveRowsAt > route.indexOf("buildFundAccountView({"));
  assert.ok(summaryAt > reserveRowsAt);
  assert.doesNotMatch(route.slice(summaryAt, route.indexOf("}, cashReport", summaryAt)), /reserve/i);
  assert.doesNotMatch(route, /from\("ledger_transactions"\)\.insert|ledger_movements"\)\.insert/);
});

test("reserve balance keeps the full cumulative scope while history uses the same query", () => {
  assert.equal((route.match(/from\("ledger_reserve_entries"\)/g) ?? []).length, 1);
  assert.equal((route.match(/from\("ledger_reserve_plans"\)/g) ?? []).length, 1);
  // No lower bound for open months: balances still sum every entry since the beginning.
  assert.match(route, /\.select\("id,reserve_plan_id,entry_type,amount,occurred_at,memo"\)\s*\.lt\("occurred_at", monthEndCutoffAt\);/);
  assert.match(route, /fundsViewMode === "closed_snapshot"\s*\? query\.gte\("occurred_at", monthStartCutoffAt\)\s*: query;/);
  assert.match(route, /reserveEntryRows\.filter\(\(entry\) => Date\.parse\(entry\.occurred_at\) <= now\.getTime\(\)\)/);
  assert.match(route, /const reservePlans = fundsViewMode === "closed_snapshot" \? \[\] :/);
});

test("reserve rows are excluded from every filter except 전체 and 준비금", () => {
  const [row] = reserveRows();
  assert.deepEqual(LEDGER_ENTRY_FILTERS.filter(filter => entryMatchesListFilter(row, filter)), ["all", "reserve"]);
  const [expense, income] = buildLedgerEntries(septemberTransactions.slice(0, 2), [], new Map(), [], "2026-09")
    .sort((a, b) => Number(a.transactionId) - Number(b.transactionId));
  assert.equal(entryMatchesListFilter(expense, "expense"), true);
  assert.equal(entryMatchesListFilter(expense, "manual"), true);
  assert.equal(entryMatchesListFilter(income, "income"), true);
  assert.match(page.replace(/\s+/g, ""), /if\(!entryMatchesListFilter\(entry,filter\)\)continue;/);
});

test("search covers reserve name, account and memo through the shared search text", () => {
  assert.match(page, /`\$\{entryDisplayTitle\(entry, lang\)\} \$\{entryMeta\(entry, lang\)\} \$\{entry\.accountName \?\? ""\} \$\{entry\.categoryName \?\? ""\} \$\{entry\.memo \?\? ""\}`/);
});

test("reserve rows sort chronologically with same-day transactions and before POS close", () => {
  const ledger = buildLedgerEntries(septemberTransactions, [], new Map(), [], "2026-09");
  const sorted = [...ledger, ...reserveRows()].sort(compareLedgerEntriesByDisplayTime);
  assert.deepEqual(sorted.map(entry => entry.id), [
    "transaction:101", "reserve-entry:41", "transaction:102", "transaction:103",
  ]);
});

test("reserve detail is read-only and does not reuse the transaction edit sheet", () => {
  const sheetStart = page.indexOf("function ReserveEntryDetailSheet");
  assert.ok(sheetStart > 0);
  const nextFunction = page.indexOf("\nfunction ", sheetStart + 1);
  const sheet = page.slice(sheetStart, nextFunction < 0 ? undefined : nextFunction);
  assert.doesNotMatch(sheet, /fetch\(|ManualDisplayEditor|onConfirmedEdited|setEditMode|primaryButtonStyle|dangerButtonStyle/);
  assert.match(page, /selected\?\.systemDisplay\?\.kind === "reserve" \? \(\s*<ReserveEntryDetailSheet/);
});
