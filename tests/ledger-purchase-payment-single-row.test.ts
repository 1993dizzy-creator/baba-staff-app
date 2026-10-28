import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
// @ts-expect-error Node's local strip-types test runner requires the extension.
import { buildLedgerEntries, entryDisplaySubtotal, withPaymentDifferenceAdjustments, type LedgerEntry, type TransactionRow } from "../lib/ledger/entries.ts";
// @ts-expect-error Node's local strip-types test runner requires the extension.
import { entryFilterHeaderAmount, entryMatchesListFilter, LEDGER_ENTRY_FILTERS, ledgerEntryFilterLabel, type LedgerEntryFilter } from "../lib/ledger/entry-list-filter.ts";
// @ts-expect-error Node's local strip-types test runner requires the extension.
import { entryDisplayBadgeKind, entryDisplayBadgeLabel } from "../lib/ledger/entry-display-badge.ts";
// @ts-expect-error Node's local strip-types test runner requires the extension.
import { entryDisplayAmount } from "../lib/ledger/entry-display-amount.ts";

// One purchase is listed once: 미납 → 일부결제 → 결제. A payable payment fully
// applied to purchases in the view is read in their detail, never as its own
// row; the payment transaction, allocations and movements stay in the data.

const page = readFileSync("app/(protected)/admin/ledger/entries/page.tsx", "utf8");
const css = readFileSync("app/(protected)/admin/ledger/entries/entries.module.css", "utf8");
const CASH = { id: 1, code: "store_cash", display_name: "매장 현금" };
const BANK = { id: 2, code: "corporate_bank", display_name: "BABA 법인계좌" };
type Account = typeof CASH;

const payment = (id: number, date: string, amount: number, account: Account, party: [number, string]): TransactionRow => ({
  id, type: "payable_payment", status: "confirmed", business_date: date, occurred_at: `${date}T12:00:00+07:00`,
  amount, source_type: "manual", party_id: party[0], party: { name: party[1] }, memo: `${date} ${party[1]} 지급`,
  movements: [{ amount: -amount, fund_account: account }],
});
const applied = (paymentRow: TransactionRow, amount: number) => ({
  allocated_amount: amount,
  payment: { id: paymentRow.id, type: "payable_payment", source_type: "manual", amount: paymentRow.amount, business_date: paymentRow.business_date, status: "confirmed", movements: paymentRow.movements },
});
const purchase = (id: number, date: string, amount: number, party: [number, string], allocations: ReturnType<typeof applied>[] = []): TransactionRow => ({
  id, type: "expense", status: "confirmed", business_date: date, occurred_at: `${date}T03:00:00+07:00`, amount,
  source_type: "inventory_purchase_candidate", party_id: party[0], party: { name: party[1] }, category: { id: 9, name: "식자재 매입" },
  source_snapshot: { inventory_log_id: id + 10_000, item_name: `품목 ${id}`, change_quantity: 1, purchase_price: amount },
  payable: { id: id + 50_000, original_amount: amount, status: "open", allocations },
});

const listed = (entries: readonly LedgerEntry[], filter: LedgerEntryFilter, date?: string) =>
  entries.filter(entry => (!date || entry.businessDate === date) && entryMatchesListFilter(entry, filter));
const badge = (entry: LedgerEntry, lang: "ko" | "vi" = "ko") => entryDisplayBadgeLabel(entryDisplayBadgeKind(entry), lang);
const dayPair = (entries: readonly LedgerEntry[], filter: LedgerEntryFilter, date: string) =>
  listed(entries, filter, date).reduce((sum, entry) => {
    const subtotal = entryDisplaySubtotal(entry);
    return { income: sum.income + subtotal.income, expense: sum.expense + subtotal.expense };
  }, { income: 0, expense: 0 });
const transactionIds = (entries: readonly LedgerEntry[]) =>
  entries.flatMap(entry => entry.drilldown === "inventory" ? entry.items.map(item => item.transactionId) : [entry.transactionId]).sort();

// --- 10/3 production scenario (ids and amounts as recorded) -------------------
const oct3 = "2026-10-03";
const MILAN: [number, string] = [4, "Milan Food"], WOW: [number, string] = [3, "Wow Spirit"], CHO: [number, string] = [10, "Chợ"],
  DABACO: [number, string] = [2, "Dabaco"], ANLIEN: [number, string] = [27, "An Liên"];
