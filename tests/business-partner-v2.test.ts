import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const migration = read("supabase/migrations/202608220002_add_inventory_supplier_candidates.sql");
const inventoryApi = read("app/api/inventory/items/route.ts");
const itemServer = read("lib/inventory/items-server.ts");
const bootstrap = read("lib/inventory/bootstrap-server.ts");
const bootstrapRoute = read("app/api/inventory/bootstrap-stream/route.ts");
const resolver = read("lib/inventory/supplier-partners-server.ts");
const inventoryUi = read("app/(protected)/inventory/page.tsx");
const adminApi = read("app/api/admin/partners/aliases/[id]/route.ts");
const partnerServer = read("lib/partners/server.ts");
const adminPage = read("app/(protected)/admin/partners/page.tsx");
const infoPage = read("app/(protected)/admin/partners/info/page.tsx");
const partnerTabs = read("lib/navigation/partner-tabs.ts");
const partnerSubNav = read("components/PartnerSubNav.tsx");
const partnerLayout = read("app/(protected)/admin/partners/layout.tsx");
const partnerStyles = read("app/(protected)/admin/partners/partners.module.css");
const candidatePage = read("app/(protected)/admin/partners/candidates/[id]/page.tsx");
const candidateForm = read("components/CandidatePartnerReviewForm.tsx");
const keepingUi = read("components/bar/keeping/KeepingUi.tsx");
const partnerDetail = read("app/(protected)/admin/partners/[id]/page.tsx");
const partnerForm = read("components/PartnerForm.tsx");
const nextConfig = read("next.config.ts");

test("existing supplier strings seed pending aliases without creating partners", () => {
  assert.match(migration, /insert into public\.business_partner_supplier_aliases[\s\S]*from public\.inventory[\s\S]*group by lower\(btrim\(i\.supplier\)\)/);
  assert.doesNotMatch(migration, /insert into public\.business_partners[\s\S]*select[\s\S]*from public\.inventory/i);
});

test("normalized aliases are unique without accent folding", () => {
  assert.match(migration, /normalized_name text not null/);
  assert.match(migration, /unique index business_partner_supplier_aliases_normalized_unique[\s\S]*normalized_name/);
  assert.match(migration, /lower\(btrim\(i\.supplier\)\)/);
  assert.doesNotMatch(migration, /unaccent/i);
});

test("inventory FK is nullable and raw supplier/history remain untouched", () => {
  assert.match(migration, /add column supplier_partner_id bigint null[\s\S]*references public\.business_partners\(id\) on delete restrict/);
  assert.doesNotMatch(migration, /update public\.inventory set supplier\s*=/i);
  assert.doesNotMatch(migration, /update public\.inventory_logs|alter table public\.inventory_logs/i);
});

test("direct input uses one server-only resolver and preserves pending or ignored aliases", () => {
  assert.match(inventoryApi, /resolveInventorySupplier/);
  assert.match(resolver, /business_partner_resolve_inventory_supplier_v1/);
  assert.match(migration, /if v_alias\.status = 'linked'/);
  assert.match(migration, /return jsonb_build_object\('status', 'resolved',[\s\S]*'aliasStatus', v_alias\.status\)/);
});

test("regular partner selection is server canonicalized", () => {
  assert.match(migration, /where id = p_supplier_partner_id and is_active = true/);
  assert.match(migration, /'supplierName', v_partner\.name, 'supplierPartnerId', v_partner\.id/);
  assert.match(inventoryUi, /supplierPartnerId/);
});

test("direct input matching an active partner name canonicalizes before aliases", () => {
  const normalizedIndex = migration.indexOf("v_normalized := lower(v_name)");
  const partnerLookupIndex = migration.indexOf("where lower(btrim(name)) = v_normalized and is_active = true");
  const aliasLookupIndex = migration.indexOf("where normalized_name = v_normalized for update");
  const candidateInsertIndex = migration.indexOf("insert into public.business_partner_supplier_aliases(supplier_name, normalized_name)", aliasLookupIndex);

  assert.ok(normalizedIndex >= 0 && normalizedIndex < partnerLookupIndex);
  assert.ok(partnerLookupIndex < aliasLookupIndex && aliasLookupIndex < candidateInsertIndex);
  assert.match(migration.slice(partnerLookupIndex, aliasLookupIndex), /'supplierName', v_partner\.name[\s\S]*'supplierPartnerId', v_partner\.id/);
});

test("normalized partner lookup handles case and surrounding whitespace without creating a candidate", () => {
  assert.match(migration, /v_name text := nullif\(btrim\(p_supplier_name\), ''\)/);
  assert.match(migration, /v_normalized := lower\(v_name\)/);
  assert.match(migration, /lower\(btrim\(name\)\) = v_normalized/);
});

