import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const partnerForm = read("components/PartnerForm.tsx");
const partnerSettlementFields = read("components/PartnerSettlementFields.tsx");
const candidateForm = read("components/CandidatePartnerReviewForm.tsx");
const keepingUi = read("components/bar/keeping/KeepingUi.tsx");
const partnerStyles = read("app/(protected)/admin/partners/partners.module.css");
const adminPage = read("app/(protected)/admin/partners/page.tsx");
const partnerDetail = read("app/(protected)/admin/partners/[id]/page.tsx");
const candidatePage = read("app/(protected)/admin/partners/candidates/[id]/page.tsx");
const collectionApi = read("app/api/admin/partners/route.ts");
const detailApi = read("app/api/admin/partners/[id]/route.ts");
const text = read("lib/partners/text.ts");

// 1. PartnerForm 사용자 UI에 "장부 연동" section 없음
test("no user-facing partner form renders a Ledger-linking control", () => {
  assert.doesNotMatch(partnerForm, /장부 연동|Liên kết sổ sách|showLedgerParty|ledgerParties/);
  assert.doesNotMatch(adminPage, /장부 연동|ledgerParties/);
  assert.doesNotMatch(partnerDetail, /장부 연동|ledgerParties/);
  assert.doesNotMatch(candidateForm, /장부 연동|ledgerParties/);
  assert.doesNotMatch(candidatePage, /장부 연동|ledgerParties/);
});

// 2. ledgerPartyId backend compatibility field는 보존
test("ledgerPartyId stays a real field on the type and travels through create/update APIs unchanged", () => {
  assert.match(partnerForm, /ledgerPartyId: number \| null/);
  assert.match(collectionApi, /p_ledger_party_id: input\.ledgerPartyId/);
  assert.match(detailApi, /p_ledger_party_id: input\.ledgerPartyId/);
});