const p2405 = payment(2405, oct3, 1_410_000, BANK, MILAN);
const p2398 = payment(2398, oct3, 2_896_000, BANK, WOW);
const p2403 = payment(2403, oct3, 203_000, CASH, CHO);
const p2404 = payment(2404, oct3, 250_000, CASH, DABACO);
const p2406 = payment(2406, oct3, 99_000, CASH, ANLIEN);
const oct3Payments = [p2398, p2403, p2404, p2405, p2406];
const oct3Purchases = [
  purchase(2224, oct3, 250_000, DABACO, [applied(p2404, 250_000)]),
  // Chợ #2225 was paid 51,000 of 52,000: it stays 일부결제.
  purchase(2225, oct3, 52_000, CHO, [applied(p2403, 51_000)]),
  purchase(2226, oct3, 22_000, CHO, [applied(p2403, 22_000)]),
  purchase(2227, oct3, 80_000, CHO, [applied(p2403, 80_000)]),
  purchase(2228, oct3, 50_000, CHO, [applied(p2403, 50_000)]),
  purchase(2236, oct3, 1_130_000, WOW, [applied(p2398, 1_130_000)]),
  purchase(2237, oct3, 1_196_000, WOW, [applied(p2398, 1_196_000)]),
  purchase(2238, oct3, 570_000, WOW, [applied(p2398, 570_000)]),
  purchase(2239, oct3, 1_410_000, MILAN, [applied(p2405, 1_410_000)]),
  purchase(2240, oct3, 99_000, ANLIEN, [applied(p2406, 99_000)]),
];
const oct3Raw = buildLedgerEntries([...oct3Purchases, ...oct3Payments], [], new Map(), [], "2026-10");
const oct3Entries = withPaymentDifferenceAdjustments(oct3Raw);
const groupOfIn = (entries: readonly LedgerEntry[], transactionId: number) => entries.find(entry => entry.items.some(item => item.transactionId === transactionId))!;
const groupOf = (transactionId: number) => groupOfIn(oct3Entries, transactionId);

test("10/3 — every purchase is listed once and no payment row (#2398 #2403~#2406) appears in any filter", () => {
  const all = listed(oct3Entries, "all", oct3);
  assert.deepEqual(transactionIds(all), [2224, 2225, 2226, 2227, 2228, 2236, 2237, 2238, 2239, 2240]);
  for (const id of [2398, 2403, 2404, 2405, 2406]) {
    const row = oct3Entries.find(entry => entry.transactionId === id)!;
    // Kept in the data (cash/bank balance, audit) but never a list row.
    assert.equal(row.paymentSettledInPayables, true, `#${id}`);
    assert.equal(row.fundFlow, "outflow");
    assert.deepEqual(LEDGER_ENTRY_FILTERS.filter(filter => entryMatchesListFilter(row, filter)), [], `#${id}`);
  }
  assert.equal(all.length, 6);
});

test("10/3 Milan Food #2239 → #2405 reads [결제] 1,410,000₫ with the payment in its detail", () => {
  const milan = groupOf(2239);
  assert.equal(badge(milan), "결제");
  assert.equal(badge(milan, "vi"), "Thanh toán");
  assert.notEqual(badge(milan), "지출");
  assert.equal(entryDisplayAmount(milan), 1_410_000);
  assert.equal(milan.settlementStatus, "paid");
  assert.equal(milan.accountName, "BABA 법인계좌");
  assert.deepEqual(milan.payablePayments, [{ transactionId: 2405, businessDate: oct3, amount: 1_410_000, paymentAmount: 1_410_000, accountName: "BABA 법인계좌", linkedTransactionIds: [2239] }]);
});

test("10/3 Wow Spirit #2236~2238 → #2398: one [결제] row, one payment linking all three 청구서", () => {
  const wow = groupOf(2236);
  assert.deepEqual(wow.items.map(item => item.transactionId).sort(), [2236, 2237, 2238]);
  assert.equal(badge(wow), "결제");
  assert.equal(wow.amount, 2_896_000);
  assert.deepEqual(wow.payablePayments, [{ transactionId: 2398, businessDate: oct3, amount: 2_896_000, paymentAmount: 2_896_000, accountName: "BABA 법인계좌", linkedTransactionIds: [2236, 2237, 2238] }]);
});

