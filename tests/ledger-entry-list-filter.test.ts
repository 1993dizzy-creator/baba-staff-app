import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildLedgerEntries, buildReserveLedgerEntries, entryDisplaySubtotal, withPaymentDifferenceAdjustments, type LedgerEntry, type TransactionRow } from "../lib/ledger/entries.ts";
import { entryFilterHeaderAmount, entryMatchesListFilter, LEDGER_ENTRY_FILTERS, ledgerEntryFilterLabel, type LedgerEntryFilter } from "../lib/ledger/entry-list-filter.ts";
import { entryDisplayBadgeEmoji, entryDisplayBadgeKind, entryDisplayBadgeLabel } from "../lib/ledger/entry-display-badge.ts";
import { entryDisplayAmount, entryDisplayAmountSign } from "../lib/ledger/entry-display-amount.ts";
import { entryCategoryEmoji } from "../lib/ledger/entry-display-emoji.ts";
import { getBusinessDate } from "../lib/common/business-time.ts";

const page = readFileSync("app/(protected)/admin/ledger/entries/page.tsx", "utf8");
const css = readFileSync("app/(protected)/admin/ledger/entries/entries.module.css", "utf8");
const cash = (amount: number) => [{ amount, fund_account: { id: 1, display_name: "매장 현금" } }];
const bank = (amount: number) => [{ amount, fund_account: { id: 2, display_name: "BABA 법인계좌" } }];
const clearingToBank = (amount: number) => [{ amount: -amount, fund_account: { id: 3, display_name: "카드 정산대기" } }, ...bank(amount)];
const day = "2026-09-20";
const at = (hour: number) => `${day}T${String(hour).padStart(2, "0")}:00:00+07:00`;

// --- 9/11 production scenario -------------------------------------------------
const sept11 = "2026-09-11";
const sept11Transactions: TransactionRow[] = [
  { id: 1001, type: "expense", status: "confirmed", business_date: sept11, occurred_at: `${sept11}T09:00:00+07:00`, amount: 11_862_000, source_type: "inventory_purchase_candidate", party_id: 50, party: { name: "Mega Market" }, category: { name: "식자재 매입" },
    source_snapshot: { item_name: "식자재" }, payable: { id: 500, original_amount: 11_862_000, status: "paid", allocations: [{ allocated_amount: 11_862_000, payment: { business_date: sept11, status: "confirmed", movements: bank(-11_862_000) } }] } },
  { id: 1002, type: "payable_payment", status: "confirmed", business_date: sept11, occurred_at: `${sept11}T15:00:00+07:00`, amount: 11_862_000, source_type: "manual", party_id: 50, party: { name: "Mega Market" }, memo: "Mega Market 지급",
    movements: bank(-11_862_000), display_snapshot: { actualPaidAmount: 11_862_600, paymentDifferenceAmount: 600, linkedDifferenceTransactionId: 1003 } },
  { id: 1003, type: "expense", status: "confirmed", business_date: sept11, occurred_at: `${sept11}T15:00:00+07:00`, amount: 600, source_type: "manual", party_id: 50, source_key: "sheet-adjustment:2026-09-11:mega-market:600",
    memo: "Mega Market 9/11 시트 실제 지급 11,862,600₫ - APP 매입원천 11,862,000₫ 차이 600₫ 조정", movements: bank(-600) },
  { id: 1004, type: "card_settlement_deposit", status: "confirmed", business_date: sept11, occurred_at: `${sept11}T11:00:00+07:00`, amount: 2_714_374, source_type: "card_settlement_deposit", movements: clearingToBank(2_714_374) },
];
const sept11Raw = buildLedgerEntries(sept11Transactions, [], new Map(), [], "2026-09");
const sept11Entries = withPaymentDifferenceAdjustments(sept11Raw);