// 3. edit save 시 기존 ledgerPartyId를 의도치 않게 null 처리하지 않음
test("nothing in PartnerForm ever reassigns ledgerPartyId, so the initial value always round-trips to onSubmit", () => {
  // the only place ledgerPartyId is set is the useState initializer (initial ?? emptyValue);
  // no onChange handler ever calls setValue({ ...value, ledgerPartyId: ... })
  assert.doesNotMatch(partnerForm, /setValue\(\{[^}]*ledgerPartyId:/);
  assert.match(partnerForm, /useState<PartnerFormValue>\(initial \?\? emptyValue\)/);
  assert.match(partnerForm, /const ok = await onSubmit\(value\)/);
  // the edit page seeds `initial` straight from the API's existing bridge id
  assert.match(partnerDetail, /setPartner\(\{ \.\.\.body\.partner, ledgerPartyId: body\.partner\.ledgerParty\?\.id \?\? null \}\)/);
});

// 4. 신규 Partner ledgerPartyId=null
test("new partner and new candidate forms default ledgerPartyId to null", () => {
  assert.match(partnerForm, /emptyValue: PartnerFormValue = \{[^}]*ledgerPartyId: null/);
  assert.match(candidatePage, /ledgerPartyId: null/);
});

// 5. 기본 결제수단 UI 유지
test("default fund account selection is untouched by this pass and stays independent of the removed ledger UI", () => {
  assert.match(partnerSettlementFields, /fundAccounts: FundAccount\[\]/);
  assert.match(partnerSettlementFields, /t\.defaultFundAccount/);
  assert.match(partnerForm, /<PartnerSettlementFields lang={lang} value={value} fundAccounts={fundAccounts}/);
});

// 6. 사용 중/사용 안 함 -> isActive boolean 정확히 매핑
test("partner status is a two-way BarSegmentedControl mapped to the isActive boolean, shown only on edit", () => {
  assert.match(partnerForm, /value={value\.isActive \? "active" : "inactive"}/);
  assert.match(partnerForm, /onChange={next => setValue\(\{ \.\.\.value, isActive: next === "active" \}\)}/);
  assert.match(partnerForm, /options={\[\{ value: "active", label: t\.active \}, \{ value: "inactive", label: t\.inactive \}\]}/);
  assert.match(partnerForm, /showActive \? <div style=\{\{ display: "grid", gap: 5 \}\}>/);
  assert.doesNotMatch(partnerForm, /type="checkbox"/);
  // registration ("add") hides the status control; edit (default showActive) shows it
  assert.match(adminPage, /showActive={false}/);
  assert.doesNotMatch(partnerDetail, /showActive={false}/);
});

// 7. Candidate 신규등록 UI 계약 유지: 이름 -> 대분류 -> 결제방식 -> 기본 결제수단 -> 연락처 -> 메모, isActive는 true 고정
test("candidate create_partner form keeps its field order and fixed isActive=true", () => {
  const nameIdx = candidateForm.indexOf("t.name");
  const typeIdx = candidateForm.indexOf("t.type");
  const paymentIdx = candidateForm.indexOf("<PartnerSettlementFields");
  const contactIdx = candidateForm.indexOf("t.contact");
  const memoIdx = candidateForm.indexOf("labels.memo");
  assert.ok(nameIdx < typeIdx && typeIdx < paymentIdx && paymentIdx < contactIdx && contactIdx < memoIdx);
  assert.match(candidatePage, /paymentMode: "immediate", settlementMode: null, settlementRule: null, defaultPaymentTermDays: null, defaultFundAccountId: null/);
  assert.match(candidatePage, /isActive: true, ledgerPartyId: null/);
  assert.doesNotMatch(candidateForm, /isActive/);
});

// 8. KO/VI 모두 정상
test("the reworked status control and add-dialog labels are both localized", () => {
  assert.match(text, /status: "상태"/);
  assert.match(text, /status: "Trạng thái"/);
  assert.match(adminPage, /addTitle: "Thêm đối tác", close: "Đóng"/);
  assert.match(adminPage, /addTitle: "거래처 추가", close: "닫기"/);
  assert.match(partnerForm, /basic: "Thông tin cơ bản"/);
  assert.match(partnerForm, /basic: "기본 정보"/);
});

// modal chrome: BarSheet is reused, not a new library, and old <details> scaffolding is gone
test("the add-partner dialog is built entirely from the existing BarSheet component", () => {
  assert.match(adminPage, /import \{ BarSheet \} from "@\/components\/bar\/keeping\/KeepingUi"/);
  assert.doesNotMatch(adminPage, /<details|<summary/);
  assert.match(keepingUi, /export function BarSheet/);
  // Escape / backdrop click-to-close / body scroll lock / focus management live once, in BarSheet
  assert.match(keepingUi, /event\.key==="Escape"&&!saving/);
  assert.match(keepingUi, /document\.body\.style\.overflow="hidden"/);
  assert.match(keepingUi, /onMouseDown=\{event=>\{if\(event\.target===event\.currentTarget&&!saving\)onClose\(\)\}\}/);
  assert.doesNotMatch(partnerStyles, /position:fixed;inset:0;z-index:1399/);
});

// the modal's own footer button submits the form living in BarSheet's scrollable body via the
// native form= attribute, and mirrors PartnerForm's internal saving state so the dialog can't
// be dismissed mid-save
test("the add dialog's footer save button is wired to PartnerForm's form id and lifted saving state", () => {
  assert.match(partnerForm, /formId\?: string/);
  assert.match(partnerForm, /onSavingChange\?: \(saving: boolean\) => void/);
  assert.match(partnerForm, /<form id={formId} onSubmit={submit}>/);
  assert.match(adminPage, /const ADD_FORM_ID = "partner-add-form"/);
  assert.match(adminPage, /<PartnerForm formId={ADD_FORM_ID}/);
  assert.match(adminPage, /footer={<button type="submit" form={ADD_FORM_ID}/);
  assert.match(adminPage, /saving={addSaving}/);
});
