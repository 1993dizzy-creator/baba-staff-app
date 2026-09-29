import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildLedgerEntries,
  compareLedgerEntriesByDisplayTime,
  entryRequiresReview,
} from "./entries.ts";

const page = readFileSync("app/(protected)/admin/ledger/entries/page.tsx", "utf8");
const pageCompact = page.replace(/\s+/g, "");
const css = readFileSync("app/(protected)/admin/ledger/entries/entries.module.css", "utf8");

test("POS daily close uses its actual sync time and sorts after same-day manual activity", () => {
  const entries = buildLedgerEntries([
    {
      id: 1, type: "expense", business_date: "2026-09-25", amount: 10_000,
      occurred_at: "2026-09-25T12:00:00+07:00", source_type: "manual", memo: "점심 지출",
    },
    {
      id: 2, type: "sales", business_date: "2026-09-25", amount: 20_000,
      occurred_at: "2026-09-25T03:00:00+07:00", source_type: "pos_sales_daily_payment",
      source_key: "pos:2026-09-25:cash", source_snapshot: { syncedAt: "2026-09-26T03:05:00+07:00" },
    },
  ], [], new Map()).sort(compareLedgerEntriesByDisplayTime);

  assert.deepEqual(entries.map(entry => entry.transactionId), [1, 2]);
  assert.equal(entries[1].displayTime, "03:05");
  assert.equal(entries[1].sortTimestamp, Date.parse("2026-09-26T03:05:00+07:00"));
  assert.match(pageCompact, /group\.rows\.sort\(compareLedgerEntriesByDisplayTime\)/);
});

test("daily display puts POS close last and preserves ordinary timestamp and id order", () => {
  const entries = buildLedgerEntries([
    { id: 5, type: "sales", business_date: "2026-09-25", amount: 20_000, occurred_at: "2026-09-25T08:00:00+07:00", source_type: "pos_sales_daily_payment", source_key: "pos:2026-09-25:cash" },
    { id: 3, type: "expense", business_date: "2026-09-25", amount: 10_000, occurred_at: "2026-09-25T12:00:00+07:00", source_type: "manual" },
    { id: 2, type: "income", business_date: "2026-09-25", amount: 12_000, occurred_at: "2026-09-25T10:00:00+07:00", source_type: "manual" },
    { id: 1, type: "expense", business_date: "2026-09-25", amount: 9_000, occurred_at: "2026-09-25T10:00:00+07:00", source_type: "manual" },
    { id: 4, type: "sales", business_date: "2026-09-25", amount: 21_000, occurred_at: "2026-09-25T08:00:00+07:00", source_type: "pos_sales_daily_payment", source_key: "pos:2026-09-25:card" },
  ], [], new Map()).sort(compareLedgerEntriesByDisplayTime);
  assert.deepEqual(entries.map(entry => entry.transactionId), [1, 2, 3, 4, 5]);
  assert.ok(entries.every(entry => entry.businessDate === "2026-09-25"));
});

test("review filter includes pending and correction-required entries only", () => {
  assert.equal(entryRequiresReview({ status: "pending", requiresCorrection: false }), true);
  assert.equal(entryRequiresReview({ status: "confirmed", requiresCorrection: true }), true);
  assert.equal(entryRequiresReview({ status: "confirmed", requiresCorrection: false }), false);
  assert.match(pageCompact, /filter==="pending"&&!entryRequiresReview\(entry\)/);
});

