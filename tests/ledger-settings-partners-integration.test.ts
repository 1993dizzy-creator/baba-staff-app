import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import {
  LEDGER_SETTINGS_TABS, PARTNER_SETTINGS_VIEWS, ledgerSettingsHref, ledgerSettingsTabText, legacyPartnerRedirectHref,
  parseLedgerSettingsTab, parsePartnerSettingsView, partnerSettingsText,
} from "../lib/partners/settings-view.ts";
import { getLedgerTabs } from "../lib/navigation/ledger-tabs.ts";

const read = (path: string) => readFileSync(path, "utf8");
const settingsPage = read("app/(protected)/admin/ledger/settings/page.tsx");
// Page source plus its KO/VI copy modules for visible-text checks.
const settings = settingsPage + read("lib/ledger/settings-text.ts") + read("lib/ledger/reserve-text.ts");
const panel = read("components/partners/PartnerSettingsPanel.tsx");
const partnersPage = read("app/(protected)/admin/partners/page.tsx");
const infoPage = read("app/(protected)/admin/partners/info/page.tsx");
const partnerDetail = read("app/(protected)/admin/partners/[id]/page.tsx");
const candidatePage = read("app/(protected)/admin/partners/candidates/[id]/page.tsx");
const adminMenu = read("app/(protected)/admin/page.tsx");
const css = read("app/(protected)/admin/ledger/ledger-settings.module.css");

