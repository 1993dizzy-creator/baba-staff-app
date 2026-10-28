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
import { entryFilterHeaderAmount, entryMatchesListFilter, LEDGER_ENTRY_FILTERS } from "../lib/ledger/entry-list-filter.ts";
import { reserveEntryDisplaySign } from "../lib/ledger/reserve-text.ts";
import { getBusinessDate } from "../lib/common/business-time.ts";
import { reserveCurrentAmount } from "../lib/ledger/reserve-balances.ts";
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

test("entry types keep unsigned amounts; release/consume display negative, adjustment keeps its sign", () => {
  const rows = reserveRows([
    { ...rentReserveAllocate, id: 1, entry_type: "release", amount: "1000" },
    { ...rentReserveAllocate, id: 2, entry_type: "consume", amount: "2000" },
    { ...rentReserveAllocate, id: 3, entry_type: "adjustment", amount: "-3000" },
    { ...rentReserveAllocate, id: 4, entry_type: "adjustment", amount: "4000" },
    { ...rentReserveAllocate, id: 5, entry_type: "allocate", amount: "5000" },
  ]);
  assert.deepEqual(rows.map(row => [row.amount, row.systemDisplay?.kind === "reserve" ? row.systemDisplay.signedAmount : null]), [
    [1_000, -1_000], [2_000, -2_000], [3_000, -3_000], [4_000, 4_000], [5_000, 5_000],
  ]);
  assert.deepEqual(rows.map(row => entryDisplayAmountSign(row)), ["−", "−", "−", "", ""]);
  // The sign is display-only: direction, tone and subtotals stay neutral.
  for (const row of rows) {
    assert.equal(row.direction, "transfer");
    assert.equal(entryDisplayAmountTone(row), "transfer");
    assert.deepEqual(entryDisplaySubtotal(row), { income: 0, expense: 0 });
  }
});

test("10/21 rent reserve: allocate +60,000,000 / release -100,000,000 leaves 20,000,000 reserved", () => {
  const october = buildReserveLedgerEntries([
    { ...rentReserveAllocate, id: 2, entry_type: "allocate", amount: "60000000.000", occurred_at: "2026-10-21T12:00:00+07:00" },
    { ...rentReserveAllocate, id: 3, entry_type: "release", amount: "100000000.000", occurred_at: "2026-10-21T13:00:00+07:00" },
  ], plans, accounts, "2026-10", getBusinessDate);
  const display = (row: LedgerEntry) => `${entryDisplayAmountSign(row)}${row.amount}`;
  assert.deepEqual(october.map(display), ["60000000", "−100000000"]);
  // Stored amounts stay positive; only signedAmount carries the balance effect.
  assert.deepEqual(october.map(row => row.systemDisplay?.kind === "reserve" ? row.systemDisplay.signedAmount : null), [60_000_000, -100_000_000]);
  // Balance across 9/30 allocate + 10/21 allocate + 10/21 release is unchanged by display.
  assert.equal(reserveCurrentAmount([
    { entry_type: "allocate", amount: "60000000.000" },
    { entry_type: "allocate", amount: "60000000.000" },
    { entry_type: "release", amount: "100000000.000" },
  ]), 20_000_000);
  // 10/21 net reserve change under the 준비금 filter header.
  assert.equal(october.reduce((sum, row) => sum + (entryFilterHeaderAmount(row, "reserve") ?? 0), 0), -40_000_000);
});