test("list titles are concise while the original transaction memo remains intact", () => {
  const choMemo = "9/25 Google Sheet 현금 지급 · Chợ 감자/과일/요거트/코코넛워터 309,000₫";
  const wowMemo = "9/25 Wow Spirit 선지급 4,048,000₫ · 9/26 매입 예정";
  const manualMemo = "9/25 주방 중고물품 재구매 · 현금 330,000₫";
  const [cho, wow, manual, cardDeposit, cranberry, payrollAdvance] = buildLedgerEntries([
    { id: 1, type: "payable_payment", business_date: "2026-09-25", amount: 309_000, source_type: "manual", memo: choMemo, party: { name: "Chợ" } },
    { id: 2, type: "payable_payment", business_date: "2026-09-25", amount: 4_048_000, source_type: "manual", memo: wowMemo, party: { name: "Wow Spirit" }, source_snapshot: { prepayment: true } },
    { id: 3, type: "expense", business_date: "2026-09-25", amount: 330_000, source_type: "manual", memo: manualMemo },
    { id: 4, type: "card_settlement_deposit", business_date: "2026-09-25", amount: 1_000_000, source_type: "card_settlement_deposit", memo: "정산 기술 메모" },
    { id: 5, type: "expense", business_date: "2026-09-25", amount: 497_000, source_type: "manual", memo: "9/25 cranberry · Vương 497,000₫" },
    { id: 6, type: "expense", business_date: "2026-09-25", amount: 500_000, source_type: "manual", memo: "9/25 Quan 급여 가불 · 현금 500,000₫" },
  ], [], new Map()).sort((left, right) => Number(left.transactionId) - Number(right.transactionId));

  assert.deepEqual(cho.systemDisplay, { kind: "payablePayment", partyName: "Chợ", prepaid: false });
  assert.deepEqual(wow.systemDisplay, { kind: "payablePayment", partyName: "Wow Spirit", prepaid: true });
  assert.equal(manual.title, "주방 중고물품 재구매");
  assert.deepEqual(cardDeposit.systemDisplay, { kind: "cardSettlementDeposit" });
  assert.equal(cranberry.title, "cranberry");
  assert.equal(payrollAdvance.title, "Quan 급여 가불");
  assert.equal(cho.memo, choMemo);
  assert.equal(wow.memo, wowMemo);
  assert.equal(manual.memo, manualMemo);
  assert.match(page, /`\$\{party\} 지급`/);
  assert.match(page, /`\$\{party\} 선지급`/);
  assert.match(page, /"카드 실제 입금"/);
  assert.match(pageCompact, /entry\.memo\?\?""/);
});

test("detail summary is compact and the original memo has its own optional section", () => {
  const detailSummary = page.slice(page.indexOf("function EntryDetailSheet"), page.indexOf("{message ? ("));
  assert.match(detailSummary, /formatDate\(entry\.businessDate, lang\)/);
  assert.match(detailSummary, /entryDisplayTitle/);
  assert.match(detailSummary, /<EntryDisplayBadge entry=\{entry\} lang=\{lang\}/);
  assert.match(detailSummary, /styles\.detailAmount/);
  assert.match(detailSummary, /<EntryFlags entry=\{entry\} lang=\{lang\}/);
  assert.match(detailSummary, /styles\.accountBadge/);
  assert.match(detailSummary, /accountBadgeLabel\(entry\.accountName, lang, entry\)/);
  assert.match(detailSummary, /isPayableAccount\(entry\.accountName\)/);
  assert.match(pageCompact, /entry\.memo\?\.trim\(\)\?\(<detailsclassName=\{styles\.detailMemo\}/);
  assert.match(page, /className={styles.detailMemoText}>{entry.memo}/);
  assert.match(css, /\.detailSummary\{gap:3px;padding:8px 10px\}/);
  assert.match(css, /\.detailMemoText\{[^}]*white-space:pre-wrap/);
  for (const name of ["detailMemo", "detailMemoLabel", "detailMemoText"]) {
    assert.match(css, new RegExp(`\\.${name}\\{`));
  }
  assert.match(page, /compactEntryListTitle\(entryDisplayTitle\(entry, lang\)\)/);
  assert.match(page, /title\.split\(\/\\r\?\\n\/[, ]+1\)/);
});

test("detail memo preserves stored newline order without parsing or sorting", () => {
  const memo = [
    "9/25 선지급 4,048,000₫",
    "9/26 잔금 3,245,000₫",
    "합계 7,293,000₫",
    "시트 표기: ruou hnoi",
  ].join("\n");
  assert.equal(memo.split("\n").join("\n"), memo);
  const memoSection = page.slice(page.indexOf("{entry.memo?.trim() ? ("), page.indexOf("</BarSheet>", page.indexOf("{entry.memo?.trim() ? (")));
  assert.match(memoSection, /\{entry\.memo\}/);
  assert.doesNotMatch(memoSection, /\.sort\(|split\(|localeCompare/);
  assert.match(css, /\.detailMemoText\{[^}]*white-space:pre-wrap/);
});