function dayHeader(entries: readonly LedgerEntry[], filter: LedgerEntryFilter, date: string) {
  const rows = entries.filter(entry => entry.businessDate === date && entryMatchesListFilter(entry, filter));
  const pair = rows.reduce((sum, entry) => {
    const subtotal = entryDisplaySubtotal(entry);
    return { income: sum.income + subtotal.income, expense: sum.expense + subtotal.expense };
  }, { income: 0, expense: 0 });
  const amounts = rows.map(entry => entryFilterHeaderAmount(entry, filter));
  const filterAmount = amounts.some(amount => amount !== null) ? amounts.reduce<number>((sum, amount) => sum + (amount ?? 0), 0) : null;
  return { count: rows.length, rows, filterAmount, ...pair };
}
const badge = (entry: LedgerEntry) => entryDisplayBadgeLabel(entryDisplayBadgeKind(entry), "ko");

test("9/11 A — 결제 shows only the Mega Market payment at its actual 11,862,600₫, with no 지출 600₫ in the header", () => {
  const header = dayHeader(sept11Entries, "payment", sept11);
  assert.deepEqual(header.rows.map(entry => entry.transactionId), [1002]);
  assert.equal(badge(header.rows[0]), "결제");
  assert.equal(entryDisplayAmount(header.rows[0]), 11_862_600);
  assert.equal(header.filterAmount, 11_862_600);
  assert.equal(ledgerEntryFilterLabel("payment", "ko"), "결제");
  // The page shows the filter amount instead of the 수입/지출 pair whenever filterAmount is set.
  assert.match(page, /\{group\.filterAmount === null && group\.expense > 0 \?/);
});

test("9/11 B — 카드 shows the actual deposit 2,714,374₫ with a [카드] badge, never as 지출/결제/이체", () => {
  const header = dayHeader(sept11Entries, "card", sept11);
  assert.deepEqual(header.rows.map(entry => entry.transactionId), [1004]);
  assert.equal(badge(header.rows[0]), "카드");
  assert.equal(entryDisplayBadgeEmoji(entryDisplayBadgeKind(header.rows[0])), "💳");
  // Display amount, not the clearing → bank movement net (0).
  assert.equal(header.filterAmount, 2_714_374);
  const deposit = header.rows[0];
  for (const filter of ["expense", "payment", "transfer", "income", "manual", "unpaid"] as const) assert.equal(entryMatchesListFilter(deposit, filter), false, filter);
});

test("9/11 C — 조정 shows the Mega Market 600₫ difference as [조정] ⚖️", () => {
  const header = dayHeader(sept11Entries, "adjustment", sept11);
  assert.equal(header.count, 1);
  const [difference] = header.rows;
  assert.equal(badge(difference), "조정");
  assert.equal(entryDisplayBadgeEmoji(entryDisplayBadgeKind(difference)), "⚖️");
  assert.equal(entryCategoryEmoji(difference), "⚖️");
  assert.equal(difference.title, "Mega Market 지급차액");
  assert.equal(entryDisplayAmount(difference), 600);
  assert.equal(entryDisplayAmountSign(difference), "");
  assert.equal(difference.accountName, "BABA 법인계좌");
  assert.equal(difference.transactionId, null);
  assert.equal(difference.editableManualDisplay, undefined);
  assert.equal(header.filterAmount, 600);
  assert.match(page, /return lang === "vi" \? `Chênh lệch thanh toán \$\{party\}` : `\$\{party\} 지급차액`;/);
});

test("9/11 D — 지출 neither repeats the 600₫ difference nor shows the card deposit", () => {
  const ids = dayHeader(sept11Entries, "expense", sept11).rows.map(entry => entry.id);
  assert.ok(!ids.some(id => id.includes("payment-difference")));
  assert.ok(!ids.includes("transaction:1004"));
  assert.ok(!ids.includes("transaction:1003"));
  assert.ok(!dayHeader(sept11Entries, "manual", sept11).rows.some(entry => entry.userAdjustment));
});

test("9/11 E — 전체 keeps the same visible rows and the same 수입/지출 subtotal, including the 600₫ cash-out", () => {
  const before = sept11Raw.filter(entry => !entry.isSystemAdjustment);
  const all = dayHeader(sept11Entries, "all", sept11);
  assert.deepEqual(all.rows, before);
  assert.equal(all.rows.some(entry => entry.transactionId === 1003 || entry.paymentDifference), false);
  const beforeTotal = before.reduce((sum, entry) => sum + entryDisplaySubtotal(entry).expense, 0);
  assert.equal(all.expense, beforeTotal);
  // inventory 11,862,000 + payment difference 600 (via the payment row).
  assert.equal(all.expense, 11_862_600);
  assert.equal(all.filterAmount, null);
});

// --- broad fixture ------------------------------------------------------------
const transactions: TransactionRow[] = [
  { id: 1, type: "income", status: "confirmed", business_date: day, occurred_at: at(9), amount: 100, source_type: "manual", memo: "기타 수입", movements: cash(100) },
  { id: 2, type: "expense", status: "confirmed", business_date: day, occurred_at: at(10), amount: 200, source_type: "manual", memo: "소모품", movements: cash(-200) },
  { id: 3, type: "expense", status: "confirmed", business_date: day, occurred_at: at(11), amount: 300, source_type: "manual", memo: "외상 매입", payable: { id: 30, original_amount: 300, status: "open", allocations: [] } },
  { id: 4, type: "payable_payment", status: "confirmed", business_date: day, occurred_at: at(12), amount: 400, source_type: "manual", memo: "지급", party: { name: "Chợ" }, movements: cash(-400) },
  { id: 5, type: "card_settlement_deposit", status: "confirmed", business_date: day, occurred_at: at(13), amount: 500, source_type: "card_settlement_deposit", movements: clearingToBank(500) },
  { id: 6, type: "expense", status: "confirmed", business_date: day, occurred_at: at(14), amount: 60, source_type: "card_fee_month_close", category: { name: "카드 수수료" } },
  { id: 7, type: "transfer", status: "confirmed", business_date: day, occurred_at: at(15), amount: 700, source_type: "manual", memo: "현금 입금", movements: [{ amount: -700, fund_account: { id: 1, display_name: "매장 현금" } }, ...bank(700)] },
  { id: 8, type: "payroll_payment", status: "confirmed", business_date: day, occurred_at: at(16), amount: 800, source_type: "payroll_payment", movements: cash(-800) },
  { id: 9, type: "balance_adjustment", status: "confirmed", business_date: day, occurred_at: at(17), amount: 900, source_type: "manual", memo: "월말 잔액 맞춤", movements: cash(900) },
  { id: 10, type: "expense", status: "confirmed", business_date: day, occurred_at: at(18), amount: 50, source_type: "ledger_correction", correction_of_id: 99, economic_effect_sign: -1, memo: "시스템 정정" },
  { id: 11, type: "investment", status: "confirmed", business_date: day, occurred_at: at(19), amount: 1_100, source_type: "owner_investment", memo: "Cho 투자금", movements: cash(1_100) },
  { id: 12, type: "expense", status: "confirmed", business_date: day, occurred_at: at(20), amount: 70, source_type: "manual", source_key: "sheet-adjustment:2026-09-20:chợ:70", memo: "Chợ 시트 차이 70₫ 조정", movements: cash(-70) },
  { id: 13, type: "expense", status: "confirmed", business_date: day, occurred_at: at(21), amount: 20, source_type: "card_settlement_difference", source_snapshot: { matchedGrossAmount: 1_000, depositAmount: 980, differenceAmount: 20 } },
  { id: 14, type: "expense", status: "confirmed", business_date: day, occurred_at: at(22), amount: 20, source_type: "card_settlement_difference_reversal", correction_of_id: 13, economic_effect_sign: -1 },
  { id: 15, type: "sales", status: "confirmed", business_date: day, occurred_at: at(3), amount: 5_000, source_type: "pos_sales_daily_payment", source_key: "pos:2026-09-20:card", source_snapshot: { receiptCount: 3 } },
];
const reserve = buildReserveLedgerEntries(
  [{ id: 41, reserve_plan_id: 7, entry_type: "allocate", amount: 60_000_000, occurred_at: at(23) }],
  [{ id: 7, name: "다음 연간 임대료 준비금", fund_account_id: 2 }], new Map([[2, "BABA 법인계좌"]]), "2026-09", getBusinessDate,
);
const pendingCandidate = { id: 1, business_date: day, proposed_amount: 120, proposed_party_id: null, party: { name: "OK FOOD" }, source_snapshot: { item_name: "치즈" } };
const raw: LedgerEntry[] = [...buildLedgerEntries(transactions, [pendingCandidate], new Map(), [], "2026-09"), ...reserve];
const entries = withPaymentDifferenceAdjustments(raw);
const pending = "pending-inventory:2026-09-20:supplier:ok food:verification_pending:none";
const visible = (filter: LedgerEntryFilter) =>
  entries.filter(entry => entryMatchesListFilter(entry, filter)).map(entry => entry.transactionId ?? entry.id).sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }));

