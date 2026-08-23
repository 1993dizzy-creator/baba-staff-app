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
test("partner name and classification live inside the top identity card (Candidate structure), not a bare header", () => {
  assert.match(partnerDetail, /<BarSection title={identityTitle} icon="📎" first>/);
  assert.match(partnerDetail, /<div className={styles\.candidateIdentity}>/);
  assert.match(partnerDetail, /<div className={styles\.candidateIdentityName}>/);
  assert.match(partnerDetail, /<span className={styles\.groupBadge}>{partnerTypeLabels\[partner\.partnerType\]\[lang\]}<\/span>/);
  assert.match(partnerDetail, /<strong>{partner\.name}<\/strong>/);
  assert.match(partnerDetail, /<span className={styles\.badge}>{partner\.isActive \? t\.active : t\.inactive}<\/span>/);
});

// 21: supply items are inside the top identity BarSection, in a bounded scroll list
test("supply items render inside the identity section as a bounded compact scroll list, reusing candidateItems", () => {
  const identityBody = partnerDetail.slice(partnerDetail.indexOf('title={identityTitle} icon="📎" first>'), partnerDetail.indexOf("</BarSection>"));
  assert.match(identityBody, /className={styles\.candidateItems}/);
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
  assert.match(partnerDetail, /<PartnerForm key={`\${partner\.id}-\${partner\.name}-\${partner\.isActive}`} lang={lang} initial={partner} fundAccounts={fundAccounts} partnerSubtypes={partnerSubtypes} first={false} onSubmit={update} \/>/);
  assert.match(partnerForm, /first\?: boolean/);
  assert.match(partnerForm, /first = true/);
  assert.match(partnerForm, /<BarSection title={sectionLabels\.basic} icon="📌" first={first}>/);
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
