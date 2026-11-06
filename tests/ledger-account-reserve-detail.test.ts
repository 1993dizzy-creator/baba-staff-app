import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { categoryNameEmoji, entryCategoryEmoji } from "../lib/ledger/entry-display-emoji.ts";
import { reserveHistoryAsOf } from "../lib/ledger/reserve-history-as-of.ts";

const page = readFileSync("app/(protected)/admin/ledger/entries/page.tsx", "utf8");
const css = readFileSync("app/(protected)/admin/ledger/entries/entries.module.css", "utf8");
const logSheet = page.slice(page.indexOf("function FundAccountLogSheet"), page.indexOf("function AccountReservePanel"));
const panel = page.slice(page.indexOf("function AccountReservePanel"), page.indexOf("function ReserveEntryDetailSheet"));
const card = page.slice(page.indexOf("function renderBalanceCard"), page.indexOf("const partnerByLedgerParty"));

// Production rent reserve (plan 1, corporate account, target 720,000,000).
const entries = [
  { id: 1, entry_type: "allocate", amount: "60000000.000", occurred_at: "2026-09-30T05:00:00Z", memo: null },
  { id: 2, entry_type: "allocate", amount: "60000000.000", occurred_at: "2026-10-21T05:00:00Z", memo: null },
  { id: 3, entry_type: "release", amount: "100000000.000", occurred_at: "2026-10-21T05:01:00Z", memo: null },
];
// Month-end cutoff = next month's 1st, 03:00 Asia/Ho_Chi_Minh (as the ledger API's fundsView.asOf).
const closed = (month: string) => ({ mode: "closed_snapshot" as const, asOf: `${month}T03:00:00+07:00` });

test("reserve history is cut at the selected month: later entries never appear in a past month", () => {
  // Close snapshots: Aug 0, Sep 60,000,000, Oct 20,000,000 — each equals history up to its cutoff.
  const aug = reserveHistoryAsOf(entries, closed("2026-09-01"));
  const sep = reserveHistoryAsOf(entries, closed("2026-10-01"));
  const oct = reserveHistoryAsOf(entries, closed("2026-11-01"));
  assert.deepEqual([aug.total, sep.total, oct.total], [0, 60_000_000, 20_000_000]);
  assert.deepEqual(sep.entries.map((entry) => entry.id), [1]);
  assert.deepEqual(oct.entries.map((entry) => entry.id), [1, 2, 3]);
  assert.deepEqual(reserveHistoryAsOf(entries, { mode: "live", asOf: "2026-10-21T05:00:00Z" }).entries.map((entry) => entry.id), [1, 2]);
  assert.deepEqual(reserveHistoryAsOf(entries, { mode: "provisional", asOf: "2026-10-21T05:00:00Z" }).entries.map((entry) => entry.id), [1]);
});

test("KPI card: the whole card opens the account sheet; the 🔒 is decoration only", () => {
  assert.equal(card.match(/<button/g)?.length, 1);
  assert.match(card, /onClick=\{\(\) => setLogAccountId\(account\.id\)\}/);
  assert.match(card, /<span className=\{styles\.balanceReserveMark\} role="img" aria-label=\{reserveSummary\} title=\{reserveSummary\}>🔒<\/span>/);
  assert.doesNotMatch(page, /FundAccountReserveSheet|setReserveAccountId|balanceReserveButton/);
  assert.doesNotMatch(css, /balanceReserveButton|balanceCardCell/);
});

