import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const { buildLedgerEntries } = createRequire(import.meta.url)("../lib/ledger/entries.ts") as typeof import("../lib/ledger/entries");
const { MANUAL_EXPENSE_CATEGORY_NAMES, isManualExpenseCategory } = createRequire(import.meta.url)("../lib/ledger/manual-entry-policy.ts") as typeof import("../lib/ledger/manual-entry-policy");
const { formatLedgerAmountInput, parseLedgerAmount, sanitizeLedgerAmountInput } = createRequire(import.meta.url)("../lib/ledger/manual-entry-amount.ts") as typeof import("../lib/ledger/manual-entry-amount");
const read = (path: string) => readFileSync(path, "utf8");
const page = read("app/(protected)/admin/ledger/entries/page.tsx");
const pageCompact = page.replace(/\s+/g, "");
const css = read("app/(protected)/admin/ledger/entries/entries.module.css");
const keepingUi = read("components/bar/keeping/KeepingUi.tsx");
const bottomNav = read("components/BottomNav.tsx");
const route = read("app/api/admin/ledger/route.ts");
const autoLink = read("supabase/migrations/20260824152518_auto_link_business_partners_to_ledger.sql");
const categories = read("supabase/migrations/20260824152948_ledger_category_v1.sql");
const opening = read("supabase/migrations/20260824153108_seed_august_2026_opening_balances.sql");
const manualCategories = read("supabase/migrations/20260824174814_add_manual_ledger_expense_categories.sql");

test("inventory candidates are summarized by date, partner and payment default", () => {
  const candidates = Array.from({ length: 444 }, (_, index) => ({
    id: index + 1, business_date: index < 400 ? "2026-08-24" : "2026-08-23", proposed_amount: 100,
    proposed_category_id: 12, proposed_party_id: 7, source_snapshot: { item_name: `품목 ${index + 1}` },
    category: { name: "식자재 매입" }, party: { name: "OK FOOD" },
  }));
  const defaults = new Map([[7, { paymentMode: "immediate" as const, defaultFundAccountId: 4, defaultFundAccountName: "BABA 법인계좌" }]]);
  const entries = buildLedgerEntries([], candidates, defaults);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map(entry => entry.items.length), [400, 44]);
  assert.equal(entries[0].title, "OK FOOD");
  assert.equal(entries[0].accountName, "BABA 법인계좌");
  assert.equal(entries[0].amount, 40_000);
});

test("confirmed inventory and POS rows retain source detail while grouping", () => {
  const transactions = [
    { id: 1, party_id: 9, type: "expense", business_date: "2026-08-24", amount: 300, economic_effect_sign: 1, source_type: "inventory_purchase_candidate", party: { name: "OK FOOD" }, category: { name: "식자재 매입" }, source_snapshot: { item_name: "치즈" }, movements: [{ amount: -300, fund_account: { id: 4, display_name: "법인계좌" } }] },
    { id: 2, party_id: 9, type: "expense", business_date: "2026-08-24", amount: 500, economic_effect_sign: 1, source_type: "inventory_purchase_candidate", party: { name: "OK FOOD" }, category: { name: "식자재 매입" }, source_snapshot: { item_name: "소스" }, movements: [{ amount: -500, fund_account: { id: 4, display_name: "법인계좌" } }] },
    { id: 3, type: "sales", business_date: "2026-08-24", amount: 1000, source_type: "pos_sales_daily_payment", source_key: "pos:2026-08-24:card", source_snapshot: { receiptCount: 19 }, movements: [{ amount: 1000, fund_account: { id: 5, display_name: "카드 정산대기" } }] },
  ];
  const entries = buildLedgerEntries(transactions, [], new Map());
  assert.equal(entries.length, 2);
  const inventory = entries.find(entry => entry.drilldown === "inventory");
  const pos = entries.find(entry => entry.drilldown === "pos");
  assert.equal(inventory?.subtitle, "2품목");
  assert.equal(inventory?.amount, 800);
  assert.deepEqual(inventory?.items.map(item => item.name), ["치즈", "소스"]);
  assert.equal(pos?.title, "POS 카드매출");
  assert.equal(pos?.subtitle, "영수증 19건");
  assert.equal(pos?.accountName, "카드 정산대기");
});

