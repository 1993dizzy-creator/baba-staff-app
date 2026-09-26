import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const { planPartialPayablePayment } = require("../lib/ledger/partial-payable-payment.ts") as typeof import("../lib/ledger/partial-payable-payment");
const { buildOldestFirstAllocations } = require("../lib/ledger/payables.ts") as typeof import("../lib/ledger/payables");

const entries = readFileSync("app/(protected)/admin/ledger/entries/page.tsx", "utf8");
const entriesCompact = entries.replace(/\s+/g, "");
const redirectPage = readFileSync("app/(protected)/admin/ledger/payables/page.tsx", "utf8");
const tabs = readFileSync("lib/navigation/ledger-tabs.ts", "utf8");

const rows = [
  { id: 12, businessDate: "2026-09-09", outstandingAmount: 5_000_000 },
  { id: 10, businessDate: "2026-09-03", outstandingAmount: 4_000_000 },
  { id: 11, businessDate: "2026-09-07", outstandingAmount: 3_500_000 },
  { id: 13, businessDate: "2026-09-01", outstandingAmount: 0 },
];

test("partial payment allocates oldest-first exactly like buildOldestFirstAllocations()", () => {
  const plan = planPartialPayablePayment(rows, 10_000_000);
  assert.equal(plan.error, null);
  assert.equal(plan.totalOutstanding, 12_500_000);
  assert.deepEqual(plan.allocations, [
    { payableId: 10, allocatedAmount: 4_000_000 },
    { payableId: 11, allocatedAmount: 3_500_000 },
    { payableId: 12, allocatedAmount: 2_500_000 },
  ]);
  assert.deepEqual(plan.allocations, buildOldestFirstAllocations(rows.filter((row) => row.outstandingAmount > 0), 10_000_000).allocations);
  assert.equal(plan.allocations.reduce((sum, row) => sum + row.allocatedAmount, 0), plan.amount);
});

test("partial payment allows 0 < amount <= total outstanding and blocks everything else", () => {
  assert.equal(planPartialPayablePayment(rows, 12_500_000).error, null);
  assert.equal(planPartialPayablePayment(rows, 12_500_001).error, "exceeds_outstanding");
  assert.deepEqual(planPartialPayablePayment(rows, 12_500_001).allocations, []);
  for (const amount of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.0001]) assert.equal(planPartialPayablePayment(rows, amount).error, "invalid_amount", String(amount));
  assert.equal(planPartialPayablePayment(rows, 1.5).error, null, "numeric(16,3) precision is allowed");
  assert.equal(planPartialPayablePayment([{ id: 1, businessDate: "2026-09-01", outstandingAmount: 0 }], 100).error, "nothing_outstanding");
});

