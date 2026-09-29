import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
// @ts-expect-error Node strip-types requires the extension.
import { buildLedgerEntries, entryDisplaySubtotal } from "../lib/ledger/entries.ts";
// @ts-expect-error Node strip-types requires the extension.
import { entryDisplayBadgeKind, entryDisplayBadgeLabel } from "../lib/ledger/entry-display-badge.ts";
// @ts-expect-error Node strip-types requires the extension.
import { entryCategoryEmoji } from "../lib/ledger/entry-display-emoji.ts";

const page = readFileSync("app/(protected)/admin/ledger/entries/page.tsx", "utf8");
const manualDisplayEditor = readFileSync("app/(protected)/admin/ledger/entries/ManualDisplayEditor.tsx", "utf8");
const route = readFileSync("app/api/admin/ledger/route.ts", "utf8");

const build = (rows: Parameters<typeof buildLedgerEntries>[0]) => buildLedgerEntries(rows, [], new Map());

test("historical and new advances omit the amount from the title", () => {
  const advances = build([
    { id: 1, type: "payroll_payment", status: "confirmed", business_date: "2026-09-03", amount: 2_000_000, source_type: "manual", source_key: "payroll-advance-payment:2026-09-03:user:4", memo: "9/3 Quan 급여 가불 2,000,000₫" },
    { id: 2, type: "payroll_payment", status: "confirmed", business_date: "2026-09-29", amount: 2_000_000, source_type: "manual", source_snapshot: { paymentKind: "advance", employee: "Triem" }, memo: "Triem 급여 가불 2,000,000₫" },
  ]);
  const historical = advances.find(entry => entry.transactionId === 1)!;
  const current = advances.find(entry => entry.transactionId === 2)!;
  assert.deepEqual([historical.title, current.title], ["Quan 급여 가불", "Triem 급여 가불"]);
  assert.deepEqual([historical.amount, current.amount], [2_000_000, 2_000_000]);
});

test("card settlement display keeps accounting direction and separates legacy from new fees", () => {
  const cardEntries = build([
    { id: 1, type: "card_settlement_deposit", status: "confirmed", business_date: "2026-09-03", amount: 42_879_074, source_type: "card_settlement_deposit" },
    { id: 2, type: "expense", status: "confirmed", business_date: "2026-09-03", amount: 949_886, source_type: "card_settlement_difference", source_snapshot: { matchedGrossAmount: 43_828_960, depositAmount: 42_879_074, differenceAmount: 949_886 } },
    { id: 3, type: "expense", status: "confirmed", business_date: "2026-09-29", amount: 100_000, source_type: "card_fee_month_close" },
    { id: 4, type: "sales", status: "confirmed", business_date: "2026-09-29", amount: 500_000, source_type: "pos_sales_daily_payment", source_key: "pos:2026-09-29:card", category: { name: "카드매출" } },
  ]);
  const byId = (id: number) => cardEntries.find(entry => entry.transactionId === id)!;
  const [deposit, legacy, fee, pos] = [1, 2, 3, 4].map(byId);
  assert.equal(deposit.direction, "transfer");
  assert.deepEqual(entryDisplaySubtotal(deposit), { income: 0, expense: 0 });
  assert.equal(entryDisplayBadgeLabel(entryDisplayBadgeKind(deposit), "ko"), "결제");
  assert.equal(entryCategoryEmoji(deposit), "💳");
  assert.equal(legacy.direction, "expense");
  assert.equal(entryDisplayBadgeKind(legacy), "expense");
  assert.equal(entryCategoryEmoji(legacy), "💳");
  assert.equal(legacy.systemDisplay?.kind, "cardSettlementDifference");
  if (legacy.systemDisplay?.kind !== "cardSettlementDifference") throw new Error("Missing legacy identity");
  assert.deepEqual([legacy.systemDisplay.matchedGrossAmount, legacy.systemDisplay.depositAmount, legacy.systemDisplay.differenceAmount], [43_828_960, 42_879_074, 949_886]);
  assert.equal((legacy.systemDisplay.differenceAmount! / legacy.systemDisplay.matchedGrossAmount! * 100).toFixed(2), "2.17");
  assert.equal(fee.systemDisplay?.kind, "cardFeeMonthClose");
  assert.equal(entryCategoryEmoji(fee), "💳");
  assert.equal(entryCategoryEmoji(pos), "🧾");
  for (const text of ["카드 실제 입금", "기존 카드 정산차액", "카드 수수료", "카드정산", "과거 카드정산 방식에서 카드매출 매칭금액과 실제 입금액의 차액으로 확정된 기록입니다.", "정산 대상 카드매출", "실제 입금", "정산차액", "차이율"]) assert.ok(page.includes(text), text);
});

test("title override flows through shared list, detail and search display", () => {
  const [edited, automatic, payroll, card, sourced] = build([
    { id: 1, type: "expense", status: "confirmed", business_date: "2026-09-29", amount: 10_000, source_type: "manual", memo: "새 메모", display_snapshot: { titleOverride: "새 제목" } },
    { id: 2, type: "expense", status: "confirmed", business_date: "2026-09-29", amount: 10_000, source_type: "automatic" },
    { id: 3, type: "payroll_payment", status: "confirmed", business_date: "2026-09-29", amount: 10_000, source_type: "manual" },
    { id: 4, type: "card_settlement_deposit", status: "confirmed", business_date: "2026-09-29", amount: 10_000, source_type: "card_settlement_deposit" },
    { id: 5, type: "income", status: "confirmed", business_date: "2026-09-29", amount: 10_000, source_type: "manual", source_key: "generated" },
  ]);
  assert.equal(edited.title, "새 제목");
  assert.equal(edited.memo, "새 메모");
  assert.equal(edited.editableManualDisplay, true);
  for (const entry of [automatic, payroll, card]) assert.equal(entry.editableManualDisplay, false);
  assert.equal(sourced.editableManualDisplay, true);
  assert.match(route, /source_snapshot,display_snapshot,/);
  assert.match(page, /entryDisplayTitle\(entry, lang\)/);
  assert.match(page, /!`\$\{entryDisplayTitle\(entry, lang\)\}/);
  assert.match(page, /<ManualDisplayEditor/);
  assert.match(manualDisplayEditor, /"\/api\/admin\/ledger\/transactions\/" \+ transactionId \+ "\/display"/);
});