test("inventory groups use provenance time ranges and earliest item time for sorting", () => {
  const inventory = (
    id: number,
    partyId: number,
    partyName: string,
    sourceTime: string,
    sourceType = "inventory_purchase_candidate",
  ) => ({
    id, party_id: partyId, type: "expense", business_date: "2026-08-01",
    occurred_at: "2026-08-01T20:00:00Z", amount: 100, economic_effect_sign: 1,
    source_type: sourceType, party: { name: partyName }, category: { name: "식자재 매입" },
    source_snapshot: { item_name: `품목 ${id}`, inventory_log_created_at: sourceTime },
    movements: [{ amount: -100, fund_account: { id: 4, display_name: "법인계좌" } }],
  });
  const rows = [
    inventory(1, 1, "Ok Mart", "2026-08-01T11:39:00.754531Z"),
    inventory(2, 1, "Ok Mart", "2026-08-01T11:39:15.163987Z"),
    inventory(3, 1, "Ok Mart", "2026-08-01T11:39:44.763669Z"),
    inventory(4, 1, "Ok Mart", "2026-08-01T11:40:09.912270Z"),
    inventory(5, 1, "Ok Mart", "2026-08-01T11:40:23.246658Z"),
    inventory(6, 2, "Late", "2026-08-01T11:12:00Z"),
    inventory(7, 3, "Early", "2026-08-01T09:30:00Z", "inventory_purchase_rebook"),
  ];
  const entries = buildLedgerEntries(rows, [], new Map());
  assert.deepEqual(entries.map(entry => entry.title), ["Ok Mart", "Late", "Early"]);
  const okMart = entries.find(entry => entry.title === "Ok Mart");
  assert.equal(okMart?.displayTime, "18:39 ~ 18:40");
  assert.deepEqual(okMart?.items.map(item => item.displayTime), ["18:39", "18:39", "18:39", "18:40", "18:40"]);
  assert.equal(entries.find(entry => entry.title === "Late")?.displayTime, "18:12");
  assert.equal(entries.find(entry => entry.title === "Early")?.displayTime, "16:30");
  // Representative sort time is the group's earliest item, not its latest.
  assert.equal(okMart?.sortTimestamp, Date.parse("2026-08-01T11:39:00.754531Z"));
});

test("inventory group sort timestamp is earliest-first even when it reverses the latest-time ranking", () => {
  const inventory = (id: number, partyId: number, partyName: string, sourceTime: string) => ({
    id, party_id: partyId, type: "expense", business_date: "2026-08-01",
    amount: 100, economic_effect_sign: 1, source_type: "inventory_purchase_candidate",
    party: { name: partyName }, category: { name: "식자재 매입" },
    source_snapshot: { item_name: `품목 ${id}`, inventory_log_created_at: sourceTime },
    movements: [{ amount: -100, fund_account: { id: 4, display_name: "법인계좌" } }],
  });
  const rows = [
    // Group A (Vietnam time): starts 18:30, ends 20:00 — earliest start, but latest end.
    inventory(1, 1, "A", "2026-08-01T11:30:00Z"),
    inventory(2, 1, "A", "2026-08-01T13:00:00Z"),
    // Group B (Vietnam time): starts 19:00, ends 19:10 — later start, but earlier end than A.
    inventory(3, 2, "B", "2026-08-01T12:00:00Z"),
    inventory(4, 2, "B", "2026-08-01T12:10:00Z"),
  ];
  const entries = buildLedgerEntries(rows, [], new Map());
  const a = entries.find(entry => entry.title === "A");
  const b = entries.find(entry => entry.title === "B");
  assert.equal(a?.displayTime, "18:30 ~ 20:00");
  assert.equal(b?.displayTime, "19:00 ~ 19:10");
  // Earliest-time ranking: A starts before B, so A's sortTimestamp is smaller.
  assert.ok((a?.sortTimestamp ?? 0) < (b?.sortTimestamp ?? 0));
  // This is the opposite of what a latest-time ranking would have produced (A's end is after B's end).
  assert.ok(Date.parse(a?.inventoryEndAt ?? "") > Date.parse(b?.inventoryEndAt ?? ""));
});

