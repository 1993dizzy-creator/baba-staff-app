import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
// @ts-expect-error Node strips TypeScript extensions in tests.
import { formatPartnerFundAccount, formatPartnerPaymentMode, formatPartnerPaymentSummary } from "../lib/partners/text.ts";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const infoPage = read("app/(protected)/admin/partners/info/page.tsx");
const partnerServer = read("lib/partners/server.ts");
const settlementFields = read("components/PartnerSettlementFields.tsx");
const partnerForm = read("components/PartnerForm.tsx");
const candidateForm = read("components/CandidatePartnerReviewForm.tsx");
const text = read("lib/partners/text.ts");

// A1/A8: top spacing + Container usage
test("info page uses noPaddingTop like the registration/candidate pages, no page-local negative margins", () => {
  assert.match(infoPage, /<Container noPaddingTop>/);
  assert.doesNotMatch(infoPage, /margin-?[Tt]op:\s*-|marginTop:\s*-/);
});

// A2-A5: row summary format "[fund](mode)"
test("info row summary is [fund account compact](payment mode compact) with no item count baked in", () => {
  assert.equal(formatPartnerPaymentSummary({ paymentMode: "postpaid", defaultFundAccountCode: "cho_personal_custody" }, "ko"), "개인(후불)");
  assert.equal(formatPartnerPaymentSummary({ paymentMode: "immediate", defaultFundAccountCode: "baba_corporate_bank" }, "ko"), "법인(선불)");
  assert.equal(formatPartnerPaymentSummary({ paymentMode: "immediate", defaultFundAccountCode: "store_cash" }, "ko"), "현금(선불)");
  assert.equal(formatPartnerPaymentSummary({ paymentMode: "postpaid", defaultFundAccountCode: null }, "ko"), "미지정(후불)");
  assert.equal(formatPartnerPaymentSummary({ paymentMode: "immediate", defaultFundAccountCode: "cho_personal_custody" }, "vi"), "Cá nhân(Trước)");
});

// A5: safe fallback for a future/unknown ledger_fund_accounts.code, never id-hardcoded
test("unknown future fund account codes fall back safely instead of crashing or hardcoding an id", () => {
  assert.equal(formatPartnerFundAccount("future_prepaid_wallet", "ko", "compact"), "기타");
  assert.equal(formatPartnerFundAccount("future_prepaid_wallet", "ko", "full"), "기타 계정");
  assert.equal(formatPartnerFundAccount("future_prepaid_wallet", "vi", "compact"), "Khác");
  assert.doesNotMatch(text, /=== 1|=== 2|=== 3|fundAccountId === /);
});

// A6/A7: tag badge next to the name, absent when no tag
test("info row shows a tag badge next to the name only when displayTag is set", () => {
  assert.match(infoPage, /<span className={styles\.rowNameGroup}>/);
  assert.match(infoPage, /partner\.displayTag \? <span className={styles\.tagBadge}>{partner\.displayTag}<\/span> : null/);
});

