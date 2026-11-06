import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { reserveHistoryAsOf } from "../lib/ledger/reserve-history-as-of.ts";

const page = readFileSync("app/(protected)/admin/ledger/entries/page.tsx", "utf8");
const css = readFileSync("app/(protected)/admin/ledger/entries/entries.module.css", "utf8");
const sheet = page.slice(page.indexOf("function FundAccountReserveSheet"), page.indexOf("function ReserveEntryDetailSheet"));
const card = page.slice(page.indexOf("function renderBalanceCard"), page.indexOf("const partnerByLedgerParty"));

// Production rent reserve (plan 1, corporate account, target 720,000,000).
const entries = [
  { id: 1, entry_type: "allocate", amount: "60000000.000", occurred_at: "2026-09-30T05:00:00Z", memo: null },
  { id: 2, entry_type: "allocate", amount: "60000000.000", occurred_at: "2026-10-21T05:00:00Z", memo: null },
  { id: 3, entry_type: "release", amount: "100000000.000", occurred_at: "2026-10-21T05:01:00Z", memo: null },
];
// Month-end cutoff = next month's 1st, 03:00 Asia/Ho_Chi_Minh (as the ledger API's fundsView.asOf).
const closed = (month: string) => ({ mode: "closed_snapshot" as const, asOf: `${month}T03:00:00+07:00` });

test("history is cut at the selected month: later entries never appear in a past month", () => {
  // Close snapshots: Aug 0, Sep 60,000,000, Oct 20,000,000 — each equals history up to its cutoff.
  const aug = reserveHistoryAsOf(entries, closed("2026-09-01"));
  const sep = reserveHistoryAsOf(entries, closed("2026-10-01"));
  const oct = reserveHistoryAsOf(entries, closed("2026-11-01"));
  assert.deepEqual([aug.total, sep.total, oct.total], [0, 60_000_000, 20_000_000]);
  assert.deepEqual(sep.entries.map((entry) => entry.id), [1]);
  assert.deepEqual(oct.entries.map((entry) => entry.id), [1, 2, 3]);
  // Live month: entries up to load time (<=), like the balance read.
  assert.deepEqual(reserveHistoryAsOf(entries, { mode: "live", asOf: "2026-10-21T05:00:00Z" }).entries.map((entry) => entry.id), [1, 2]);
  // Other months: strictly before the cutoff.
  assert.deepEqual(reserveHistoryAsOf(entries, { mode: "provisional", asOf: "2026-10-21T05:00:00Z" }).entries.map((entry) => entry.id), [1]);
});

test("KPI card: the card opens the account log, the separate 🔒 opens the reserve detail, never nested", () => {
  assert.equal(card.match(/<button/g)?.length, 2);
  assert.match(card, /<\/em>\s+<\/button>\s+\{hasReserve \? \(\s+<button\s+type="button"\s+className=\{styles\.balanceReserveButton\}/);
  assert.match(card, /onClick=\{\(\) => \{ setLogAccountId\(null\); setReserveAccountId\(account\.id\); \}\}\s+>🔒<\/button>/);
  assert.match(card, /aria-label=\{`\$\{vi \? "Chi tiết quỹ dự phòng" : "준비금 상세"\} · \$\{reserveSummary\}`\}/);
  assert.match(page, /account\.id === reserveAccountId && account\.reserveTotal !== 0/);
  assert.match(page, /\{reserveAccount && data && !selected \? \(\s+<FundAccountReserveSheet[\s\S]*?fundsView=\{data\.fundsView\}/);
  // Tap target and placement: absolute top-right inside the card cell, 30px square.
  assert.match(css, /\.balanceInner \.balanceCardCell\{position:relative;/);
  assert.match(css, /\.balanceInner \.balanceReserveButton\{position:absolute;top:3px;right:3px;width:30px;height:30px;/);
});

test("reserve detail: month amounts from the account view, actual (not target) amounts, read-only, KO/VI", () => {
  assert.match(sheet, /<BarSheet/);
  assert.match(sheet, /<ReserveEntryHistoryList entries=\{asOf\.entries\} lang=\{lang\} title=\{copy\.entryCount\} \/>/);
  assert.match(sheet, /reserveHistoryAsOf\(loaded\.byPlan\.get\(reserve\.id\) \?\? \[\], fundsView\)/);
  // Amounts: account balance, reserve total, available, each reserve — all from the month's account view.
  for (const amount of ["account.balance", "account.reserveTotal", "account.availableBalance", "reserve.currentAmount"]) {
    assert.match(sheet, new RegExp(`money\\(${amount.replace(".", "\\.")}\\)`));
  }
  // Never the history API's latest figure, never the plan target.
  assert.doesNotMatch(sheet, /body\.currentAmount|currentAmount: Number\(body|target_amount|targetAmount/);
  assert.match(sheet, /금액은 목표금액이 아니라 실제 적립된 금액입니다\./);
  assert.match(sheet, /Số tiền là khoản đã thực trích lập, không phải mục tiêu\./);
  for (const label of ["계좌 전체 잔액", "Tổng số dư tài khoản", "준비금 합계", "Tổng quỹ dự phòng", "사용 가능 잔액", "Số dư khả dụng"]) assert.match(sheet, new RegExp(label));
  // Read-only: GET of each plan's own history only.
  assert.match(sheet, /fetch\(`\/api\/admin\/ledger\/reserves\/\$\{planId\}\/history`, \{ cache: "no-store", signal: controller\.signal \}\)/);
  assert.doesNotMatch(sheet, /method:|savePlan|addEntry|recurring/);
});