test("inventory item order sorts earliest-time-first, pushes timeless items to the back, and keeps ties stable", () => {
  const inventory = (id: number, itemName: string, sourceTime: string | null) => ({
    id, party_id: 1, type: "expense", business_date: "2026-08-01",
    amount: 100, economic_effect_sign: 1, source_type: "inventory_purchase_candidate",
    party: { name: "Mixed Mart" }, category: { name: "식자재 매입" },
    source_snapshot: sourceTime ? { item_name: itemName, inventory_log_created_at: sourceTime } : { item_name: itemName },
    movements: [{ amount: -100, fund_account: { id: 4, display_name: "법인계좌" } }],
  });
  const rows = [
    inventory(1, "품목-없음-A", null),
    inventory(2, "품목-18:40-A", "2026-08-01T11:40:00Z"),
    inventory(3, "품목-18:39-A", "2026-08-01T11:39:00Z"),
    inventory(4, "품목-18:39-B", "2026-08-01T11:39:00Z"),
    inventory(5, "품목-없음-B", null),
    inventory(6, "품목-18:40-B", "2026-08-01T11:40:00Z"),
  ];
  const entries = buildLedgerEntries(rows, [], new Map());
  const group = entries.find(entry => entry.drilldown === "inventory");
  assert.deepEqual(group?.items.map(item => item.name), [
    "품목-18:39-A", "품목-18:39-B", "품목-18:40-A", "품목-18:40-B", "품목-없음-A", "품목-없음-B",
  ]);
});

