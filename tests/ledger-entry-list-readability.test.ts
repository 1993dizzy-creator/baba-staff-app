import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildLedgerEntries, entryDisplaySubtotal, type LedgerEntry, type TransactionRow } from "../lib/ledger/entries.ts";
import { entryDisplayAmountSign, entryDisplayAmountTone } from "../lib/ledger/entry-display-amount.ts";
import { entryMatchesListFilter, LEDGER_ENTRY_FILTERS } from "../lib/ledger/entry-list-filter.ts";
import { balanceAdjustmentListTitle } from "../lib/ledger/entry-list-title.ts";

const page = readFileSync("app/(protected)/admin/ledger/entries/page.tsx", "utf8");
const css = readFileSync("app/(protected)/admin/ledger/entries/entries.module.css", "utf8");
const cash = (amount: number) => [{ amount, fund_account: { id: 1, display_name: "매장 현금" } }];
const bank = (amount: number) => [{ amount, fund_account: { id: 2, display_name: "BABA 법인계좌" } }];

// Production shapes (memo shortened only where noted).
const memo4127 = "11월 1일 시트 G15 테이블13 수기 정산 +802,000₫ vs APP POS 정정분 +801,900₫의 100₫ 소액차이. 원 POS 영수증 금액·매출 변경 없이 시트 정본 기준 비손익 현금 정산조정 +100₫.";
const memo4181 = "2026-11-05 시트 11월!G78 br4 실수령 현금 262,000₫ vs CUKCUK 영수증 M-261105-001 262,600₫ 차이 −600₫. 베트남 현금 잔돈 부족에 따른 비손익 현금 정산조정. POS 매출 및 영수증 원본 불변.";
const memo4128 = "11월 2일 시트 G29 정산오류(Lỗi đối soát) -90,000₫; 사용자 확인상 원인 불명 정산오류로 유지. POS/급여/원가를 억지로 변경하지 않고 비손익 현금 정산조정 -90,000₫.";
const adjustment = (id: number, day: string, amount: number, memo: string, movements = cash(amount)): TransactionRow => ({
  id, type: "balance_adjustment", status: "confirmed", source_type: "manual", business_date: day, occurred_at: `${day}T12:00:00+07:00`,
  amount: Math.abs(amount), economic_effect_sign: 1, memo, movements,
});
const rows: TransactionRow[] = [
  adjustment(4127, "2026-11-01", 100, memo4127),
  adjustment(4128, "2026-11-02", -90_000, memo4128),
  adjustment(4181, "2026-11-05", -600, memo4181),
  adjustment(3118, "2026-11-05", 500_000, "법인계좌 잔액 조정", bank(500_000)),
  { id: 4180, type: "income", status: "confirmed", source_type: "manual", business_date: "2026-11-05", occurred_at: "2026-11-05T10:00:00+07:00", amount: 262_600, memo: "기타 수입", movements: cash(262_600) },
  { id: 4182, type: "expense", status: "confirmed", source_type: "manual", business_date: "2026-11-05", occurred_at: "2026-11-05T11:00:00+07:00", amount: 557_000, memo: "소모품", movements: cash(-557_000) },
  { id: 4183, type: "transfer", status: "confirmed", source_type: "manual", business_date: "2026-11-05", occurred_at: "2026-11-05T13:00:00+07:00", amount: 2_356_200, memo: "현금 → Cho 정산",
    movements: [{ amount: -2_356_200, fund_account: { id: 1, display_name: "매장 현금" } }, { amount: 2_356_200, fund_account: { id: 3, display_name: "개인(Cho)" } }] },
];
const entries = buildLedgerEntries(rows, [], new Map(), [], "2026-11");
const byId = (id: number) => entries.find(entry => entry.transactionId === id)!;

test("manual balance adjustments are signed by their real fund movement: #4127 +100₫, #4181 −600₫", () => {
  assert.deepEqual([4127, 4128, 4181, 3118].map(id => entryDisplayAmountSign(byId(id))), ["+", "−", "−", "+"]);
  assert.deepEqual([4127, 4128, 4181, 3118].map(id => entryDisplayAmountTone(byId(id))), ["income", "expense", "expense", "income"]);
  // Non-P&L: nothing new is added to the day's 수입/지출, and the [조정] badge identity stays.
  for (const id of [4127, 4128, 4181, 3118]) {
    assert.deepEqual(entryDisplaySubtotal(byId(id)), { income: 0, expense: 0 }, `#${id}`);
    assert.equal(byId(id).userAdjustment, "balance");
  }
  const day = entries.filter(entry => entry.businessDate === "2026-11-05" && entryMatchesListFilter(entry, "all"))
    .reduce((sum, entry) => ({ income: sum.income + entryDisplaySubtotal(entry).income, expense: sum.expense + entryDisplaySubtotal(entry).expense }), { income: 0, expense: 0 });
  assert.deepEqual(day, { income: 262_600, expense: 557_000 });
});