test("shared reserve history sign: release/consume negative, allocate positive, adjustment keeps its sign", () => {
  assert.deepEqual([
    ["allocate", 60_000_000], ["release", 100_000_000], ["consume", 1], ["adjustment", -5], ["adjustment", 5], ["release", -7],
  ].map(([type, amount]) => reserveEntryDisplaySign(type as string, amount as number)), ["", "−", "−", "−", "", "−"]);
  const list = readFileSync("components/ledger/ReserveEntryHistoryList.tsx", "utf8");
  // Absolute amount + one sign: never a doubled minus.
  assert.match(list, /const sign = reserveEntryDisplaySign\(entry\.entry_type, amount\);/);
  assert.match(list, /\{sign\}\{money\(Math\.abs\(amount\)\)\}/);
  // Newest first; one line of type + YYYY.MM.DD + coloured amount, then the memo itself.
  assert.match(list, /sort\(\(a, b\) => Date\.parse\(b\.occurred_at\) - Date\.parse\(a\.occurred_at\) \|\| b\.id - a\.id\)/);
  assert.match(list, /aria-current=\{selected \? "true" : undefined\}/);
  assert.match(list, /year: "numeric", month: "2-digit", day: "2-digit" \}\)\.format\(new Date\(value\)\)\.replaceAll\("-", "\."\)/);
  assert.match(list, /<b className=\{sign \? styles\.outflow : styles\.inflow\}>/);
  assert.match(list, /<p className=\{memo \? styles\.memo : `\$\{styles\.memo\} \$\{styles\.noMemo\}`\}>\{memo \?\? copy\.noMemo\}<\/p>/);
  assert.doesNotMatch(list, /fetch\(|<button|<input|<form|<details|timeStyle/);
  const css = readFileSync("components/ledger/ReserveEntryHistoryList.module.css", "utf8");
  assert.match(css, /\.list\{[^}]*border:2px solid #d1d5db/);
  assert.match(css, /\.row\{[^}]*border-bottom:1px solid #e5e7eb/);
  assert.match(css, /\.selected\{background:#fffbeb;box-shadow:inset 3px 0 0 #f59e0b\}/);
  assert.match(css, /\.inflow\{color:#16805a\}/);
  assert.match(css, /\.outflow\{color:#b4493e\}/);
});

test("reserve sheet shows the shared spinner while loading and an error with retry on failure", () => {
  const sheet = page.slice(page.indexOf("function ReserveEntryDetailSheet"));
  // Failure is keyed to plan + attempt; retry bumps the attempt and re-runs the GET.
  assert.match(sheet, /const requestKey = `\$\{planId\}:\$\{attempt\}`;/);
  assert.match(sheet, /if \(!controller\.signal\.aborted\) setFailedKey\(key\);/);
  assert.match(sheet, /\}, \[planId, attempt\]\);/);
  assert.match(sheet, /const failed = !loaded && failedKey === requestKey;/);
  assert.match(sheet, /onClick=\{\(\) => setAttempt\(\(value\) => value \+ 1\)\}/);
  assert.match(sheet, /<InventoryLoadingCard lang=\{lang\} inline minHeight=\{120\} testId="reserve-history-loading" label=\{vi \? "Đang tải ghi nhận quỹ dự phòng…" : "준비금 기록을 불러오는 중…"\} \/>/);
  // The memo correction is data, never a UI literal.
  assert.doesNotMatch(page, /인테리어 업체 대여금/);
  assert.doesNotMatch(readFileSync("components/ledger/ReserveEntryHistoryList.tsx", "utf8"), /인테리어 업체 대여금/);
});

test("reserve detail sheet lists only the clicked entry's own plan via the shared history list", () => {
  const sheetStart = page.indexOf("function ReserveEntryDetailSheet");
  const sheet = page.slice(sheetStart);
  assert.match(sheet, /fetch\(`\/api\/admin\/ledger\/reserves\/\$\{planId\}\/history`, \{ cache: "no-store", signal: controller\.signal \}\)/);
  assert.match(sheet, /Number\(body\?\.plan\?\.id\) !== planId/);
  assert.match(sheet, /\.filter\(\(row\) => row\.reserve_plan_id == null \|\| Number\(row\.reserve_plan_id\) === planId\)/);
  assert.match(sheet, /const loaded = history\?\.planId === planId \? history : null;/);
  assert.match(sheet, /<ReserveEntryHistoryList entries=\{loaded\.entries\} lang=\{lang\} title=\{copy\.entryCount\} selectedId=\{reserve\.reserveEntryId\} \/>/);
  assert.match(sheet, /<strong>\{money\(loaded\.currentAmount\)\}<\/strong>/);
  // No recurring schedule or plan editing in the sheet.
  assert.doesNotMatch(sheet, /recurring|pendingSchedule|savePlan|addEntry|method:/);
  const api = readFileSync("app/api/admin/ledger/reserves/[id]/history/route.ts", "utf8");
  const get = api.slice(api.indexOf("export async function GET"));
  assert.match(get, /from\("ledger_reserve_entries"\)\.select\("id,reserve_plan_id,entry_type,amount,occurred_at,memo"\)\.eq\("reserve_plan_id", id\)/);
  assert.match(get, /\.filter\(\(entry\) => Number\(entry\.reserve_plan_id\) === id\)/);
  assert.match(get, /currentAmount: reserveCurrentAmount\(entries\)/);
  assert.doesNotMatch(get, /\.insert\(|\.update\(|\.delete\(|\.upsert\(|\.rpc\(/);
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
  assert.match(page, /`\$\{entryDisplayTitle\(entry, lang\)\} \$\{entryMeta\(entry, lang\)\} \$\{entry\.accountName \?\? ""\} \$\{entry\.categoryName \?\? ""\} \$\{entry\.memo \?\? ""\} /);
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
  // Its only request is the read-only GET of the plan's own history.
  assert.equal((sheet.match(/fetch\(/g) ?? []).length, 1);
  assert.doesNotMatch(sheet, /method:|ManualDisplayEditor|onConfirmedEdited|setEditMode|primaryButtonStyle|dangerButtonStyle/);
  assert.match(page, /selected\?\.systemDisplay\?\.kind === "reserve" \? \(\s*<ReserveEntryDetailSheet/);
});