test("utilities uses only actual joined electricity/water/gas categories and expense identity", () => {
  const categories = ["전기료", "수도료", "가스비", "인터넷·통신비", "공과금", "기타 비용", "Điện nước", "가스", "전기료 할인"];
  const transactions: TransactionRow[] = categories.map((name, index) => ({
    id: 200 + index, type: "expense", status: "confirmed", business_date: day,
    amount: (index + 1) * 100, source_type: "manual", category: { id: index + 1, name },
    memo: "전기료 수도료 가스비", party: { name: "💡 전기료" }, movements: cash(-(index + 1) * 100),
  }));
  transactions.push({ id: 300, type: "income", business_date: day, amount: 700, source_type: "manual", category: { name: "전기료" }, movements: cash(700) });
  transactions.push({ id: 301, type: "transfer", business_date: day, amount: 800, source_type: "manual", category: { name: "수도료" }, movements: [...cash(-800), ...bank(800)] });
  transactions.push({ id: 302, type: "payable_payment", business_date: day, amount: 900, source_type: "manual", category: { name: "가스비" }, movements: cash(-900) });
  transactions.push({ id: 303, type: "card_settlement_deposit", business_date: day, amount: 1000, source_type: "card_settlement_deposit", category: { name: "전기료" }, movements: clearingToBank(1000) });
  transactions.push({ id: 304, type: "balance_adjustment", business_date: day, amount: 1100, source_type: "manual", category: { name: "전기료" }, movements: cash(-1100) });
  transactions.push({ id: 305, type: "expense", business_date: day, amount: 1200, source_type: "payroll", category: { name: "가스비" }, movements: cash(-1200) });
  transactions.push({ id: 306, type: "expense", business_date: day, amount: 1300, source_type: "manual", category: null,
    source_snapshot: { category: "전기료" }, movements: cash(-1300) });
  const mapped = buildLedgerEntries(transactions, [], new Map(), [], "2026-09");
  assert.deepEqual(mapped.filter(entry => entryMatchesListFilter(entry, "utilities")).map(entry => entry.transactionId), [200, 201, 202]);
  const header = dayHeader(mapped, "utilities", day);
  assert.equal(header.filterAmount, 600);
  assert.equal(header.count, 3);
  assert.equal(ledgerEntryFilterLabel("utilities", "ko"), "공과금");
  assert.equal(ledgerEntryFilterLabel("utilities", "vi"), "Điện nước");
});