// A8: 390px overflow-safe structure (ellipsis name, non-shrinking tag)
test("row name/tag group is overflow-safe: flex + min-width:0 wrapper, name ellipsis, tag never shrinks", () => {
  const styles = read("app/(protected)/admin/partners/partners.module.css");
  assert.match(styles, /\.rowNameGroup\{display:flex;min-width:0/);
  assert.match(styles, /\.rowName\{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap/);
  assert.match(styles, /\.tagBadge\{display:block;flex-shrink:0;max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap/);
  assert.match(styles, /@media\(max-width:640px\)\{[\s\S]*\.tagBadge\{max-width:68px/);
});

// B9: fund account renders before payment mode in the shared control
test("fund account select renders before the payment mode segmented control", () => {
  const fundIdx = settlementFields.indexOf("t.defaultFundAccount");
  const modeIdx = settlementFields.indexOf("PolicySegmentedField label={t.paymentMode}");
  assert.ok(fundIdx >= 0 && modeIdx >= 0 && fundIdx < modeIdx);
});

// B10/B11/B12/B13: backend value unchanged, KO/VI full+compact labels
test("payment_mode backend values are untouched; only the user-facing label text changed", () => {
  assert.match(read("lib/partners/policy.ts"), /PAYMENT_MODES = \["immediate", "postpaid"\] as const/);
  assert.equal(formatPartnerPaymentMode("immediate", "ko"), "선불결제");
  assert.equal(formatPartnerPaymentMode("immediate", "ko", "compact"), "선불");
  assert.equal(formatPartnerPaymentMode("postpaid", "ko"), "후불결제");
  assert.equal(formatPartnerPaymentMode("postpaid", "ko", "compact"), "후불");
  assert.equal(formatPartnerPaymentMode("immediate", "vi"), "Thanh toán trước");
  assert.equal(formatPartnerPaymentMode("postpaid", "vi"), "Thanh toán sau");
  assert.doesNotMatch(text, /즉시결제|Thanh toán ngay/);
});

// B14/B15/B16: fund account display names, DB display_name column untouched
test("Partner-facing fund account labels are simplified and independent of ledger_fund_accounts.display_name", () => {
  assert.equal(formatPartnerFundAccount("cho_personal_custody", "ko", "full"), "개인계좌");
  assert.equal(formatPartnerFundAccount("baba_corporate_bank", "ko", "full"), "법인계좌");
  assert.equal(formatPartnerFundAccount("store_cash", "ko", "full"), "현금");
  assert.equal(formatPartnerFundAccount("cho_personal_custody", "vi", "full"), "Tài khoản cá nhân");
  assert.equal(formatPartnerFundAccount(null, "ko"), "미지정");
  // the raw Ledger display_name values must not leak into the label object itself (a code
  // comment may still reference them for documentation, so scope the check to the literal)
  const labelsLiteral = text.slice(text.indexOf("const FUND_ACCOUNT_LABELS"), text.indexOf("const FUND_ACCOUNT_UNSET"));
  assert.doesNotMatch(labelsLiteral, /BABA 소유분|Cho 개인계좌|BABA 법인계좌|매장 현금/);
  const ledgerMigration = read("supabase/migrations/202608210001_create_ledger_v1_foundation.sql");
  assert.match(ledgerMigration, /'cho_personal_custody','personal_custody','Cho','Cho 개인계좌 \(BABA 소유분\)'/);
});

test("dropdown uses the formatter (code-based), not the raw ledger_fund_accounts.display_name", () => {
  assert.doesNotMatch(settlementFields, /account\.displayName/);
  assert.match(settlementFields, /formatPartnerFundAccount\(account\.code, lang, "full"\)/);
});

// item 4: FundAccount API additive `code`, fetched once (no N+1)
test("FundAccount type and server response carry code additively, from the existing single fetch", () => {
  assert.match(partnerForm, /export type FundAccount = \{ id: number; code: string; displayName: string; type: string \}/);
  assert.match(partnerServer, /select\("id,code,type,display_name,is_active,is_business_fund,sort_order"\)/);
  assert.match(partnerServer, /fundAccounts: \(fundAccountResult\.data \?\? \[\]\)\.map\(row => \(\{ id: Number\(row\.id\), code: row\.code, displayName: row\.display_name, type: row\.type \}\)\)/);
  assert.doesNotMatch(partnerServer, /for \([^)]*\)[\s\S]{0,200}await supabaseServer/);
});

test("defaultFundAccountCode is resolved server-side from the id, in-memory, no extra query", () => {
  assert.match(partnerServer, /fundAccountCodeById = new Map/);
  assert.match(partnerServer, /defaultFundAccountCode: defaultFundAccountId === null \? null : fundAccountCodeById\.get\(defaultFundAccountId\) \?\? null/);
});

// B17: Candidate form uses the same order/labels via the same shared PartnerSettlementFields
test("Candidate create_partner form shares the exact same payment control as PartnerForm", () => {
  assert.match(candidateForm, /<PartnerSettlementFields lang={lang} value={value} fundAccounts={fundAccounts}/);
  assert.match(partnerForm, /<PartnerSettlementFields lang={lang} value={value} fundAccounts={fundAccounts}/);
});