test("10/3 Chợ #2225~2228 → #2403: paid rows read [결제], #2225 (51,000 of 52,000) reads [일부결제]", () => {
  const paid = groupOf(2226), partial = groupOf(2225);
  assert.notEqual(paid, partial);
  assert.deepEqual(paid.items.map(item => item.transactionId).sort(), [2226, 2227, 2228]);
  assert.equal(badge(paid), "결제");
  assert.equal(paid.accountName, "매장 현금");
  assert.equal(badge(partial), "일부결제");
  assert.equal(badge(partial, "vi"), "Trả một phần");
  assert.equal(partial.remainingAmount, 1_000);
  assert.equal(partial.accountName, "미지급");
  assert.deepEqual(partial.payablePayments?.map(item => [item.transactionId, item.amount, item.paymentAmount, item.linkedTransactionIds]), [[2403, 51_000, 203_000, [2225, 2226, 2227, 2228]]]);
  assert.deepEqual(paid.payablePayments?.map(item => [item.transactionId, item.amount, item.paymentAmount]), [[2403, 152_000, 203_000]]);
  assert.deepEqual(listed(oct3Entries, "partial", oct3), [partial]);
  assert.equal(entryMatchesListFilter(partial, "unpaid"), false);
});

test("10/3 Dabaco #2224 → #2404 and An Liên #2240 → #2406 read [결제] with the cash account", () => {
  for (const [id, paymentId, amount] of [[2224, 2404, 250_000], [2240, 2406, 99_000]] as const) {
    const group = groupOf(id);
    assert.equal(badge(group), "결제");
    assert.equal(group.accountName, "매장 현금");
    assert.deepEqual(group.payablePayments?.map(item => [item.transactionId, item.amount, item.accountName]), [[paymentId, amount, "매장 현금"]]);
  }
});

test("10/3 — filters, counts and header amounts follow the single purchase rows", () => {
  assert.deepEqual(transactionIds(listed(oct3Entries, "payment", oct3)), [2224, 2226, 2227, 2228, 2236, 2237, 2238, 2239, 2240]);
  assert.deepEqual(transactionIds(listed(oct3Entries, "partial", oct3)), [2225]);
  assert.deepEqual(listed(oct3Entries, "unpaid", oct3), []);
  assert.equal(listed(oct3Entries, "manual", oct3).length, 0);
  assert.equal(listed(oct3Entries, "transfer", oct3).length, 0);
  // 지출 stays the accounting expense filter: every purchase, whatever its status.
  assert.equal(transactionIds(listed(oct3Entries, "expense", oct3)).length, 10);
  const paidTotal = listed(oct3Entries, "payment", oct3).reduce((sum, entry) => sum + (entryFilterHeaderAmount(entry, "payment") ?? 0), 0);
  assert.equal(paidTotal, 250_000 + 152_000 + 2_896_000 + 1_410_000 + 99_000);
  assert.equal(entryFilterHeaderAmount(groupOf(2225), "partial"), null);
  // 전체 subtotal: total purchase cost only — the payments never added to it.
  const purchaseTotal = oct3Purchases.reduce((sum, row) => sum + Number(row.amount), 0);
  assert.deepEqual(dayPair(oct3Entries, "all", oct3), { income: 0, expense: purchaseTotal });
  const everyRow = oct3Raw.reduce((sum, entry) => sum + entryDisplaySubtotal(entry).expense, 0);
  assert.equal(everyRow, purchaseTotal);
});

// --- other dates, batches, partial and month boundary ------------------------
const PARTY: [number, string] = [70, "Trung Đông"];

test("a payment on a later date of the month lists nothing on the payment date", () => {
  const pay = payment(3002, "2026-10-12", 400_000, BANK, PARTY);
  const entries = withPaymentDifferenceAdjustments(buildLedgerEntries([purchase(3001, "2026-10-05", 400_000, PARTY, [applied(pay, 400_000)]), pay], [], new Map(), [], "2026-10"));
  assert.deepEqual(listed(entries, "all", "2026-10-12"), []);
  const [row] = listed(entries, "all", "2026-10-05");
  assert.equal(badge(row), "결제");
  assert.deepEqual(row.payablePayments?.map(item => [item.businessDate, item.accountName, item.amount]), [["2026-10-12", "BABA 법인계좌", 400_000]]);
});

test("one payment for 청구서 on several dates settles each purchase and links them", () => {
  const pay = payment(3013, "2026-10-08", 700_000, CASH, PARTY);
  const entries = buildLedgerEntries([
    purchase(3011, "2026-10-05", 300_000, PARTY, [applied(pay, 300_000)]),
    purchase(3012, "2026-10-06", 400_000, PARTY, [applied(pay, 400_000)]),
    pay,
  ], [], new Map(), [], "2026-10");
  assert.equal(entries.find(entry => entry.transactionId === 3013)?.paymentSettledInPayables, true);
  const rows = listed(entries, "all");
  assert.deepEqual(rows.map(entry => [entry.businessDate, badge(entry)]).sort(), [["2026-10-05", "결제"], ["2026-10-06", "결제"]]);
  for (const row of rows) assert.deepEqual(row.payablePayments?.[0].linkedTransactionIds, [3011, 3012]);
});