test("utilities header stays date-scoped and reuses signed expense subtotals", () => {
  const mapped = buildLedgerEntries([
    { id: 400, type: "expense", business_date: day, amount: 200, source_type: "manual", category: { name: "전기료" } },
    { id: 401, type: "expense", business_date: "2026-09-21", amount: 300, source_type: "manual", category: { name: "수도료" } },
  ], [], new Map(), [], "2026-09");
  assert.equal(dayHeader(mapped, "utilities", day).filterAmount, 200);
  assert.equal(dayHeader(mapped, "utilities", "2026-09-21").filterAmount, 300);
  const firstDay = mapped.find(entry => entry.transactionId === 400)!;
  assert.equal(entryFilterHeaderAmount({ ...firstDay, economicEffectSign: -1 }, "utilities"), -200);
  for (const filter of ["all", "income", "expense"] as const) {
    assert.equal(entryFilterHeaderAmount(mapped[0], filter), null);
  }
  const system = { ...mapped[0], isSystemAdjustment: true };
  assert.equal(entryMatchesListFilter(system, "utilities"), false);
  assert.equal(entryFilterHeaderAmount(system, "utilities"), 0);
});

test("pill order and labels come from the shared filter list", () => {
  assert.deepEqual([...LEDGER_ENTRY_FILTERS], ["all", "income", "expense", "utilities", "unpaid", "payment", "card", "transfer", "payroll", "adjustment", "investment", "manual", "reserve", "pending"]);
  assert.deepEqual(LEDGER_ENTRY_FILTERS.map(filter => ledgerEntryFilterLabel(filter, "ko")), ["전체", "수입", "지출", "공과금", "미납", "결제", "카드", "이체", "급여", "조정", "투자금", "수동", "준비금", "확인 필요"]);
  assert.match(page, /\{LEDGER_ENTRY_FILTERS\.map\(\(value\) => \[value, ledgerEntryFilterLabel\(value, lang\)\] as const\)\.map\(\(\[value, label\]\) => \(/);
});

test("each filter has one user meaning; card and adjustment rows are exclusive to their own filter", () => {
  assert.deepEqual(visible("all"), [1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 13, 15, pending, "reserve-entry:41"]);
  assert.deepEqual(visible("income"), [1, 15]);
  assert.deepEqual(visible("expense"), [2, 3, 8, pending]);
  assert.deepEqual(visible("unpaid"), [3]);
  assert.deepEqual(visible("payment"), [4]);
  assert.deepEqual(visible("card"), [5, 6, 13]);
  assert.deepEqual(visible("transfer"), [7]);
  assert.deepEqual(visible("payroll"), [8]);
  assert.deepEqual(visible("manual"), [1, 2, 3, 4, 7]);
  assert.deepEqual(visible("pending"), [pending]);
  assert.deepEqual(visible("adjustment"), [9, 12]);
  assert.deepEqual(visible("investment"), [11]);
  assert.deepEqual(visible("reserve"), ["reserve-entry:41"]);
  // Badges agree with the filters.
  const byId = (id: number) => entries.find(entry => entry.transactionId === id)!;
  assert.deepEqual([5, 6, 13].map(id => badge(byId(id))), ["카드", "카드", "카드"]);
  assert.deepEqual([9, 12].map(id => badge(byId(id))), ["조정", "조정"]);
  assert.deepEqual([9, 12].map(id => entryCategoryEmoji(byId(id))), ["⚖️", "⚖️"]);
  assert.equal(badge(byId(4)), "결제");
  assert.equal(badge(byId(15)), "수입");
  assert.equal(badge(byId(11)), "투자금");
});

test("system corrections and reversals stay hidden from every filter, including 조정", () => {
  for (const id of [10, 14]) {
    const entry = entries.find(row => row.transactionId === id)!;
    assert.equal(entry.isSystemAdjustment, true);
    assert.deepEqual(LEDGER_ENTRY_FILTERS.filter(filter => entryMatchesListFilter(entry, filter)), [], `transaction ${id}`);
  }
  const balance = entries.find(entry => entry.transactionId === 9)!;
  assert.equal(balance.userAdjustment, "balance");
  assert.deepEqual(LEDGER_ENTRY_FILTERS.filter(filter => entryMatchesListFilter(balance, filter)), ["adjustment"]);
  const sheet = entries.find(entry => entry.transactionId === 12)!;
  assert.equal(sheet.userAdjustment, "paymentDifference");
  // A standalone sheet adjustment was already visible in 전체 and stays there (now as [조정]).
  assert.deepEqual(LEDGER_ENTRY_FILTERS.filter(filter => entryMatchesListFilter(sheet, filter)), ["all", "adjustment"]);
});

test("every filter's date header uses its visible rows only; 전체 subtotal is unchanged", () => {
  const expectedHeader: Record<LedgerEntryFilter, { filterAmount: number | null; income?: number; expense?: number }> = {
    all: { filterAmount: null, income: 5_100, expense: 200 + 300 + 60 + 800 + 70 + 20 + 120 },
    income: { filterAmount: null, income: 5_100, expense: 0 },
    expense: { filterAmount: null, income: 0, expense: 200 + 300 + 800 + 120 },
    utilities: { filterAmount: null, income: 0, expense: 0 },
    unpaid: { filterAmount: null, income: 0, expense: 300 },
    payment: { filterAmount: 400 },
    card: { filterAmount: 500 - 60 - 20 },
    transfer: { filterAmount: 700 },
    payroll: { filterAmount: null, income: 0, expense: 800 },
    manual: { filterAmount: null, income: 100, expense: 200 + 300 },
    pending: { filterAmount: null, income: 0, expense: 120 },
    adjustment: { filterAmount: 900 + 70 },
    investment: { filterAmount: 1_100 },
    reserve: { filterAmount: 60_000_000 },
  };
  for (const filter of LEDGER_ENTRY_FILTERS) {
    const header = dayHeader(entries, filter, day);
    assert.equal(header.count, visible(filter).length, `${filter} count`);
    const expected = expectedHeader[filter];
    assert.equal(header.filterAmount, expected.filterAmount, `${filter} amount`);
    if (expected.filterAmount === null) assert.deepEqual([header.income, header.expense], [expected.income, expected.expense], `${filter} pair`);
  }
  // 전체 equals the pre-change visible set and subtotal.
  const before = raw.filter(entry => !entry.isSystemAdjustment);
  const all = dayHeader(entries, "all", day);
  assert.deepEqual(all.rows, before);
  assert.deepEqual([all.income, all.expense], [
    before.reduce((sum, entry) => sum + entryDisplaySubtotal(entry).income, 0),
    before.reduce((sum, entry) => sum + entryDisplaySubtotal(entry).expense, 0),
  ]);
  assert.match(page, /const headerAmount = entryFilterHeaderAmount\(entry, filter\);/);
  assert.match(css, /\.dateFilterAmount\{/);
  assert.match(css, /\.direction\.card\{/);
  assert.match(css, /\.direction\.adjustment\{/);
});

test("pills stay on one horizontally scrolling line with hidden scrollbar and no arrow buttons", () => {
  assert.match(css, /\.filterTabs\{display:flex;gap:5px;overflow-x:auto;scrollbar-width:none\}/);
  assert.match(css, /\.filterTabs\{flex-wrap:nowrap;-webkit-overflow-scrolling:touch;overscroll-behavior-x:contain;touch-action:pan-x pan-y;/);
  assert.match(css, /\.filterTabs::-webkit-scrollbar\{display:none\}/);
  assert.match(css, /\.filterTabs button\{flex:0 0 auto;/);
  assert.doesNotMatch(css, /\.filterTabs\{[^}]*flex-wrap:wrap/);
  const tabs = page.slice(page.indexOf("<div className={styles.filterTabs}>"), page.indexOf("<input", page.indexOf("<div className={styles.filterTabs}>")));
  assert.match(tabs, /event\.currentTarget\.scrollIntoView\(\{ block: "nearest", inline: "nearest", behavior: "smooth" \}\)/);
  assert.equal((tabs.match(/<button/g) ?? []).length, 1);
});
