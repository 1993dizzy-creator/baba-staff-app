import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const { buildLedgerEntries } = createRequire(import.meta.url)("../lib/ledger/entries.ts") as typeof import("../lib/ledger/entries");
const { MANUAL_EXPENSE_CATEGORY_NAMES, isManualExpenseCategory } = createRequire(import.meta.url)("../lib/ledger/manual-entry-policy.ts") as typeof import("../lib/ledger/manual-entry-policy");
const read = (path: string) => readFileSync(path, "utf8");
const page = read("app/(protected)/admin/ledger/entries/page.tsx");
const css = read("app/(protected)/admin/ledger/entries/entries.module.css");
const keepingUi = read("components/bar/keeping/KeepingUi.tsx");
const route = read("app/api/admin/ledger/route.ts");
const autoLink = read("supabase/migrations/20260824152518_auto_link_business_partners_to_ledger.sql");
const categories = read("supabase/migrations/20260824152948_ledger_category_v1.sql");
const opening = read("supabase/migrations/20260824153108_seed_august_2026_opening_balances.sql");
const manualCategories = read("supabase/migrations/202608250001_add_manual_ledger_expense_categories.sql");

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

test("opening balances and the four business funds match the production policy", () => {
  for (const [code, amount] of [["store_cash", "95464986"], ["vuong_personal_custody", "5231310"], ["cho_personal_custody", "95470741"], ["baba_corporate_bank", "104186605"]]) {
    assert.match(opening, new RegExp(`'${code}'[^\\n]*${amount}`));
  }
  assert.match(autoLink, /'vuong_personal_custody'\s*,\s*'personal_custody'\s*,\s*'Vương'/);
  assert.match(page, /account\.is_business_fund&&account\.type!=="card_clearing"/);
  assert.match(page, /openingBalance/);
  assert.match(page, /당월 시재/);
  assert.match(page, /현재 보유금/);
  assert.match(css, /grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
});

test("business partners are the user-facing party source and defaults stay one-way", () => {
  assert.match(autoLink, /business_partner_ensure_ledger_party_v1\(\s*p_business_partner_id bigint\s*\)/);
  assert.match(autoLink, /after insert or update of name,\s*default_payment_term_days,\s*is_active/);
  assert.match(autoLink, /revoke all on function public\.business_partner_ensure_ledger_party_v1\(bigint\)\s+from public, anon, authenticated, service_role/);
  assert.match(route, /from\("business_partners"\)/);
  assert.match(route, /from\("business_partner_ledger_parties"\)/);
  assert.match(page, /data\.partners\.filter/);
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
  assert.match(page, /className=\{styles\.addButton\}[\s\S]{0,160}>장부 내역 추가<\/button>/);
  assert.match(css, /\.addButton\{width:100%/);

  assert.match(page, /store_cash:0,baba_corporate_bank:1,vuong_personal_custody:2,cho_personal_custody:3/);
  assert.match(page, /account\.is_business_fund&&account\.type!=="card_clearing"/);
  assert.match(page, /businessAccounts\.reduce\(\(sum,account\)=>sum\+account\.openingBalance,0\)/);
  assert.match(page, /className=\{styles\.openingTotal\}/);
  assert.doesNotMatch(page, /month\.replace\("-","\."\)/);
  assert.match(page, /<h2 id="opening-title">당월 시재<\/h2><span>월초 고정<\/span>/);
  assert.match(css, /\.openingSection\{padding:10px 12px\}/);
  assert.match(css, /\.openingGrid\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\);gap:0\}/);
  assert.match(css, /\.openingGrid article\{padding:6px 8px;border:0;border-radius:0;background:transparent\}/);
  assert.match(css, /@media\(max-width:560px\)[\s\S]*\.openingGrid\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);

  assert.match(page, /sort\(\(a,b\)=>a\.date\.localeCompare\(b\.date\)\)/);
  assert.match(page, /dates\.includes\(today\)\?today:dates\.at\(-1\)/);
  assert.match(page, /setExpandedDates\(current=>/);
  assert.match(page, /Boolean\(search\.trim\(\)\)\|\|expandedDates\.has\(group\.date\)/);
  assert.match(page, /\{expanded\?<div id=\{panelId\}>\{group\.rows\.map/);
  assert.match(page, /className=\{styles\.entryMain\}/);
  assert.match(page, /entry\.status==="pending"\?<span className=\{styles\.pendingBadge\}>확인 필요<\/span>:null/);
  assert.match(css, /\.entryMain\{[^}]*text-overflow:ellipsis;white-space:nowrap/);
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
  assert.match(page, /data\.categories\.filter\(isManualExpenseCategory\)\.sort\(manualExpenseCategorySort\)/);
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
  assert.match(page, /<BarSheet kind="bottom" topAligned title="장부 내역 추가"/);
  assert.doesNotMatch(page, /title="수동 내역 추가"/);
  assert.match(keepingUi, /topAligned\?"flex-start"/);
  assert.match(keepingUi, /calc\(100dvh/);
  assert.match(keepingUi, /document\.body\.style\.overflow="hidden"/);
  for (const label of ["💸 지출", "💰 수입", "🔄 이체", "⚖️ 잔액조정", "💵 금액", "📅 발생일", "🏷️ 카테고리", "🤝 거래처", "🏦 출금 계정", "🏦 입금 계정", "📝 메모"]) assert.match(page, new RegExp(label));
  assert.match(css, /\.manualGrid\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\);gap:9px\}/);
  assert.match(css, /\.manualGrid>\*\{min-width:0\}/);
  assert.match(page, /type==="transfer"/);
  assert.match(page, /type==="balance_adjustment"/);
});

test("book UI keeps operational consoles out of the primary flow", () => {
  for (const hidden of ["InventoryCandidatePanel", "MonthClosePanel", "RecurringReserveBepPanel", "데이터 동기화", "준비금 · BEP"]) assert.doesNotMatch(page, new RegExp(hidden));
  for (const visible of ["장부 내역 추가", "전체", "수입", "지출", "수동", "확인 필요"]) assert.match(page, new RegExp(visible));
  assert.match(route, /loadMonthTransactions/);
  assert.match(route, /loadPendingInventoryCandidates/);
  assert.match(route, /pageSize = 1000/);
});