test("entries party sheet: 선택 일자 결제 kept, 부분 지급 added with preview and explicit allocations to the existing pay API", () => {
  assert.match(entriesCompact, /const\[mode,setMode\]=useState<"dates"\|"partial"\|"history">\("dates"\)/);
  // selected-date payment unchanged
  assert.match(entriesCompact, /allocations:selectedPayables\.map\(row=>\(\{payableId:row\.id,allocatedAmount:row\.outstandingAmount\}\)\)/);
  // partial payment: preview list is the plan, and the same plan is posted
  assert.match(entriesCompact, /constpartialPlan=useMemo\(\(\)=>planPartialPayablePayment\(partialRows,parseLedgerAmount\(partialAmount\)\?\?0\),\[partialRows,partialAmount\]\);/);
  assert.match(entriesCompact, /fetch\("\/api\/admin\/ledger\/payables\/pay",\{method:"POST",headers:\{"Content-Type":"application\/json"\},body:JSON\.stringify\(\{partyId:party\.partyId,fundAccountId:Number\(accountId\),occurredAt:`\$\{date\}T\$\{time\}:00\+07:00`,amount:partialPlan\.amount,allocations:partialPlan\.allocations,memo:memo\|\|null\}\)\}\)/);
  assert.match(entriesCompact, /\{partialPlan\.error===null\?<divclassName=\{styles\.allocationPreview\}>/);
  assert.match(entriesCompact, /partialPlan\.allocations\.map\(allocation=>/);
  assert.match(entriesCompact, /\{partialPlan\.error==="exceeds_outstanding"\?<pclassName=\{styles\.error\}role="alert">/);
  assert.match(entriesCompact, /constcanPay=mode==="dates"\?!!selectedPayables\.length:mode==="partial"&&partialPlan\.error===null;/);
  assert.match(entriesCompact, /disabled=\{saving\|\|!accountId\|\|!canPay\}/);
  for (const label of ["선택 일자 결제", "부분 지급", "지급액", "총 미납금을 초과할 수 없습니다.", "Theo ngày", "Thanh toán một phần", "Vượt quá tổng công nợ."]) assert.ok(entries.includes(label), label);
});

test("current month pays; past months stay read-only (no pay, partial pay or verification payment)", () => {
  assert.match(entriesCompact, /month===currentMonth\(\)\?<PayablePartySheet/);
  assert.match(entriesCompact, /:<HistoricalPayablePartySheet/);
  const historical = entriesCompact.slice(entriesCompact.indexOf("functionHistoricalPayablePartySheet("), entriesCompact.indexOf("functionPayablePartySheet("));
  assert.doesNotMatch(historical, /payables\/pay|partial|planPartialPayablePayment/);
  assert.match(entriesCompact, /<PaymentVerificationSectiongroup=\{payableDisplay\.other\}accounts=\{businessAccounts\}vi=\{vi\}canPay=\{month===currentMonth\(\)\}onPaid=\{async\(\)=>\{awaitload\(\);/);
});

test("기타 · 결제 미확인 is the last row inside the party list, hidden when empty, and refreshes via the month load", () => {
  const summary = entriesCompact.slice(entriesCompact.indexOf('aria-labelledby="payable-summary-title"'), entriesCompact.indexOf('aria-labelledby="card-settlement-title"'));
  // Rendered inside #payable-parties-list, after every party row, only when there is an unresolved group.
  assert.match(summary, /<divclassName=\{styles\.payableParties\}id="payable-parties-list">\{payableDisplay\.parties\.map\(\(party\)=>[^]*?<\/button>\)\}\{payableDisplay\.other\?<PaymentVerificationSectiongroup=\{payableDisplay\.other\}[^]*?\/>:null\}<\/div>/);
  assert.match(summary, /\{payableDisplay\.parties\.length\|\|payableDisplay\.other\?\(/);
  assert.doesNotMatch(summary, /결제 미확인 없음|verificationNone|verificationToggle/);
  assert.match(entriesCompact, /constpayableDisplay=useMemo\(\(\)=>groupPayablesForDisplay\(payables\?\.parties\?\?\[\],payables\?\.payables\?\?\[\],payables\?\.month===month\?payables\.verification\?\.items\?\?\[\]:\[\],\),\[payables,month\]\);/);
  assert.match(entriesCompact, /fetch\(`\/api\/admin\/ledger\/payables\?month=\$\{requestedMonth\}`/);
  assert.match(readFileSync("app/api/admin/ledger/payables/route.ts", "utf8"), /return ledgerJson\(\{ok:true,totalOutstanding:balances\.totalOutstanding,verification,/);
});

test("old /admin/ledger/payables redirects to entries and keeps a valid ?month", async () => {
  assert.doesNotMatch(redirectPage, /"use client"|useState|fetch\(/);
  const code = ts.transpileModule(redirectPage, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const targets: string[] = [];
  const mod = { exports: {} as { default: (props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) => Promise<void> } };
  new Function("require", "module", "exports", code)((name: string) => {
    if (name !== "next/navigation") throw new Error(name);
    return { redirect: (target: string) => { targets.push(target); } };
  }, mod, mod.exports);
  for (const searchParams of [{ month: "2026-08" }, {}, { month: "2026-13" }, { month: ["2026-08", "2026-09"] }, { month: "x" }]) {
    await mod.exports.default({ searchParams: Promise.resolve(searchParams) });
  }
  assert.deepEqual(targets, [
    "/admin/ledger/entries?month=2026-08",
    "/admin/ledger/entries",
    "/admin/ledger/entries",
    "/admin/ledger/entries",
    "/admin/ledger/entries",
  ]);
});

test("payables API/helpers stay; only the duplicate UI is gone; no separate payables tab", () => {
  for (const file of ["app/api/admin/ledger/payables/route.ts", "app/api/admin/ledger/payables/[partyId]/route.ts", "app/api/admin/ledger/payables/pay/route.ts", "lib/ledger/payables.ts", "lib/ledger/payment-verification.ts"]) assert.ok(existsSync(file), file);
  assert.match(readFileSync("app/api/admin/ledger/payables/pay/route.ts", "utf8"), /ledger_pay_payables_v1/);
  assert.equal(existsSync("app/(protected)/admin/ledger/payables/PaymentVerificationSection.tsx"), false);
  assert.doesNotMatch(tabs, /\/admin\/ledger\/payables/);
  assert.equal((tabs.match(/href: "/g) ?? []).length, 3, "대시보드 · 장부작성 · 장부설정 only");
  assert.doesNotMatch(readFileSync("app/(protected)/admin/ledger/page.tsx", "utf8"), /\/admin\/ledger\/payables/);
});

test("features carried over from the removed page: party payment history and 최초/예정/최근 지급 dates", () => {
  assert.match(entriesCompact, /const\[mode,setMode\]=useState<"dates"\|"partial"\|"history">\("dates"\)/);
  assert.match(entriesCompact, /\{mode==="history"\?<divclassName=\{styles\.paymentHistory\}>\{dailyPayments\.length\?dailyPayments\.map\(day=>/);
  assert.match(entriesCompact, /\{mode==="history"\?null:<buttontype="button"disabled=\{saving\|\|!accountId\|\|!canPay\}/, "history tab never pays");
  assert.match(entriesCompact, /<pclassName=\{styles\.payablePartyMeta\}>/);
  for (const label of ["지급 내역", "최초", "예정", "최근 지급", "Lịch sử", "Thanh toán gần nhất"]) assert.ok(entries.includes(label), label);
  // [partyId] detail already returns the payment history rows the tab renders.
  assert.match(readFileSync("app/api/admin/ledger/payables/[partyId]/route.ts", "utf8"), /return ledgerJson\(\{ok:true,party:partyResult\.data,payables,payments,/);
});

const { groupPayablesForDisplay } = require("../lib/ledger/payable-display-groups.ts") as typeof import("../lib/ledger/payable-display-groups");
const { buildPaymentVerificationItems, isPaymentVerification } = require("../lib/ledger/payment-verification.ts") as typeof import("../lib/ledger/payment-verification");
const { calculatePayableBalances, sumPayableAmounts } = require("../lib/ledger/payables.ts") as typeof import("../lib/ledger/payables");

// Fixture shaped like the Production QA reference (7 real parties, 22 unresolved) — test data only.
const verificationParties: Array<[number, string, number[]]> = [
  [101, "Thiên Vương", [4_599_000]],
  [102, "Wow Spirit", [1_500_000, 1_358_000, 1_200_000]],
  [103, "Kim Dung Hàng Buồm", [640_000, 640_000, 640_000, 640_000]],
  [104, "Dabaco", [196_800, 196_800, 196_800, 196_800, 196_800]],
  [105, "Chợ", [22_000, 120_000, 130_000, 150_000, 142_400, 150_000, 150_000]],
  [106, "K-Market", [136_000]],
  [107, "An Liên", [80_000]],
];
function apiLikeFixture() {
  let id = 0;
  const sources: Array<{ id: number; party_id: number; original_amount: number; status: string; party: { name: string }; expense: { id: number; business_date: string; status: string; source_snapshot: Record<string, unknown> } }> = [];
  const add = (partyId: number, name: string, amount: number, verification: boolean) => {
    id += 1;
    sources.push({ id, party_id: partyId, original_amount: amount, status: "unpaid", party: { name }, expense: { id, business_date: "2026-09-10", status: "confirmed", source_snapshot: verification ? { paymentVerification: "pending", item_name: `item ${id}`, supplier: name } : {} } });
  };
  // Ordinary payables, including the same parties as some verification rows (Chợ, Wow Spirit).
  add(105, "Chợ", 500_000, false); add(102, "Wow Spirit", 2_000_000, false); add(201, "Phương", 33_178_000, false);
  for (const [partyId, name, amounts] of verificationParties) for (const amount of amounts) add(partyId, name, amount, true);
  // A fully paid verification row (marker stays, remaining 0) must not appear in 기타.
  add(105, "Chợ", 90_000, true);
  const paidId = id;
  const allocations = [
    { payable_id: paidId, allocated_amount: 90_000, payment: { business_date: "2026-09-12", status: "confirmed" } },
    { payable_id: 1, allocated_amount: 100_000, payment: { business_date: "2026-09-12", status: "confirmed" } },
  ];
  // Mirrors app/api/admin/ledger/payables/route.ts: verification rows are excluded from party balances/totals.
  const verification = buildPaymentVerificationItems(sources, allocations);
  const ordinary = sources.filter((row) => !isPaymentVerification(row));
  const balances = calculatePayableBalances(ordinary, allocations, "2026-09");
  const parties = balances.partySummaries!.map((summary) => ({ ...summary, openCount: balances.payables.filter((row) => Number(row.party_id) === summary.partyId).length }));
  return { sources, verification, balances, parties, payables: balances.payables.map((row) => ({ id: row.id, party_id: row.party_id, outstandingAmount: row.outstandingAmount })) };
}

test("기타 groups all unresolved verification items into one row: amount = Σ remaining, count = unresolved rows", () => {
  const { verification, parties, payables } = apiLikeFixture();
  const display = groupPayablesForDisplay(parties, payables, verification.items);
  assert.equal(display.other!.count, 22);
  assert.equal(display.other!.amount, 13_281_400);
  assert.equal(display.other!.amount, verification.totalPending);
  assert.equal(display.other!.count, verification.pendingCount);
  assert.ok(display.other!.items.every((item) => item.remainingAmount > 0), "fully paid markers are excluded");
  // Real suppliers stay on every item.
  const byParty = new Map<string, { count: number; amount: number }>();
  for (const item of display.other!.items) { const row = byParty.get(item.supplierName) ?? { count: 0, amount: 0 }; row.count += 1; row.amount += item.remainingAmount; byParty.set(item.supplierName, row); }
  assert.deepEqual(Object.fromEntries([...byParty].map(([name, row]) => [name, [row.count, row.amount]])), {
    "Thiên Vương": [1, 4_599_000], "Wow Spirit": [3, 4_058_000], "Kim Dung Hàng Buồm": [4, 2_560_000], "Dabaco": [5, 984_000], "Chợ": [7, 864_400], "K-Market": [1, 136_000], "An Liên": [1, 80_000],
  });
});

test("no double counting and totals unchanged: API parties already exclude verification, so party rows stay as-is", () => {
  const { verification, balances, parties, payables } = apiLikeFixture();
  const display = groupPayablesForDisplay(parties, payables, verification.items);
  assert.deepEqual(display.parties, parties, "no subtraction needed — verification payables are not in party rows");
  const partySum = sumPayableAmounts(display.parties.map((party) => party.closingOutstanding));
  assert.equal(partySum, balances.totalOutstanding, "Σ party rows === totalOutstanding (월말 미납 unchanged)");
  const verificationIds = new Set(display.other!.items.map((item) => item.payableId));
  assert.ok(payables.every((row) => !verificationIds.has(row.id)), "no payable is in both a party row and 기타");
  assert.equal(balances.totalOutstanding, 33_178_000 + 400_000 + 2_000_000, "월말 미납 excludes 기타");
  // 기타 is a separate verification amount: adding it would change 월말 미납, so it is never added.
  assert.notEqual(sumPayableAmounts([partySum, display.other!.amount]), balances.totalOutstanding);
  assert.equal(balances.summary!.closingOutstanding, balances.totalOutstanding, "월말 미납 card = confirmed payables only");
});

test("if a verification payable ever appears in a party's rows, it moves to 기타 so Σ party + 기타 === totalOutstanding", () => {
  const parties = [{ partyId: 105, closingOutstanding: 1_364_400, openCount: 8 }, { partyId: 201, closingOutstanding: 1_000_000, openCount: 1 }];
  const partyPayables = [
    { id: 1, party_id: 105, outstandingAmount: 500_000 },
    { id: 2, party_id: 105, outstandingAmount: 864_400 },
    { id: 3, party_id: 201, outstandingAmount: 1_000_000 },
  ];
  const totalOutstanding = 2_364_400;
  const items = [{ payableId: 2, partyId: 105, remainingAmount: 864_400 }];
  const display = groupPayablesForDisplay(parties, partyPayables, items);
  assert.deepEqual(display.parties, [{ partyId: 105, closingOutstanding: 500_000, openCount: 7 }, parties[1]]);
  assert.equal(sumPayableAmounts([...display.parties.map((party) => party.closingOutstanding), display.other!.amount]), totalOutstanding);
  assert.equal(display.other!.count, 1);
});

test("zero unresolved hides 기타 entirely", () => {
  const parties = [{ partyId: 1, closingOutstanding: 10, openCount: 1 }];
  assert.equal(groupPayablesForDisplay(parties, [], []).other, null);
  assert.equal(groupPayablesForDisplay(parties, [], [{ payableId: 9, partyId: 1, remainingAmount: 0 }]).other, null);
});

test("기타 grouping is display-only: no API/DB/economic changes", () => {
  const helper = readFileSync("lib/ledger/payable-display-groups.ts", "utf8");
  assert.doesNotMatch(helper, /fetch\(|supabase|party_id\s*=(?!=)/);
  assert.match(readFileSync("app/api/admin/ledger/payables/route.ts", "utf8"), /const ordinarySources=sources\.filter\(row=>!isPaymentVerification\(row\)\);/);
});

const { groupPaymentsByDate } = require("../lib/ledger/payable-display-groups.ts") as typeof import("../lib/ledger/payable-display-groups");

test("partial payment regression: oldest-first, last payable keeps a remainder, preview === posted allocations", () => {
  const plan = planPartialPayablePayment([
    { id: 3, businessDate: "2026-09-10", outstandingAmount: 2_000_000 }, // C
    { id: 1, businessDate: "2026-09-01", outstandingAmount: 1_000_000 }, // A
    { id: 2, businessDate: "2026-09-05", outstandingAmount: 800_000 },   // B
  ], 1_500_000);
  assert.equal(plan.error, null);
  assert.deepEqual(plan.allocations, [{ payableId: 1, allocatedAmount: 1_000_000 }, { payableId: 2, allocatedAmount: 500_000 }], "A paid in full, B partly, C untouched");
  assert.equal(800_000 - plan.allocations[1].allocatedAmount, 300_000, "B keeps a 300,000 remainder");
  // The DB status for a partly allocated payable is 'partially_paid' (ledger_pay_payables_v1).
  const payRpc = readFileSync("supabase/migrations/202608210004_add_ledger_payable_payments.sql", "utf8");
  assert.match(payRpc, /v_status:=case when v_sum=0 then 'unpaid' when v_outstanding=0 then 'paid' else 'partially_paid' end;/);
  // The preview list and the POST body use the same plan object.
  assert.match(entriesCompact, /partialPlan\.allocations\.map\(allocation=>/);
  assert.match(entriesCompact, /amount:partialPlan\.amount,allocations:partialPlan\.allocations,/);
  assert.doesNotMatch(entriesCompact, /allocations:null|allocations:undefined/);
});

test("지급 내역 is one line per date: same-day payments summed, oldest → newest, no allocation/item details", () => {
  const days = groupPaymentsByDate([
    { business_date: "2026-09-19", amount: 136_000 },
    { business_date: "2026-08-31", amount: "1900000.000" },
    { business_date: "2026-09-13", amount: 5_000_000 },
    { business_date: "2026-09-13", amount: 900_000 },
  ]);
  assert.deepEqual(days, [
    { businessDate: "2026-08-31", amount: 1_900_000 },
    { businessDate: "2026-09-13", amount: 5_900_000 },
    { businessDate: "2026-09-19", amount: 136_000 },
  ]);
  assert.deepEqual(groupPaymentsByDate([]), []);
  const sheet = entriesCompact.slice(entriesCompact.indexOf("functionPayablePartySheet("), entriesCompact.indexOf("functionpayableItemLabel("));
  assert.match(sheet, /constdailyPayments=useMemo\(\(\)=>groupPaymentsByDate\(detail\?\.payments\?\?\[\]\),\[detail\]\);/);
  const historyStart = sheet.indexOf('{mode==="history"?<div');
  const history = sheet.slice(historyStart, sheet.indexOf(':mode==="dates"', historyStart));
  assert.equal(history, '{mode==="history"?<divclassName={styles.paymentHistory}>{dailyPayments.length?dailyPayments.map(day=><divkey={day.businessDate}className={styles.paymentHistoryRow}><span>{formatDate(day.businessDate,lang)}</span><strong>{money(day.amount)}</strong></div>):<pclassName={styles.paymentHistoryEmpty}>{vi?"Chưacólịchsửthanhtoán.":"지급내역이없습니다."}</p>}</div>');
  assert.doesNotMatch(history, /allocation|payableItemLabel|memo|fund_account|aria-expanded|›|▶/);
  // Tab count keeps its meaning: number of payment transactions, not days.
  assert.match(sheet, /\{vi\?"Lịchsử":"지급내역"\}\{detail\.payments\?\.length\?\?0\}/);
  const css = readFileSync("app/(protected)/admin/ledger/entries/entries.module.css", "utf8");
  assert.match(css, /\.payModeTabs button\{min-height:28px;padding:4px 6px;/);
  assert.match(css, /\.paymentHistoryEmpty\{[^}]*color:#9ca3af;[^}]*text-align:center\}/);
});

test("기타 sheet groups the unresolved items by real party without changing totals", () => {
  const { groupVerificationItemsByParty } = require("../lib/ledger/payable-display-groups.ts") as typeof import("../lib/ledger/payable-display-groups");
  const { verification, parties, payables } = apiLikeFixture();
  const other = groupPayablesForDisplay(parties, payables, verification.items).other!;
  const groups = groupVerificationItemsByParty(other.items);
  assert.deepEqual(groups.map((group) => [group.name, group.count, group.amount]), [
    ["Thiên Vương", 1, 4_599_000], ["Wow Spirit", 3, 4_058_000], ["Kim Dung Hàng Buồm", 4, 2_560_000], ["Dabaco", 5, 984_000], ["Chợ", 7, 864_400], ["K-Market", 1, 136_000], ["An Liên", 1, 80_000],
  ]);
  assert.equal(groups.reduce((sum, group) => sum + group.count, 0), other.count);
  assert.equal(sumPayableAmounts(groups.map((group) => group.amount)), other.amount);
  assert.equal(other.count, verification.pendingCount);
  assert.equal(other.amount, verification.totalPending);
  for (const group of groups) assert.ok(group.items.every((item) => item.partyId === group.partyId));
  // party → date → items: per-date totals roll up exactly to the party (and 기타) totals.
  for (const group of groups) {
    assert.deepEqual(group.dates.map((day) => day.businessDate), [...new Set(group.items.map((item) => item.businessDate))].sort());
    assert.equal(group.dates.reduce((sum, day) => sum + day.count, 0), group.count);
    assert.equal(sumPayableAmounts(group.dates.map((day) => day.amount)), group.amount);
    for (const day of group.dates) assert.ok(day.items.every((item) => item.businessDate === day.businessDate && item.partyId === group.partyId));
  }
  // 일괄 결제 plan per date: one party, exactly that date's payables in full, Σ = date total.
  const { planVerificationDatePayment } = require("../lib/ledger/payable-display-groups.ts") as typeof import("../lib/ledger/payable-display-groups");
  for (const group of groups) for (const day of group.dates) {
    const plan = planVerificationDatePayment(day.items)!;
    assert.equal(plan.partyId, group.partyId);
    assert.equal(plan.amount, day.amount);
    assert.deepEqual(plan.allocations, day.items.map((item) => ({ payableId: item.payableId, allocatedAmount: item.remainingAmount })));
  }
});