test("inactive partner names are not auto-linked and continue to alias handling", () => {
  assert.match(migration, /where lower\(btrim\(name\)\) = v_normalized and is_active = true/);
  assert.doesNotMatch(migration, /update public\.business_partners[\s\S]*is_active\s*=\s*true/i);
});

test("general form and quick purchase share the supplier contract", () => {
  assert.ok((inventoryUi.match(/supplierPartnerId/g) ?? []).length >= 6);
  assert.match(inventoryUi, /quickPurchasePartnerId/);
  assert.match(inventoryUi, /mode: "quick-save"/);
});

test("bootstrap adds minimal supplier options without another client fetch", () => {
  assert.match(bootstrap, /Promise\.all\([\s\S]*business_partners[\s\S]*business_partner_supplier_aliases/);
  assert.match(bootstrapRoute, /supplierPartners: base\.supplierPartners[\s\S]*supplierAliases: base\.supplierAliases/);
  assert.doesNotMatch(inventoryUi, /fetch\("\/api\/admin\/partners/);
});

test("inventory response exposes canonical and raw supplier search/display fields", () => {
  assert.match(itemServer, /supplier_partner_id/);
  assert.match(itemServer, /supplier_partner_name/);
  assert.match(inventoryUi, /item\.supplier_partner_name[\s\S]*item\.supplier/);
});

test("candidate review is atomic for new existing ignore and reopen", () => {
  assert.match(migration, /business_partner_review_supplier_alias_v1/);
  for (const action of ["create_partner", "link_existing", "ignore", "reopen"]) assert.match(migration, new RegExp(`p_action = '${action}'`));
  assert.match(migration, /update public\.inventory set supplier_partner_id=v_partner_id where lower\(btrim\(supplier\)\)=v_alias\.normalized_name/);
  assert.match(adminApi, /business_partner_review_supplier_alias_v2/);
});

test("candidate review is owner/master only and browser table mutation is denied", () => {
  assert.match(migration, /not in \('owner', 'master'\)/);
  assert.match(migration, /revoke all on table public\.business_partner_supplier_aliases[\s\S]*from public, anon, authenticated, service_role/);
  assert.match(migration, /owner to postgres/g);
  assert.match(migration, /grant execute[\s\S]*to service_role/);
});

test("partner registration and info routes separate candidates from masters", () => {
  assert.match(adminPage, /등록 대기/);
  assert.match(adminPage, /제외/);
  assert.doesNotMatch(adminPage, /shownPartners/);
  assert.match(adminPage, /PartnerForm/);
  assert.doesNotMatch(infoPage, /<PartnerForm/);
  assert.doesNotMatch(infoPage, /supplierAliases|Candidate/);
  assert.match(candidatePage, /새 정규 거래처로 등록/);
  assert.match(candidatePage, /기존 정규 거래처에 연결/);
  assert.match(candidatePage, /등록하지 않음/);
});

test("partner routes share the common two-tab SubNav", () => {
  assert.match(partnerTabs, /href: "\/admin\/partners"/);
  assert.match(partnerTabs, /href: "\/admin\/partners\/info"/);
  assert.match(partnerSubNav, /<SubNav tabs={getPartnerTabs\(pathname, lang\)} \/>/);
  assert.match(partnerLayout, /<PartnerSubNav \/>/);
});

test("candidate and partner lists use one-line compact rows", () => {
  assert.match(adminPage, /className={styles\.compactRow}/);
  assert.match(infoPage, /className={styles\.compactRow}/);
  assert.match(partnerStyles, /grid-template-columns:minmax\(0,1fr\) auto auto auto/);
  assert.match(partnerStyles, /text-overflow:ellipsis;white-space:nowrap/);
  assert.doesNotMatch(adminPage, /lastSeenAt|최근 사용/);
});

test("partner detail renders real linked inventory instead of placeholders", () => {
  assert.match(partnerDetail, /linkedInventory/);
  assert.match(partnerDetail, /purchasePrice/);
  assert.doesNotMatch(partnerDetail, /noHistory/);
});

test("new partner forms hide Ledger linking while partner detail keeps it", () => {
  assert.match(adminPage, /showLedgerParty={false}/);
  assert.match(adminPage, /showActive={false}/);
  assert.doesNotMatch(candidateForm, /ledgerPartyId[^:]/);
  assert.match(candidatePage, /isActive: true, ledgerPartyId: null/);
  assert.doesNotMatch(partnerDetail, /showLedgerParty={false}/);
  assert.match(partnerForm, /showLedgerParty = true/);
  assert.match(partnerForm, /showActive = true/);
  assert.match(partnerForm, /isActive: true/);
  assert.match(partnerForm, /showLedgerParty \? <section[\s\S]*t\.ledger/);
});

test("partner add popover has a compact closable header and sectioned form", () => {
  assert.match(adminPage, /className={styles\.modalHeader}/);
  assert.match(adminPage, /aria-label={lang === "vi" \? "Đóng" : "닫기"}/);
  assert.match(adminPage, /event\.key === "Escape"/);
  for (const heading of ["기본 정보", "결제 방식", "연락처", "기타"]) assert.match(partnerForm, new RegExp(heading));
  assert.match(partnerStyles, /\.modalHeader button\{[\s\S]*width:42px;height:42px/);
  assert.match(partnerStyles, /\.modalHeader h2\{margin:0;font-family:inherit;font-size:15px;font-weight:700;line-height:normal\}/);
  assert.match(adminPage, /layout="modal"/);
  assert.match(partnerStyles, /\.formSections\{display:flex;flex-direction:column\}/);
  assert.match(partnerStyles, /\.modalPartnerForm\{flex:1 1 auto;min-height:0;overflow:hidden\}/);
});

test("partner form keeps header and submit visible around a scrollable two-column body", () => {
  assert.match(partnerForm, /className={styles\.formBody}/);
  assert.match(partnerForm, /<footer className={styles\.formFooter}>/);
  for (const value of ["📋", "기본 정보", "💳", "결제 방식", "☎️", "연락처", "📝", "기타"]) assert.match(partnerForm, new RegExp(value));
  assert.match(partnerStyles, /\.modalPartnerForm \.formBody\{[\s\S]*min-height:0[\s\S]*overflow-y:auto/);
  assert.match(partnerStyles, /\.pagePartnerForm \.formBody\{padding:0;overflow:visible\}/);
  assert.match(partnerStyles, /\.formFooter\{flex:0 0 auto/);
  assert.match(partnerStyles, /100dvh/);
  assert.match(partnerStyles, /\.formGrid\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(partnerStyles, /z-index:1400/);
});

test("390px partner create dialog is compact over a dimmed app with proportional fields", () => {
  assert.match(adminPage, /role="dialog" aria-modal="true"/);
  assert.match(partnerStyles, /\.addPopover\[open\]::before\{[\s\S]*position:fixed;inset:0;z-index:1399;background:rgba\(15,23,42,\.68\)/);
  assert.match(partnerStyles, /\.addForm\{position:fixed;z-index:1400;top:50%;left:50%;display:flex;width:min\(460px,calc\(100vw - 32px\)\);max-height:calc\(100dvh - 32px\)/);
  assert.doesNotMatch(partnerStyles, /height:100dvh|max-width:none|background:#fff\}\.addForm\{position:fixed;inset:0/);
  assert.match(partnerStyles, /\.basicGrid\{grid-template-columns:minmax\(0,1\.65fr\) minmax\(110px,1fr\)/);
  assert.match(partnerForm, /PartnerSettlementFields/);
  assert.match(partnerForm, /showActive \? <label className={styles\.toggle}/);
  assert.match(partnerStyles, /\.formSections textarea\{height:64px;min-height:60px;max-height:68px/);
  assert.match(partnerStyles, /grid-auto-rows:max-content;align-content:start/);
  assert.match(partnerStyles, /\.formGrid \.full\{grid-column:1\/-1\}/);
  assert.match(nextConfig, /devIndicators: false/);
});

test("partner form keeps the BAR section and control language without a nested outer card", () => {
  assert.doesNotMatch(partnerForm, /className={styles\.formCard}/);
  assert.doesNotMatch(partnerStyles, /\.formCard\{/);
  assert.match(partnerStyles, /\.formSection\{display:grid;gap:11px[\s\S]*padding:16px 0;border-top:1px solid #e5e7eb/);
  assert.match(partnerStyles, /\.formSection h3\{display:flex;align-items:center;gap:6px[\s\S]*font-size:15px/);
  assert.match(partnerStyles, /\.formSections input,\.formSections select\{height:44px;padding:0 12px\}/);
  assert.match(partnerForm, /<PartnerSettlementFields/);
  assert.match(partnerForm, /payment: "결제 방식"/);
  assert.match(partnerForm, /payment: "Hình thức thanh toán"/);
  assert.doesNotMatch(partnerForm, /defaultPaymentTermDays \?\? 30/);
});

test("candidate review uses a BAR-style page card and native document scrolling", () => {
  assert.match(candidatePage, /style={keepingFormCardStyle}/);
  assert.match(candidatePage, /<BarSection title={labels\.review}/);
  assert.match(candidatePage, /<BarSegmentedControl<Action>/);
  assert.match(candidatePage, /<CandidatePartnerReviewForm/);
  for (const shared of ["BarSection", "BarField", "BarSegmentedControl", "keepingInputStyle", "primaryButtonStyle"]) assert.match(candidateForm + candidatePage, new RegExp(shared));
  assert.match(keepingUi, /keepingFormCardStyle: React\.CSSProperties = \{ padding:"15px 15px 16px",border:"1px solid #dcdfe4",borderRadius:18,background:"#fff",boxShadow:"0 6px 20px rgba\(0,0,0,\.04\)" \}/);
  assert.doesNotMatch(candidatePage + candidateForm, /position:\s*"fixed"|overflowY|document\.body\.style\.overflow|onTouchMove/);
  assert.doesNotMatch(candidateForm, /styles\.formGrid|styles\.basicGrid/);
  assert.match(keepingUi, /width:"100%",minWidth:0,minHeight:40/);
});

test("candidate detail includes matched inventory items without changing review writes", () => {
  assert.match(adminApi, /loadSupplierAliasInventory\(alias\.supplierName\)/);
  assert.match(adminApi, /partnerJson\(\{ ok: true, alias, partners: partnerData\.partners, inventoryItems \}\)/);
  assert.match(partnerServer, /select\("id,supplier,item_name,item_name_vi,part,category,category_vi,is_active"\)/);
  assert.match(partnerServer, /filter\(row => normalizeSupplierName\(row\.supplier\) === normalizedName\)/);
  assert.match(partnerServer, /String\(value \?\? ""\)\.trim\(\)\.toLowerCase\(\)/);
  assert.match(adminApi, /business_partner_review_supplier_alias_v2/);
  assert.doesNotMatch(adminApi, /inventoryItems[\s\S]*PATCH[\s\S]*inventoryItems/);
});

test("candidate identity reuses the dominant group and renders a bounded item list", () => {
  assert.match(candidatePage, /alias\.dominantInventoryGroup\[lang\]/);
  assert.match(candidatePage, /className={styles\.groupBadge}/);
  assert.match(candidatePage, /className={styles\.candidateItems}/);
  assert.match(candidatePage, /item\.categoryVi \|\| item\.category/);
  assert.match(candidatePage, /item\.itemNameVi \|\| item\.itemName/);
  assert.match(partnerStyles, /\.candidateItems\{max-height:158px;overflow-y:auto/);
  assert.match(partnerStyles, /\.candidateItemName\{color:#111827\}/);
  assert.doesNotMatch(candidatePage, /<Link|styles\.backLink|재고 \$\{|사용 \$\{|품목 \$\{/);
});

test("BAR section isolates emoji fallback while inheriting the app font for text", () => {
  assert.match(keepingUi, /h2 style=\{\{margin:0,fontFamily:"Arial, Helvetica, sans-serif",fontSize:15,fontWeight:700,lineHeight:1\.35,letterSpacing:"normal",fontStyle:"normal"/);
  assert.match(keepingUi, /aria-hidden="true" style=\{\{fontFamily:'"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif',fontSize:14,fontWeight:400,lineHeight:1\}\}/);
  assert.match(keepingUi, /<span style=\{\{fontFamily:"Arial, Helvetica, sans-serif",fontSize:15,fontWeight:700,lineHeight:1\.35,letterSpacing:"normal",fontStyle:"normal"\}\}>\{title\}<\/span>/);
});

test("candidate partner fields stay in compact two-column grids at mobile widths", () => {
  assert.match(candidateForm, /candidateBasicGrid[\s\S]*minmax\(0, 1\.65fr\) minmax\(110px, 1fr\)/);
  assert.match(candidateForm, /candidateTwoColumnGrid[\s\S]*repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(candidateForm, /<div style=\{candidateBasicGrid\}>[\s\S]*<BarField label=\{t\.name\}[\s\S]*<BarField label=\{t\.type\}/);
  assert.match(candidateForm, /<div style=\{candidateTwoColumnGrid\}>[\s\S]*<BarField label=\{t\.contact\}[\s\S]*<BarField label=\{t\.phone\}/);
  assert.doesNotMatch(candidateForm, /@media|gridTemplateColumns:\s*"1fr"/);
});

test("new partner memo keeps only the section heading as its visible label", () => {
  assert.match(partnerForm, /showActive \? t\.memo : <span className={styles\.srOnly}>{t\.memo}<\/span>/);
  assert.match(partnerForm, /<textarea rows=\{2\}/);
  assert.match(candidateForm, /<BarSection title={labels\.memo} icon="📝">[\s\S]*<textarea aria-label={labels\.memo}/);
});
