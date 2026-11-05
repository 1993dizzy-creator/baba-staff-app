import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { formatPartnerPolicySummary, formatPartnerSettlementTerm } from "../lib/partners/text.ts";

const read = (path: string) => readFileSync(path, "utf8");
const postpaid = (settlementRule: string | null, settlementDays: number[] | null = null, extra: Record<string, unknown> = {}) =>
  ({ paymentMode: "postpaid", settlementMode: settlementRule ? "scheduled" : null, settlementRule, settlementDays, defaultPaymentTermDays: null, ...extra });

test("P0-2 examples: Phương monthly 15/end, Ok Mart weekly Tuesday, immediate partner", () => {
  assert.equal(formatPartnerPolicySummary({ ...postpaid("monthly_twice", [15, 0]), defaultFundAccountCode: "baba_corporate_bank" }, "ko"), "후불 · 매월 15일·말일 정산 · 법인 기본");
  assert.equal(formatPartnerPolicySummary({ ...postpaid("weekly", [2]), defaultFundAccountCode: "baba_corporate_bank" }, "ko"), "후불 · 매주 화요일 지급 기준 · 법인 기본");
  assert.equal(formatPartnerPolicySummary({ paymentMode: "immediate", defaultFundAccountCode: "baba_corporate_bank" }, "ko"), "선불/즉시 성향 · 법인 기본");
  assert.equal(formatPartnerPolicySummary({ ...postpaid("monthly_twice", [15, 0]), defaultFundAccountCode: "baba_corporate_bank" }, "vi"), "Trả sau · Chốt ngày 15 và cuối tháng hằng tháng · Mặc định: Công ty");
  assert.equal(formatPartnerPolicySummary({ ...postpaid("weekly", [2]), defaultFundAccountCode: null }, "vi"), "Trả sau · Thứ Ba hằng tuần (mốc thanh toán) · Chưa chọn tài khoản");
});

test("month end 0 is shown as 말일 after numbered days regardless of stored order", () => {
  assert.equal(formatPartnerSettlementTerm(postpaid("monthly_twice", [0, 15]), "ko"), "매월 15일·말일 정산");
  assert.equal(formatPartnerSettlementTerm(postpaid("monthly_once", [0]), "ko"), "매월 말일 정산");
  assert.equal(formatPartnerSettlementTerm(postpaid("monthly_once", [25]), "ko"), "매월 25일 정산");
});

test("unspecified, ad hoc, net days and incomplete policies never invent dates", () => {
  assert.equal(formatPartnerPolicySummary({ paymentMode: "unspecified", defaultFundAccountCode: null }, "ko"), "결제방식 미지정 · 계좌 미지정");
  assert.equal(formatPartnerSettlementTerm({ paymentMode: "immediate" }, "ko"), null);
  assert.equal(formatPartnerSettlementTerm({ paymentMode: "postpaid", settlementMode: "ad_hoc" }, "ko"), "비정기 정산");
  assert.equal(formatPartnerSettlementTerm(postpaid(null), "ko"), "정산주기 미지정");
  assert.equal(formatPartnerSettlementTerm(postpaid("net_days", null, { defaultPaymentTermDays: 7 }), "ko"), "매입 후 7일 지급");
  assert.equal(formatPartnerSettlementTerm(postpaid("monthly_twice", null), "ko"), "월 2회 정산(날짜 미지정)");
  assert.equal(formatPartnerSettlementTerm(postpaid("weekly", []), "ko"), "주간 정산(요일 미지정)");
});

test("settings form explains suggestion-only semantics and keeps unset fund account savable", () => {
  const fields = read("components/PartnerSettlementFields.tsx");
  assert.match(fields, /입고 전 선결제나 지급 완료를 뜻하지 않습니다/);
  assert.match(fields, /실제 지급일·연체 확정일과 다를 수 있습니다/);
  assert.match(fields, /추천 기본 계좌입니다\. 실제 지급이나 자동 출금을 확정하지 않습니다/);
  assert.match(fields, /설정 저장은 과거 거래와 기존 미지급금 지급기한을 바꾸지 않습니다/);
  assert.match(fields, /value\.defaultFundAccountId === null \? labels\.fundUnset : labels\.fundHelp/);
  assert.doesNotMatch(fields, /required[^>]*defaultFundAccountId/);
  // Selected option is marked by text as well as color.
  assert.match(fields, /option\.value === value \? `✓ \$\{option\.label\}` : option\.label/);
  // Live summary reflects the current (unsaved) value.
  assert.match(fields, /formatPartnerPolicySummary\(\{ \.\.\.value, defaultFundAccountCode: fundAccountCode \}, lang\)/);
});

test("detail form remounts from the reloaded policy after save", () => {
  const page = read("app/(protected)/admin/partners/[id]/page.tsx");
  assert.match(page, /await load\(\); alert\(t\.saved\)/);
  assert.match(page, /partner\.settlementRule\}-\$\{\(partner\.settlementDays \?\? \[\]\)\.join\(","\)\}/);
});

test("partner list row shows the policy summary on a wrapping line and keeps item counts", () => {
  const panel = read("components/partners/PartnerSettingsPanel.tsx");
  const styles = read("app/(protected)/admin/partners/partners.module.css");
  const row = panel.slice(panel.indexOf("function PartnerRow"), panel.indexOf("function CandidateRow"));
  assert.match(row, /formatPartnerPolicySummary\(partner, lang\)/);
  assert.match(row, /formatInventoryItemCount\(partner\.inventoryCount, partner\.activeInventoryCount, lang\)/);
  assert.match(styles, /\.partnerPolicy\{[^}]*overflow-wrap:anywhere/);
});