test("A: 장부설정 has exactly 기본설정 / 거래처 / 준비금 and no category, automation or recurring-expense UI", () => {
  assert.deepEqual([...LEDGER_SETTINGS_TABS], ["basic", "partners", "reserves"]);
  assert.deepEqual(LEDGER_SETTINGS_TABS.map(tab => ledgerSettingsTabText.ko[tab]), ["기본설정", "거래처", "준비금"]);
  assert.deepEqual(LEDGER_SETTINGS_TABS.map(tab => ledgerSettingsTabText.vi[tab]), ["Cài đặt cơ bản", "Đối tác", "Quỹ dự phòng"]);
  assert.match(settings, /\{LEDGER_SETTINGS_TABS\.map\(value => <button key=\{value\} type="button" role="tab" aria-selected=\{activeTab === value\}/);
  for (const removed of [/수입·비용 분류/, /계획 · 자동화/, /반복비용/, /recurring-expenses/, /ExpenseCategoryBranch/, /async function createPlan/, /거래처 관리로 이동/, /"automation"/, /"owners"\]/]) {
    assert.doesNotMatch(settings, removed);
  }
  assert.equal(parseLedgerSettingsTab("partners"), "partners");
  assert.equal(parseLedgerSettingsTab("automation"), "basic");
  assert.equal(parseLedgerSettingsTab(null), "basic");
});

test("B: 기본설정 shows 🏦 자금계정 and 🤝 사장 정산 as independent accordions, open by default", () => {
  assert.match(settings, /const \[fundAccountsOpen, setFundAccountsOpen\] = useState\(true\);/);
  assert.match(settings, /const \[ownerSettlementOpen, setOwnerSettlementOpen\] = useState\(true\);/);
  assert.match(settings, /aria-expanded=\{fundAccountsOpen\}[^>]*onClick=\{\(\) => setFundAccountsOpen\(value => !value\)\}><h2>🏦 \{tabText\.fundAccounts\}<\/h2>/);
  assert.match(settings, /aria-expanded=\{ownerSettlementOpen\}[^>]*onClick=\{\(\) => setOwnerSettlementOpen\(value => !value\)\}><h2>🤝 \{tabText\.ownerSettlement\}<\/h2>/);
  assert.match(settings, /\{fundAccountsOpen \? <div id="settings-fund-accounts"/);
  assert.match(settings, /\{ownerSettlementOpen && owners \? <div id="settings-owner-settlement"/);
  assert.equal(ledgerSettingsTabText.ko.accountCount(5), "5개");
  assert.equal(ledgerSettingsTabText.ko.participantCount(3), "참여자 3명");
  // Existing owner settings and save flows are reused unchanged.
  for (const phrase of ["투자자 구성", "투자자 선택", "투자자 구성 저장", "이익 배분 비율", "이익 배분 비율 저장"]) assert.ok(settings.includes(phrase), phrase);
  assert.match(settings, /mutate\("\/api\/admin\/ledger\/owners", \{ action: "participants"/);
  assert.match(css, /\.accordionHeader\{[^}]*grid-template-columns:minmax\(0,1fr\) auto 14px/);
  assert.match(css, /\.accordionHeader>h2\{[^}]*white-space:nowrap/);
});

test("C: 거래처 tab — add, subtype manager, then 등록대기/사용중/사용안함 over the existing partner UI", () => {
  assert.deepEqual([...PARTNER_SETTINGS_VIEWS], ["pending", "active", "inactive"]);
  assert.deepEqual(PARTNER_SETTINGS_VIEWS.map(view => partnerSettingsText.ko[view]), ["등록대기", "사용중", "사용안함"]);
  const order = ["labels.title}</h2>", "labels.add}</button>", "<PartnerSubtypeManager ", "PARTNER_SETTINGS_VIEWS.map"].map(marker => panel.indexOf(marker));
  assert.ok(order.every(index => index > 0), String(order));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.match(settings, /<PartnerSettingsPanel lang=\{lang\} view=\{partnerView\} onViewChange=/);
  // Same create endpoint, form and validation as the old registration page.
  assert.match(panel, /fetch\("\/api\/admin\/partners", \{ method: "POST"/);
  assert.match(panel, /<PartnerForm formId=\{ADD_FORM_ID\}/);
  // Inactive = business partners with is_active false; ignored/archived candidates never count there.
  assert.match(panel, /inactive: partners\.filter\(row => !row\.isActive\)\.length/);
  assert.match(panel, /pending: pendingAliases\.length/);
  assert.doesNotMatch(panel.slice(panel.indexOf("const counts"), panel.indexOf("const groups")), /ignored|archived/);
  // Rows still open the existing detail and candidate review pages.
  assert.match(panel, /href=\{`\/admin\/partners\/\$\{partner\.id\}`\}/);
  assert.match(panel, /href=\{`\/admin\/partners\/candidates\/\$\{alias\.id\}`\}/);
  assert.match(panel, /effectivePartnerEmoji\(partner\.partnerType, partner\.partnerSubtype\)/);
  assert.equal(parsePartnerSettingsView("inactive"), "inactive");
  assert.equal(parsePartnerSettingsView("ignored"), "active");
});

test("D: old /admin/partners URLs redirect into 장부설정 > 거래처 and keep other query params", () => {
  assert.equal(legacyPartnerRedirectHref("pending", {}), "/admin/ledger/settings?tab=partners&view=pending");
  assert.equal(legacyPartnerRedirectHref("active", {}), "/admin/ledger/settings?tab=partners&view=active");
  assert.equal(legacyPartnerRedirectHref("active", { q: "mega", tab: "x", view: "y", tag: ["a", "b"] }), "/admin/ledger/settings?q=mega&tag=a&tag=b&tab=partners&view=active");
  assert.match(partnersPage, /redirect\(legacyPartnerRedirectHref\("pending", await searchParams\)\)/);
  assert.match(infoPage, /redirect\(legacyPartnerRedirectHref\("active", await searchParams\)\)/);
  for (const page of [partnersPage, infoPage]) assert.doesNotMatch(page, /"use client"|useState|fetch\(/);
  assert.equal(ledgerSettingsHref("partners", "pending"), "/admin/ledger/settings?tab=partners&view=pending");
  assert.match(candidatePage, /router\.push\(ledgerSettingsHref\("partners", "pending"\)\)/);
});

test("E: each tab loads only its own data and price history stays lazy", () => {
  const loadBasic = settings.slice(settings.indexOf("const loadBasic"), settings.indexOf("const loadReserves"));
  const loadReserves = settings.slice(settings.indexOf("const loadReserves"), settings.indexOf("const load = "));
  assert.match(loadBasic, /\/api\/admin\/ledger\?month=/);
  assert.match(loadBasic, /\/api\/admin\/ledger\/owners\?throughMonth=/);
  assert.doesNotMatch(loadBasic, /reserves|partners|price-changes/);
  assert.match(loadReserves, /\/api\/admin\/ledger\/reserves/);
  assert.doesNotMatch(loadReserves, /owners|partners|\?month=/);
  assert.match(settings, /if \(activeTab === "partners"\) return;/);
  assert.match(settings, /const load = activeTab === "reserves" \? loadReserves : loadBasic;/);
  // The partner panel is mounted only on its tab and makes one list read; no price history.
  assert.match(settings, /\{activeTab === "partners" \? <section[^>]*>\s*<PartnerSettingsPanel/);
  assert.equal((panel.match(/fetch\("\/api\/admin\/partners", \{ cache: "no-store" \}\)/g) ?? []).length, 1);
  assert.doesNotMatch(panel + settings, /price-changes|priceChanges/);
  // Partner detail keeps its first-click price-history load.
  assert.match(partnerDetail, /async function openPriceChanges\(\) \{\s*setDetailTab\("priceChanges"\);\s*if \(priceChangesStatus === "loading" \|\| priceChangesStatus === "loaded"\) return;/);
  assert.doesNotMatch(partnerDetail.slice(partnerDetail.indexOf("const load = useCallback"), partnerDetail.indexOf("async function update")), /price-changes/);
});

test("F: 준비금 keeps the reserve features; recurring-expense UI is gone but its backend and history stay", () => {
  for (const marker of ["ReservePlanCard", "/api/admin/ledger/reserves/${id}/entries", "/api/admin/ledger/reserves/${id}/recurring", "/api/admin/ledger/reserves/schedule", "정기 적립 저장", "적립 확정", "+ 준비금 추가"]) assert.ok(settings.includes(marker), marker);
  assert.equal(existsSync("app/(protected)/admin/ledger/RecurringReserveBepPanel.tsx"), false);
  // Unused recurring HTTP routes are gone; the migrations (tables, functions, preflight) stay.
  for (const path of ["app/api/admin/ledger/recurring-expenses/route.ts", "app/api/admin/ledger/recurring-expenses/sync/route.ts", "app/api/admin/ledger/recurring-expenses/payments/route.ts"]) {
    assert.equal(existsSync(path), false, path);
  }
  for (const path of ["supabase/migrations/202608210007_add_recurring_reserves_bep.sql", "supabase/migrations/20261002062405_fix_preflight_inactive_recurring_plans.sql"]) {
    assert.equal(existsSync(path), true, path);
  }
  assert.match(read("supabase/migrations/20261002062405_fix_preflight_inactive_recurring_plans.sql"), /ledger_recurring_expense_plans p where p\.is_active=true/);
});

test("G: no standalone 거래처관리 menu; partners are reached through 가게 장부 > 장부설정", () => {
  assert.doesNotMatch(adminMenu, /href: "\/admin\/partners"|거래처 관리/);
  assert.equal(existsSync("components/PartnerSubNav.tsx"), false);
  assert.equal(existsSync("lib/navigation/partner-tabs.ts"), false);
  for (const path of ["/admin/ledger/settings", "/admin/partners/12", "/admin/partners/candidates/3"]) {
    const active = getLedgerTabs(path, "ko").filter(tab => tab.active).map(tab => tab.label);
    assert.deepEqual(active, ["장부설정"], path);
  }
  assert.match(read("app/(protected)/admin/partners/layout.tsx"), /requireRole\(PARTNER_MANAGER_ROLES\)[\s\S]*<LedgerSubNav \/>/);
});