test("pending inventory uses provenance time and invalid confirmed provenance safely falls back", () => {
  const pending = buildLedgerEntries([], [{
    id: 30, business_date: "2026-08-01", proposed_amount: 100,
    proposed_party_id: 7, source_snapshot: {
      item_name: "pending",
      inventory_log_created_at: "2026-08-01T11:39:00Z",
    },
    party: { name: "Pending Mart" },
  }], new Map())[0];
  assert.equal(pending.displayTime, "18:39");
  assert.equal(pending.items[0].displayTime, "18:39");

  const fallback = buildLedgerEntries([{
    id: 31, party_id: 8, type: "expense", business_date: "2026-08-01",
    occurred_at: "2026-08-01T10:55:00Z", amount: 100, source_type: "inventory_purchase_candidate",
    source_snapshot: { item_name: "fallback", inventory_log_created_at: "invalid" },
    party: { name: "Fallback Mart" },
  }], [], new Map())[0];
  assert.equal(fallback.displayTime, "17:55");
  assert.equal(fallback.items[0].sourceUpdatedAt, null);
  assert.match(page, /item\.displayTime/);
  assert.match(page, /styles\.itemAmount/);
  assert.match(css, /\.itemAmount>small\{[^}]*color:#9ca3af[^}]*font-size:9px/);
});

test("opening balances and the four business funds match the production policy", () => {
  for (const [code, amount] of [["store_cash", "95464986"], ["vuong_personal_custody", "5231310"], ["cho_personal_custody", "95470741"], ["baba_corporate_bank", "104186605"]]) {
    assert.match(opening, new RegExp(`'${code}'[^\\n]*${amount}`));
  }
  assert.match(autoLink, /'vuong_personal_custody'\s*,\s*'personal_custody'\s*,\s*'Vương'/);
  assert.match(pageCompact, /account\.is_business_fund&&account\.type!=="card_clearing"/);
  assert.match(page, /openingBalance/);
  assert.match(page, /당월 시재/);
  assert.match(page, /현재 보유금/);
  assert.match(css, /grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
});

test("current balance panel is collapsed, nav-safe and expandable", () => {
  assert.match(pageCompact, /\[balanceExpanded,setBalanceExpanded\]=useState\(false\)/);
  assert.match(pageCompact, /businessAccounts\.reduce\(\(sum,account\)=>sum\+account\.balance,0\)/);
  assert.match(pageCompact, /balanceDeltaByCode=useMemo\(\(\)=>newMap\(businessAccounts\.map/);
  assert.match(pageCompact, /account\.balance-account\.openingBalance/);
  assert.match(pageCompact, /aria-expanded=\{balanceExpanded\}/);
  assert.match(pageCompact, /aria-controls="ledger-current-balance-detail"/);
  assert.match(pageCompact, /balanceExpanded\?<divclassName=\{styles\.balanceDetail\}id="ledger-current-balance-detail"/);
  assert.match(page, /Tiền hiện có/);assert.match(page, /현재 보유금/);
  assert.match(css, /\.balanceBar\{bottom:calc\(60px \+ env\(safe-area-inset-bottom\)\)\}/);
  assert.match(css, /\.page\{padding-bottom:calc\(122px \+ env\(safe-area-inset-bottom\)\)\}/);
  assert.match(css, /\.balanceToggle\{[^}]*min-height:46px/);
  assert.match(css, /\.balanceInner>\.balanceDetail\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(css, /\.balanceInner\{[^}]*border:1px solid #cbd5e1;[^}]*border-radius:14px 14px 0 0;[^}]*background:rgba\(255,255,255,\.995\);[^}]*box-shadow:0 -2px 10px/);
  assert.match(css, /\.balanceInner::before\{[^}]*height:2px;background:#374151/);
  assert.match(pageCompact, /delta>0\?styles\.balanceDeltaPositive:delta<0\?styles\.balanceDeltaNegative:styles\.balanceDeltaZero/);
  assert.match(pageCompact, /\(\{delta>0\?"\+":""\}\{money\(delta\)\}\)/);
  assert.match(css, /\.balanceAmounts\{[^}]*display:flex;[^}]*flex-wrap:wrap/);
  assert.match(css, /\.balanceDeltaPositive\{color:#16805a\}/);
  assert.match(css, /\.balanceDeltaNegative\{color:#b4493e\}/);
  assert.match(css, /\.balanceDeltaZero\{color:#6b7280\}/);
  assert.match(css, /\.balanceInner>\.balanceDetail\{[^}]*padding:4px 8px 30px/);
  assert.match(css, /\.balanceExpandedPage\{padding-bottom:calc\(242px \+ env\(safe-area-inset-bottom\)\)\}/);
  assert.match(css, /@media\(max-width:560px\)[\s\S]*\.balanceToggle/);
  assert.match(css, /@media\(max-width:340px\)[\s\S]*\.balanceToggle>strong\{font-size:11px\}/);
  assert.match(bottomNav,/height: 60/);assert.match(bottomNav,/marginTop: -22/);assert.match(bottomNav,/zIndex: 1000/);
  assert.match(page,/vuong_personal_custody: "개인\(Vương\)"/);
  assert.match(page,/cho_personal_custody: "개인\(Cho\)"/);
  assert.match(page,/return "Vương"/);assert.match(page,/return "Cho"/);
});

test("payable outstanding card defaults to collapsed, stays expandable, and keeps party drilldown", () => {
  assert.match(pageCompact, /\[payableExpanded,setPayableExpanded\]=useState\(false\)/);
  assert.match(pageCompact, /className=\{styles\.payableToggle\}/);
  assert.match(pageCompact, /aria-expanded=\{payableExpanded\}/);
  assert.match(pageCompact, /aria-controls="payable-parties-list"/);
  assert.match(pageCompact, /onClick=\{\(\)=>setPayableExpanded\(\(value\)=>!value\)\}/);
  assert.match(pageCompact, /payableExpanded\?<divclassName=\{styles\.payableParties\}id="payable-parties-list">/);
  // Party rows keep opening PayablePartySheet regardless of the collapse toggle.
  assert.match(pageCompact, /onClick=\{\(\)=>setPayableParty\(party\)\}/);
  // Zero-outstanding-party edge case: heading/total render without a toggle button.
  assert.match(pageCompact, /payableParties\.length\?\(<buttontype="button"className=\{styles\.payableToggle\}/);
  assert.match(pageCompact, /\):\(<divclassName=\{styles\.payableHeading\}>/);
  assert.match(page, /미납금이 없습니다/);assert.match(page, /Không có công nợ chưa thanh toán/);
});

test("past-history group wraps dates before today, collapses by default, and reuses the date-card renderer", () => {
  // historyExpanded is an independent state from expandedDates and defaults to collapsed.
  assert.match(pageCompact, /\[historyExpanded,setHistoryExpanded\]=useState\(false\)/);
  // pastGroups/remainingGroups split groups purely by comparing each date string against today's key —
  // no month-based branching, so a past month naturally yields an empty remainingGroups.
  assert.match(pageCompact, /pastGroups=useMemo\(\(\)=>groups\.filter\(\(group\)=>group\.date<todayKey\)/);
  assert.match(pageCompact, /remainingGroups=useMemo\(\(\)=>groups\.filter\(\(group\)=>group\.date>=todayKey\)/);
  // historyOpen is a derived value (search override OR the manual toggle) — never mutates historyExpanded.
  assert.match(pageCompact, /historyOpen=\(Boolean\(search\.trim\(\)\)&&pastGroups\.length>0\)\|\|historyExpanded/);
  // historyExpanded resets to collapsed on every month change, alongside the existing expandedDates seeding.
  assert.match(pageCompact, /setHistoryExpanded\(false\);initializedMonthRef\.current=month/);
  // The history card only renders when there is at least one past-date group.
  assert.match(pageCompact, /pastGroups\.length\?\(<section/);
  assert.match(pageCompact, /aria-expanded=\{historyOpen\}/);
  assert.match(pageCompact, /aria-controls="ledger-history-panel"/);
  assert.match(pageCompact, /onClick=\{\(\)=>setHistoryExpanded\(\(value\)=>!value\)\}/);
  assert.match(page, /지난 내역/);assert.match(page, /Lịch sử trước đó/);
  // Range + count only, no income/expense totals on the history header.
  assert.match(pageCompact, /formatDateRange\(pastGroups\[0\]\.date,pastGroups\.at\(-1\)!\.date,lang\)/);
  // The expanded panel is its own sibling <div>, not nested inside the toggle <button> (no button nesting).
  assert.match(pageCompact, /historyOpen\?\(<divid="ledger-history-panel"className=\{styles\.historyPanel\}>\{pastGroups\.map\(renderDateGroup\)\}/);
  assert.match(pageCompact, /\{remainingGroups\.map\(renderDateGroup\)\}/);
  // Individual date cards are rendered by one shared function reused for both past and remaining groups.
  assert.match(pageCompact, /functionrenderDateGroup\(group:DateGroup\)/);
  assert.match(pageCompact, /functionformatDateRange\(startDate:string,endDate:string,lang:"ko"\|"vi"="ko"\)/);
  assert.match(css, /\.historyPanel\{display:grid;gap:8px;padding:8px;border-top:1px solid #e5e7eb;background:#f9fafb\}/);
  // The date-card contract itself (ascending date/time sort, expandedDates, search override) is unchanged.
  assert.match(pageCompact, /sort\(\(a,b\)=>a\.date\.localeCompare\(b\.date\)\)/);
  assert.match(pageCompact, /group\.rows\.sort\(\(a,b\)=>a\.sortTimestamp-b\.sortTimestamp\)/);
  assert.match(pageCompact, /Boolean\(search\.trim\(\)\)\|\|expandedDates\.has\(group\.date\)/);
});

test("business partners are the user-facing party source and defaults stay one-way", () => {
  assert.match(autoLink, /business_partner_ensure_ledger_party_v1\(\s*p_business_partner_id bigint\s*\)/);
  assert.match(autoLink, /after insert or update of name,\s*default_payment_term_days,\s*is_active/);
  assert.match(autoLink, /revoke all on function public\.business_partner_ensure_ledger_party_v1\(bigint\)\s+from public, anon, authenticated, service_role/);
  assert.match(route, /from\("business_partners"\)/);
  assert.match(route, /from\("business_partner_ledger_parties"\)/);
  assert.match(pageCompact, /data\.partners\.filter/);
  assert.match(page, /거래처 기본 결제설정은 변경하지 않습니다/);
});

test("ledger category source contains the 36 inventory mappings", () => {
  const mappingBlock = categories.match(/select \* from \(values([\s\S]*?)\) as x\(raw_name,parent_id\)/)?.[1] ?? "";
  const mappingValues = mappingBlock.match(/\('(?:[^']|'')+',\s*v_[a-z_]+\)/g) ?? [];
  assert.equal(mappingValues.length, 35);
  assert.match(categories, /values\('기타',v_leaf,true\)/);
  assert.match(categories, /ledger_inventory_category_mappings/);
});

test("ledger entries UI keeps the compact chronological accordion contract", () => {
  assert.doesNotMatch(page, />장부 업무</);
  assert.doesNotMatch(page, /<h1[^>]*>장부작성<\/h1>/);
  assert.match(page, /className=\{styles\.addButton\}/);
  assert.match(page, /장부 내역 추가/);
  assert.match(css, /\.addButton\{width:100%/);

  assert.match(pageCompact, /store_cash:0,baba_corporate_bank:1,vuong_personal_custody:2,cho_personal_custody:3/);
  assert.match(pageCompact, /account\.is_business_fund&&account\.type!=="card_clearing"/);
  assert.match(pageCompact, /businessAccounts\.reduce\(\(sum,account\)=>sum\+account\.openingBalance/);
  assert.match(pageCompact, /className=\{styles\.openingTotal\}/);
  assert.doesNotMatch(page, /month\.replace\("-","\."\)/);
  assert.match(page, /Số dư đầu tháng/);
  assert.match(page, /당월 시재/);
  assert.match(css, /\.openingSection\{padding:10px 12px\}/);
  assert.match(css, /\.openingGrid\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\);gap:0\}/);
  assert.match(css, /\.openingGrid article\{padding:6px 8px;border:0;border-radius:0;background:transparent\}/);
  assert.match(css, /@media\(max-width:560px\)[\s\S]*\.openingGrid\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);

  assert.match(pageCompact, /sort\(\(a,b\)=>a\.date\.localeCompare\(b\.date\)\)/);
  assert.match(pageCompact, /dates\.includes\(today\)\?today:dates\.at\(-1\)/);
  assert.match(pageCompact, /setExpandedDates\(\(current\)=>/);
  assert.match(pageCompact, /Boolean\(search\.trim\(\)\)\|\|expandedDates\.has\(group\.date\)/);
  assert.match(pageCompact, /expanded\?\(<divid=\{panelId\}>/);
  assert.match(pageCompact, /group\.rows\.map/);
  assert.match(pageCompact, /className=\{styles\.entryMain\}/);
  assert.match(pageCompact, /entry\.status==="pending"\?\(<spanclassName=\{styles\.pendingBadge\}>/);
  assert.match(css, /\.entryMain\{[^}]*text-overflow:ellipsis;white-space:nowrap/);
});

test("ledger entries header mirrors the monthly summary card hierarchy", () => {
  assert.match(pageCompact, /style=\{monthNoticeCardStyle\}/);
  assert.match(pageCompact, /<divstyle=\{monthControlStyle\}>/);
  assert.match(pageCompact, /type="month"value=\{month\}onChange=\{\(event\)=>setMonth\(event\.target\.value\)\}/);
  assert.match(pageCompact, /style=\{monthButtonStyle\}>\{vi\?"Trước":"이전"\}/);
  assert.match(pageCompact, /style=\{monthButtonStyle\}>\{vi\?"Sau":"다음"\}/);
  assert.match(pageCompact, /style=\{monthInputStyle\}/);
  assert.match(pageCompact, /padding:"10px12px",borderRadius:10,background:"#f9fafb",border:"1pxsolid#e5e7eb"/);
  assert.match(pageCompact, /marginTop:8,display:"grid",gridTemplateColumns:"auto1frauto",gap:8/);
  assert.match(pageCompact, /\.\.\.ui\.button,padding:"9px10px",borderRadius:10,fontSize:12,fontWeight:800/);
  assert.match(pageCompact, /\.\.\.ui\.input,width:"100%",minWidth:0,padding:"9px10px",fontSize:13,borderRadius:10/);
  // Summary cards are authoritative-source-driven (recognition_month + economic_effect_sign
  // based API summary), not a client-side re-reduction of data.entries.
  assert.match(pageCompact, /money\(data\.summary\.income\)/);
  assert.match(pageCompact, /money\(data\.summary\.paidExpense\)/);
  assert.match(pageCompact, /money\(data\.summary\.actualCardDeposits\)/);
  assert.match(pageCompact, /money\(data\.summary\.cardGrossSales\)/);
  assert.match(pageCompact, /money\(payables\?\.totalOutstanding\?\?0\)/);
  assert.doesNotMatch(pageCompact, /entry\.direction==="income"\)totals\.income\+=entry\.amount/);
  for (const label of ["월 장부 요약", "전체 수입", "지급완료", "Tổng doanh thu", "Đã thanh toán", "시재 합계", "Tổng số dư đầu tháng"]) {
    assert.match(page, new RegExp(label));
  }
  assert.match(pageCompact, /className=\{styles\.openingTotal\}>\s*<span>/);
  assert.match(css, /\.summaryGrid\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(css, /\.openingTotal\{[^}]*background:#111827;display:flex/);
  assert.match(css, /\.openingSection\{padding:14px;border-color:#e5e7eb;background:#fff;box-shadow:/);
  assert.match(css, /\.sectionTitle h2\{display:flex;align-items:center;gap:6px;font-size:16px;font-weight:900/);
  assert.match(pageCompact, /<spanaria-hidden="true">🏦<\/span>/);
  assert.match(page, /className=\{styles\.balanceBar\}/);
});

test("manual entry uses its own canonical expense whitelist", () => {
  assert.deepEqual(MANUAL_EXPENSE_CATEGORY_NAMES, [
    "직원 식대", "전기료", "수도료", "가스비", "인터넷·통신비", "청소·위생비",
    "배송·운송비", "수리·유지보수", "설비·비품", "운영 소모품", "인쇄·홍보비",
    "직원 주거비", "세금", "보험·복리후생", "회계·세무", "결제·은행 수수료",
    "인테리어", "기타 비용",
  ]);
  for (const automatic of ["급여/인건비", "식자재", "건어물", "생맥주", "시럽", "소모품·잡화"]) {
    assert.equal(isManualExpenseCategory({ kind: "expense", name: automatic }), false);
  }
  assert.match(pageCompact, /data\.categories\.filter\(isManualExpenseCategory\)\.sort\(manualExpenseCategorySort\)/);
});

test("manual ledger amount input formats display text without changing the numeric payload", () => {
  assert.equal(formatLedgerAmountInput("1000"), "1,000");
  assert.equal(formatLedgerAmountInput("150000"), "150,000");
  assert.equal(formatLedgerAmountInput("1500000"), "1,500,000");
  assert.equal(sanitizeLedgerAmountInput("1,234,567"), "1234567");
  assert.equal(sanitizeLedgerAmountInput(" 15만abc000 "), "15000");
  assert.equal(sanitizeLedgerAmountInput(""), "");
  assert.equal(sanitizeLedgerAmountInput("1,00"), "100");
  assert.equal(parseLedgerAmount("1,500,000"), 1500000);
  assert.equal(parseLedgerAmount(String(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER);
  assert.equal(parseLedgerAmount("9007199254740992"), null);
  assert.match(pageCompact, /amount:amountValue/);
  assert.doesNotMatch(pageCompact, /amount:formatLedgerAmountInput/);
});

test("entry detail and inventory candidate editor expose complete Vietnamese UI labels", () => {
  for (const label of [
    "Chi tiết", "Đóng", "Cần xác nhận", "Đã ghi sổ", "Không có tài khoản",
    "Sửa", "Hóa đơn", "Phương thức thanh toán", "Phương thức xử lý",
    "Thanh toán ngay", "Ghi nhận công nợ", "Danh mục chi phí",
    "Tài khoản thanh toán thực tế", "Ghi chú", "Ghi mặt hàng này vào sổ",
  ]) assert.match(page, new RegExp(label));
  // Detail summary top no longer renders a separate source/category line, but the
  // candidate/edit category picker still uses the label helper.
  assert.doesNotMatch(pageCompact, /manualExpenseCategoryLabel\(entry\.categoryName,lang\)/);
  assert.doesNotMatch(page, /sourceLabel\(entry, ?lang\)/);
  assert.doesNotMatch(page, /function sourceLabel/);
  // categoryName data itself must stay alive for search/filter.
  assert.match(pageCompact, /entry\.categoryName\?\?""/);
  assert.match(pageCompact, /manualExpenseCategoryLabel\(row\.name,lang\)/);
  assert.match(pageCompact, /<EntryDetailSheetlang=\{lang\}/);
  assert.match(pageCompact, /kind="full"compacttopAlignedcomfortableTop/);
  assert.match(page, /Chi tiết giao dịch/);
  assert.match(page, /거래 상세/);
  assert.match(pageCompact, /entry\.status==="pending"\?"⚠️":"✅"/);
  assert.match(pageCompact, /direction==="income"\?"💰":direction==="expense"\?"💸":"🔄"/);
  assert.match(pageCompact, /className=\{styles\.itemDescription\}/);
  assert.match(pageCompact, /className=\{`\$\{styles\.candidateFields\}/);
  assert.match(css, /\.detailSummary\{display:grid;gap:5px;padding:10px 11px/);
  assert.match(css, /\.itemLine\{[^}]*grid-template-columns:minmax\(0,1fr\) auto/);
  assert.match(css, /\.candidateFields\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
});

test("manual category migration adds only the six missing canonical rows", () => {
  for (const name of ["청소·위생비", "배송·운송비", "운영 소모품", "인쇄·홍보비", "직원 주거비", "세금"]) {
    assert.match(manualCategories, new RegExp(`'${name}'`));
  }
  assert.doesNotMatch(manualCategories, /세금·사회보험|복리후생·기타 운영비/);
  assert.match(manualCategories, /on conflict \(kind, name\) do nothing/);
  assert.doesNotMatch(manualCategories, /ledger_inventory_category_mappings|급여\/인건비|insert into public\.ledger_transactions/);
});

test("manual entry sheet is top aligned, compact and keeps all transaction modes", () => {
  assert.match(page, /comfortableTop/);
  assert.match(page, /Thêm giao dịch/);
  assert.doesNotMatch(page, /title="수동 내역 추가"/);
  assert.match(keepingUi, /topAligned\?"flex-start"/);
  assert.match(keepingUi, /calc\(100dvh/);
  assert.match(keepingUi, /document\.body\.style\.overflow="hidden"/);
  for (const label of ["💸", "💰", "🔄", "⚖️", "💵", "📅", "🏷️", "🤝", "🏦", "📝"]) assert.match(page, new RegExp(label));
  assert.match(pageCompact, /scrollablelabel=/);
  assert.match(page, /type="date"/);
  assert.match(page, /type="time"/);
  assert.match(page, /Tài khoản điều chỉnh/);
  assert.match(css, /\.manualGrid\{display:grid;gap:9px\}/);
  assert.match(css, /\.manualRow\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(css, /\.manualSingle\{grid-template-columns:minmax\(0,1fr\)\}/);
  assert.match(pageCompact, /topAlignedcomfortableTop/);
  assert.match(keepingUi, /max\(24px, calc\(env\(safe-area-inset-top\) \+ 16px\)\)/);
  assert.match(css, /\.manualGrid>\*\{min-width:0\}/);
  assert.match(pageCompact, /type==="transfer"/);
  assert.match(pageCompact, /type==="balance_adjustment"/);
});

test("book UI keeps operational consoles out of the primary flow", () => {
  for (const hidden of ["InventoryCandidatePanel", "MonthClosePanel", "RecurringReserveBepPanel", "데이터 동기화", "준비금 · BEP"]) assert.doesNotMatch(page, new RegExp(hidden));
  for (const visible of ["장부 내역 추가", "전체", "수입", "지출", "수동", "확인 필요"]) assert.match(page, new RegExp(visible));
  assert.match(route, /loadMonthTransactions/);
  assert.match(route, /loadPendingInventoryCandidates/);
  assert.match(route, /pageSize = 1000/);
});