test("income +, expense − stay; transfers, payments, payment differences and prepaid allocations stay unsigned", () => {
  assert.equal(entryDisplayAmountSign(byId(4180)), "+");
  assert.equal(entryDisplayAmountSign(byId(4182)), "−");
  assert.equal(entryDisplayAmountSign(byId(4183)), "");
  const base = { direction: "expense", payrollPayment: false, systemDisplay: undefined } as const;
  const unsigned: Pick<LedgerEntry, "direction" | "paymentTransaction" | "payrollPayment" | "fundFlow" | "systemDisplay" | "userAdjustment" | "prepaidAllocation">[] = [
    { ...base, paymentTransaction: false, fundFlow: "outflow", userAdjustment: "paymentDifference" },
    { ...base, paymentTransaction: false, fundFlow: "none", prepaidAllocation: { planName: null, monthlyAmount: 1, effectiveFrom: null, rent: false } as LedgerEntry["prepaidAllocation"] },
    { ...base, direction: "transfer", paymentTransaction: true, fundFlow: "outflow" },
  ];
  for (const entry of unsigned) {
    assert.equal(entryDisplayAmountSign(entry), "");
    assert.equal(entryDisplayAmountTone(entry), "transfer");
  }
  // A balance adjustment without a net movement gets no invented sign.
  assert.equal(entryDisplayAmountSign({ ...base, direction: "transfer", paymentTransaction: false, fundFlow: "none", userAdjustment: "balance" }), "");
});

test("long adjustment memos become short list titles (KO/VI); short user titles and the original memo are kept", () => {
  const title = (id: number, lang: "ko" | "vi") => balanceAdjustmentListTitle(byId(id), lang);
  assert.deepEqual([4127, 4181, 4128, 3118].map(id => title(id, "ko")), ["현금 정산차이", "현금 반올림 조정", "현금 정산오류", "법인계좌 잔액 조정"]);
  assert.deepEqual([4127, 4181, 4128].map(id => title(id, "vi")), ["Chênh lệch đối soát tiền mặt", "Làm tròn tiền mặt", "Lỗi đối soát tiền mặt"]);
  // Only manual balance adjustments are retitled.
  for (const id of [4180, 4182, 4183]) assert.equal(balanceAdjustmentListTitle(byId(id), "ko"), null);
  // The entry keeps the full original memo for the detail sheet and search.
  assert.equal(byId(4181).memo, memo4181);
  assert.equal(byId(4127).memo, memo4127);
});

test("#4181 stays one entry under 전체 and 조정 only", () => {
  const entry = byId(4181);
  assert.deepEqual(LEDGER_ENTRY_FILTERS.filter(filter => entryMatchesListFilter(entry, filter)), ["all", "adjustment"]);
  assert.equal(entries.filter(row => row.transactionId === 4181).length, 1);
});

test("page: list title via entryDisplayTitle, compact meta, full memo in detail and search, one-line ellipsis", () => {
  const displayTitle = page.slice(page.indexOf("function entryDisplayTitle"), page.indexOf("function reserveLabel"));
  assert.match(displayTitle, /return balanceAdjustmentListTitle\(entry, lang\) \?\? entry\.title;/);
  const meta = page.slice(page.indexOf("function entryMeta"), page.indexOf("function compactEntryListTitle"));
  assert.match(meta, /if \(entry\.userAdjustment === "balance"\) return "";/);
  assert.match(meta, /: `\$\{entry\.systemDisplay\.receiptCount\.toLocaleString\("ko-KR"\)\}건`;/);
  assert.doesNotMatch(meta, /영수증 \$\{/);
  // Search still reads the original memo; the detail sheet still shows it in full.
  assert.match(page, /!`\$\{entryDisplayTitle\(entry, lang\)\} \$\{entryMeta\(entry, lang\)\} \$\{entry\.accountName \?\? ""\} \$\{entry\.categoryName \?\? ""\} \$\{entry\.memo \?\? ""\}/);
  assert.match(page, /<p className=\{styles\.detailMemoText\}>\{entry\.memo\}<\/p>/);
  // Mobile: the title ellipsizes on one line; account and amount keep their own column.
  assert.match(css, /\.entryMain strong\{flex:0 1 auto;min-width:0;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap\}/);
  assert.match(css, /\.entryRow\{grid-template-columns:minmax\(0,1fr\) max-content;gap:8px\}/);
  assert.match(css, /\.entryRight\{display:grid;justify-items:end;gap:2px;min-width:0;white-space:nowrap\}/);
});