test("account sheet: 입금/출금 then 월초/현재, collapsed date groups with count, emoji from the list rule", () => {
  const order = ["입금", "출금", "월초 잔액", "현재 잔액"].map((label) => logSheet.indexOf(`"${label}"`));
  assert.ok(order.every((index, i) => index > 0 && (i === 0 || index > order[i - 1])), "KPI order");
  const viOrder = ["Tiền vào", "Tiền ra", "Đầu tháng", "Số dư hiện tại"].map((label) => logSheet.indexOf(`"${label}"`));
  assert.ok(viOrder.every((index, i) => index > 0 && (i === 0 || index > viOrder[i - 1])), "VI KPI order");
  // Collapsed by default; the sheet is keyed by month:account, so re-entry starts collapsed.
  assert.match(logSheet, /const \[openDates, setOpenDates\] = useState<Set<string>>\(\(\) => new Set\(\)\);/);
  assert.match(logSheet, /aria-expanded=\{open\} aria-controls=\{panelId\} onClick=\{\(\) => toggleDate\(date\)\}/);
  assert.match(logSheet, /\{vi \? `\$\{dayRows\.length\} giao dịch` : `\$\{dayRows\.length\}건`\}/);
  assert.match(logSheet, /\{open \? \(\s+<div className=\{styles\.accountLogDayRows\} id=\{panelId\}>/);
  assert.match(page, /key=\{`\$\{month\}:\$\{logAccount\.id\}`\}/);
  // Emoji: the list's own rule for listed entries (partner first), category name only otherwise.
  assert.match(logSheet, /const emoji = entry \? entryDisplayEmoji\(entry, partnersByParty\) : categoryNameEmoji\(row\.categoryName\);/);
  assert.match(logSheet, /\{emoji \? <i className=\{styles\.accountLogEmoji\} aria-hidden>\{emoji\}<\/i> : null\}\{title\}/);
  assert.equal(categoryNameEmoji("POS 매출"), "🧾");
  assert.equal(categoryNameEmoji(null), null);
  assert.equal(categoryNameEmoji("알 수 없는 분류"), null);
  // entryCategoryEmoji keeps its direction fallback for the ledger list.
  assert.equal(entryCategoryEmoji({ categoryName: "알 수 없는 분류", direction: "expense" }), "📂");
});

test("corporate account: 내역 / 준비금 tabs in the same sheet; other accounts log only", () => {
  assert.match(logSheet, /const showReserveTab = account\.code === "baba_corporate_bank" \|\| account\.reserves\.length > 0;/);
  assert.match(logSheet, /const \[tab, setTab\] = useState<"log" \| "reserve">\("log"\);/);
  assert.match(logSheet, /\{showReserveTab \? \(\s+<div className=\{styles\.accountLogTabs\} role="tablist"/);
  assert.match(logSheet, /\{showReserveTab && tab === "reserve" \? \(\s+<AccountReservePanel lang=\{lang\} account=\{account\} fundsView=\{fundsView\} \/>/);
  for (const label of ['"내역"', '"Giao dịch"', '"준비금"', '"Quỹ dự phòng"']) assert.ok(logSheet.includes(label), label);
  // Tabs switch content in place: one BarSheet, no extra sheet.
  assert.equal(logSheet.match(/<BarSheet/g)?.length, 1);
  assert.doesNotMatch(panel, /<BarSheet/);
  assert.match(page, /fundsView=\{data\.fundsView\}\s+entryByTransaction=\{entryByTransaction\}\s+partnersByParty=\{partnerByLedgerParty\}/);
});

test("준비금 tab: month amounts from the account view, actual (not target) amounts, read-only, KO/VI", () => {
  assert.match(panel, /<ReserveEntryHistoryList entries=\{asOf\.entries\} lang=\{lang\} title=\{copy\.entryCount\} \/>/);
  assert.match(panel, /reserveHistoryAsOf\(loaded\.byPlan\.get\(reserve\.id\) \?\? \[\], fundsView\)/);
  for (const amount of ["account.reserveTotal", "account.availableBalance", "reserve.currentAmount"]) {
    assert.match(panel, new RegExp(`money\\(${amount.replace(".", "\\.")}\\)`));
  }
  assert.doesNotMatch(panel, /body\.currentAmount|currentAmount: Number\(body|target_amount|targetAmount/);
  assert.match(panel, /금액은 목표금액이 아니라 실제 적립된 금액입니다\./);
  assert.match(panel, /Số tiền là khoản đã thực trích lập, không phải mục tiêu\./);
  for (const label of ["준비금 합계", "Tổng quỹ dự phòng", "사용 가능 잔액", "Số dư khả dụng"]) assert.match(panel, new RegExp(label));
  assert.match(panel, /fetch\(`\/api\/admin\/ledger\/reserves\/\$\{planId\}\/history`, \{ cache: "no-store", signal: controller\.signal \}\)/);
  assert.doesNotMatch(panel, /method:|savePlan|addEntry|recurring/);
});
