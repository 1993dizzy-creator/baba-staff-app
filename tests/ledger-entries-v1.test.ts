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
  assert.match(pageCompact, /data\?\.entries\?\?\[\]\)\.reduce/);
  assert.match(pageCompact, /entry\.direction==="income"\)totals\.income\+=entry\.amount/);
  assert.match(pageCompact, /entry\.direction==="expense"\)totals\.expense\+=entry\.amount/);
  for (const label of ["월 장부 요약", "당월 장부 기준", "Theo sổ tháng này", "시재 합계", "Tổng số dư đầu tháng"]) {
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
  assert.match(pageCompact, /manualExpenseCategoryLabel\(entry\.categoryName,lang\)/);
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