test("split payments: 미납 → 일부결제 → 결제 with the split history in date order", () => {
  const first = payment(3022, "2026-10-09", 200_000, CASH, PARTY);
  const second = payment(3023, "2026-10-20", 300_000, BANK, PARTY);
  const unpaid = buildLedgerEntries([purchase(3021, "2026-10-05", 500_000, PARTY)], [], new Map(), [], "2026-10");
  assert.equal(badge(listed(unpaid, "all")[0]), "미납");
  const partial = buildLedgerEntries([purchase(3021, "2026-10-05", 500_000, PARTY, [applied(first, 200_000)]), first], [], new Map(), [], "2026-10");
  assert.deepEqual(listed(partial, "all").map(entry => badge(entry)), ["일부결제"]);
  assert.equal(listed(partial, "all")[0].remainingAmount, 300_000);
  const paid = buildLedgerEntries([purchase(3021, "2026-10-05", 500_000, PARTY, [applied(second, 300_000), applied(first, 200_000)]), first, second], [], new Map(), [], "2026-10");
  const [row] = listed(paid, "all");
  assert.equal(listed(paid, "all").length, 1);
  assert.equal(badge(row), "결제");
  assert.equal(row.accountName, "복수계정");
  assert.deepEqual(row.payablePayments?.map(item => [item.transactionId, item.businessDate, item.accountName, item.amount]), [
    [3022, "2026-10-09", "매장 현금", 200_000],
    [3023, "2026-10-20", "BABA 법인계좌", 300_000],
  ]);
});

test("month boundary: a purchase reads as of its view month; a payment for another month's purchase keeps its row", () => {
  const novPay = payment(3032, "2026-11-02", 600_000, BANK, PARTY);
  const october = buildLedgerEntries([purchase(3031, "2026-10-30", 600_000, PARTY, [applied(novPay, 600_000)])], [], new Map(), [], "2026-10");
  const [octRow] = listed(october, "all");
  assert.equal(badge(octRow), "미납");
  assert.equal(octRow.payablePayments, undefined);
  // November lists only the payment: the purchase is October's. It stays visible as [결제].
  const november = buildLedgerEntries([novPay], [], new Map(), [], "2026-11");
  const [novRow] = listed(november, "all");
  assert.equal(novRow.transactionId, 3032);
  assert.equal(novRow.paymentSettledInPayables, undefined);
  assert.equal(badge(novRow), "결제");
  assert.deepEqual(dayPair(november, "all", "2026-11-02"), { income: 0, expense: 0 });
});

test("one payment for prior- and current-month 청구서: the payment row shows only the prior-month part", () => {
  // #3035 pays 300,000 of a September 청구서 and 200,000 of October #3034.
  const mixed = payment(3035, "2026-10-10", 500_000, CASH, PARTY);
  const entries = buildLedgerEntries([purchase(3034, "2026-10-04", 200_000, PARTY, [applied(mixed, 200_000)]), mixed], [], new Map(), [], "2026-10");
  const paymentRow = entries.find(entry => entry.transactionId === 3035)!;
  const purchaseRow = groupOfIn(entries, 3034);
  assert.equal(paymentRow.paymentSettledInPayables, undefined);
  assert.deepEqual(listed(entries, "all").map(entry => entry.id).sort(), [purchaseRow.id, paymentRow.id].sort());
  assert.equal(badge(paymentRow), "결제");
  assert.equal(entryDisplayAmount(paymentRow), 300_000);
  assert.equal(paymentRow.amount, 500_000);
  assert.equal(badge(purchaseRow), "결제");
  assert.deepEqual(purchaseRow.payablePayments?.map(item => [item.transactionId, item.amount, item.paymentAmount]), [[3035, 200_000, 500_000]]);
  // 결제 total = cash actually paid once (300,000 + 200,000); 전체 expense = October purchase only.
  assert.equal(listed(entries, "payment").reduce((sum, entry) => sum + (entryFilterHeaderAmount(entry, "payment") ?? 0), 0), 500_000);
  assert.deepEqual(dayPair(entries, "all", "2026-10-10"), { income: 0, expense: 0 });
  assert.deepEqual(dayPair(entries, "all", "2026-10-04"), { income: 0, expense: 200_000 });
  assert.match(page, /당월 매입분 \$\{money\(entry\.systemDisplay\.listedPayablesAmount\)\} 제외/);
  assert.match(page, /thuộc phiếu nhập tháng này/);
});

