import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const partnerDetail = read("app/(protected)/admin/partners/[id]/page.tsx");
const candidatePage = read("app/(protected)/admin/partners/candidates/[id]/page.tsx");
const partnerForm = read("components/PartnerForm.tsx");
const partnerStyles = read("app/(protected)/admin/partners/partners.module.css");

// 18/19: no standalone back link, no standalone H1
test("partner detail has no standalone back link and no standalone h1 with the partner name", () => {
  assert.doesNotMatch(partnerDetail, /←|backLink|<h1>/);
  assert.doesNotMatch(partnerDetail, /import Link from "next\/link"/);
});

// 20: partner name lives inside the top identity card, not a bare header
test("partner name and display tag remain in the top identity card without repeated classification badges", () => {
  assert.match(partnerDetail, /<BarSection title={identityTitle} icon="📎" first>/);
  assert.match(partnerDetail, /<div className={styles\.candidateIdentity}>/);
  assert.match(partnerDetail, /<div className={styles\.candidateIdentityName}>/);
  assert.match(partnerDetail, /<strong>{partner\.name}<\/strong>/);
  assert.match(partnerDetail, /partner\.displayTag \? <span className={styles\.tagBadge}>{partner\.displayTag}<\/span>/);
  assert.doesNotMatch(partnerDetail, /partnerTypeLabels|formatPartnerSubtypeName|styles\.groupBadge/);
  assert.match(partnerDetail, /partner\.isActive \? styles\.activeStatusBadge : styles\.inactiveStatusBadge/);
  assert.match(partnerStyles, /\.activeStatusBadge\{background:#23875b;color:#fff\}/);
});

// 21: supply items are inside the top identity BarSection, in a bounded scroll list
test("supply items remain in the default tab inside a bounded compact scroll list", () => {
  const identityBody = partnerDetail.slice(partnerDetail.indexOf('title={identityTitle} icon="📎" first>'), partnerDetail.indexOf("</BarSection>"));
  assert.match(identityBody, /className={styles\.candidateItems}/);
  assert.match(identityBody, /detailTab === "items"/);
  assert.match(identityBody, /linkedInventory\.length > 0 \? linkedInventory\.map/);
  assert.match(partnerStyles, /\.candidateItems\{max-height:158px;overflow-y:auto/);
});

// 22: no separate standalone "공급 품목 N" panel at the bottom
test("there is no separate standalone supply-items panel below the form", () => {
  assert.doesNotMatch(partnerDetail, /styles\.panel|<h2>{t\.supply}/);
  assert.doesNotMatch(partnerStyles, /\.panel\{/);
});

// 13: supply item rows show category / name / price, ellipsis + right-aligned nowrap price, no raw supplier
test("supply item rows show category, name, right-aligned price, and never the raw supplier string", () => {
  assert.match(partnerDetail, /<span className={styles\.supplyItemCategory}>{category \|\| "-"}<\/span>/);
  assert.match(partnerDetail, /<span className={styles\.supplyItemName}>{name \|\| "-"}<\/span>/);
  assert.match(partnerDetail, /<span className={styles\.supplyItemPrice}>{item\.purchasePrice === null/);
  assert.doesNotMatch(partnerDetail, /item\.rawSupplier|rawSupplier}<\/span>|\{item\.part\}/);
  assert.match(partnerStyles, /\.supplyItem\{display:grid;grid-template-columns:minmax\(56px,72px\) minmax\(0,1fr\) auto/);
  assert.match(partnerStyles, /\.supplyItemName\{color:#111827\}/);
  assert.match(partnerStyles, /\.supplyItemPrice\{white-space:nowrap;text-align:right/);
  assert.match(partnerStyles, /\.supplyItemInactive\{opacity:\.55\}/);
});

// 23: no duplicated "기본정보 수정" heading -- PartnerForm flows directly after identity
test("no duplicate edit-panel heading; PartnerForm's own first section is not `first` since identity precedes it", () => {
  assert.doesNotMatch(partnerDetail, /기본정보 수정|<h2>{t\.edit}/);
  assert.match(partnerDetail, /<PartnerForm key={`\${partner\.id}-\${partner\.name}-\${partner\.isActive}`} lang={lang} initial={partner} fundAccounts={fundAccounts} partnerSubtypes={partnerSubtypes} first={false} slim onSubmit={update} \/>/);
  assert.match(partnerForm, /first\?: boolean/);
  assert.match(partnerForm, /first = true/);
  assert.match(partnerForm, /<BarSection title={sectionLabels\.basic} icon="📌" first={first} compact={slim}>/);
});

// 24: Partner and Candidate detail both use the same Keeping UI card + page wrapper
test("Partner and Candidate detail share the same keepingFormCardStyle card and candidatePage wrapper", () => {
  assert.match(partnerDetail, /import \{ BarSection, keepingFormCardStyle, keepingInputStyle, primaryButtonStyle \} from "@\/components\/bar\/keeping\/KeepingUi"/);
  assert.match(partnerDetail, /<Container noPaddingTop><div className={styles\.candidatePage}>/);
  assert.match(partnerDetail, /style={keepingFormCardStyle}/);
  assert.match(candidatePage, /style={keepingFormCardStyle}/);
  assert.match(candidatePage, /<Container noPaddingTop><div className={styles\.candidatePage}>/);
});

test("partner detail keeps native document scrolling like the candidate page, no fixed/overflow tricks", () => {
  assert.doesNotMatch(partnerDetail, /position:\s*"fixed"|overflowY|document\.body\.style\.overflow|onTouchMove/);
});

test("detail card exposes localized items and price-change tabs with an empty state", () => {
  const text = read("lib/partners/text.ts");
  assert.match(partnerDetail, /role="tab" aria-selected={detailTab === "items"}/);
  assert.match(partnerDetail, /role="tab" aria-selected={detailTab === "priceChanges"}/);
  assert.match(partnerDetail, /priceChanges\.length > 0 \? priceChanges\.map/);
  assert.match(text, /itemsTab: "품목", priceChangesTab: "가격변동", priceChangesLoading: "가격변동 내역을 불러오는 중입니다\."/);
  assert.match(text, /priceChangesLoadFailed: "가격변동 내역을 불러오지 못했습니다\. 다시 시도해주세요\.", noPriceChanges: "최근 가격변동 내역이 없습니다\."/);
  assert.match(text, /itemsTab: "Mặt hàng", priceChangesTab: "Biến động giá", priceChangesLoading: "Đang tải lịch sử biến động giá\."/);
  assert.match(text, /priceChangesLoadFailed: "Không thể tải lịch sử biến động giá\. Vui lòng thử lại\.", noPriceChanges: "Không có biến động giá gần đây\."/);
});

test("detail-only slim form keeps 40px inputs and compact section/control spacing", () => {
  const keepingUi = read("components/bar/keeping/KeepingUi.tsx");
  const settlementFields = read("components/PartnerSettlementFields.tsx");
  assert.match(partnerForm, /const inputStyle = slim \? \{ \.\.\.keepingInputStyle, minHeight: 40, padding: "0 10px" \}/);
  assert.match(partnerForm, /compact={slim}/);
  assert.match(keepingUi, /gap:compact\?9:11/);
  assert.match(keepingUi, /minHeight:compact\?36:40/);
  assert.match(settlementFields, /gap: compact \? 8 : 10/);
});