test("manual expense, POS, payroll and card rows keep their badges, filters and subtotals", () => {
  const day = "2026-10-15";
  const rows: TransactionRow[] = [
    { id: 4001, type: "expense", status: "confirmed", business_date: day, amount: 120_000, source_type: "manual", memo: "소모품", movements: [{ amount: -120_000, fund_account: CASH }] },
    { id: 4002, type: "sales", status: "confirmed", business_date: day, amount: 3_000_000, source_type: "pos_sales_daily_payment", source_key: `pos:${day}:cash`, source_snapshot: { receiptCount: 12 }, movements: [{ amount: 3_000_000, fund_account: CASH }] },
    { id: 4003, type: "payroll_payment", status: "confirmed", business_date: day, amount: 5_000_000, source_type: "payroll_payment", movements: [{ amount: -5_000_000, fund_account: BANK }] },
    { id: 4004, type: "card_settlement_deposit", status: "confirmed", business_date: day, amount: 900_000, source_type: "card_settlement_deposit", movements: [{ amount: -900_000, fund_account: { id: 3, code: "card_clearing", display_name: "카드 정산대기" } }, { amount: 900_000, fund_account: BANK }] },
  ];
  const entries = buildLedgerEntries(rows, [], new Map(), [], "2026-10");
  const byId = (id: number) => entries.find(entry => entry.transactionId === id)!;
  assert.deepEqual([4001, 4002, 4003, 4004].map(id => badge(byId(id))), ["지출", "수입", "지출", "카드"]);
  assert.deepEqual(listed(entries, "all").length, 4);
  assert.deepEqual(listed(entries, "payment"), []);
  assert.deepEqual(listed(entries, "partial"), []);
  assert.deepEqual(dayPair(entries, "all", day), { income: 3_000_000, expense: 5_120_000 });
  assert.ok(entries.every(entry => entry.paymentSettledInPayables === undefined && entry.payablePayments === undefined));
});

test("purchase amounts, directions and payment cash rows are unchanged (P&L, cash flow and balances)", () => {
  for (const row of oct3Purchases) {
    const group = groupOf(Number(row.id));
    assert.equal(group.direction, "expense");
    assert.equal(group.items.find(item => item.transactionId === Number(row.id))?.amount, Number(row.amount));
  }
  for (const row of oct3Payments) {
    const entry = oct3Entries.find(item => item.transactionId === Number(row.id))!;
    assert.equal(entry.direction, "transfer");
    assert.equal(entry.amount, Number(row.amount));
    assert.equal(entry.participatesInProfit, false);
    assert.deepEqual(entryDisplaySubtotal(entry), { income: 0, expense: 0 });
  }
  // Fund balances are read from movements, never from the visible list rows.
  assert.doesNotMatch(page.slice(page.indexOf("const balanceDeltaByCode"), page.indexOf("const balanceDeltaByCode") + 600), /groups|listEntries/);
});

test("page: search reads the badge and payment ids; detail shows the payment history; KO/VI and CSS", () => {
  assert.match(page, /\$\{entryDisplayBadgeLabel\(entryDisplayBadgeKind\(entry\), lang\)\} \$\{\(entry\.payablePayments \?\? \[\]\)\.map\(\(payment\) => `#\$\{payment\.transactionId\}`\)\.join\(" "\)\}/);
  assert.match(page, /<PayablePaymentHistorySection entry=\{entry\} lang=\{lang\} \/>/);
  for (const label of ["지급 내역", "Lịch sử thanh toán", "연결 청구서", "Hóa đơn liên kết", "총 지급액", "Tổng thanh toán", "계정 확인 필요", "Chưa rõ tài khoản"]) assert.ok(page.includes(label), label);
  assert.equal(ledgerEntryFilterLabel("partial", "ko"), "일부결제");
  assert.equal(ledgerEntryFilterLabel("partial", "vi"), "Trả một phần");
  assert.match(css, /\.direction\.partial\{/);
  assert.match(css, /\.paymentHistoryMeta\{grid-column:1\/-1;min-width:0;[^}]*overflow-wrap:anywhere\}/);
});
