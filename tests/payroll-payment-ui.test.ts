import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
// @ts-expect-error Node test execution requires explicit TypeScript extensions.
import { getPaymentBadgePresentation, shouldShowPaymentDifferenceReason } from "../lib/payroll/ui-labels.ts";

const card = readFileSync(join(process.cwd(), "components/payroll/CompensationCard.tsx"), "utf8");
const modal = readFileSync(join(process.cwd(), "components/payroll/PayrollModal.tsx"), "utf8");

test("payment badges distinguish normal and adjusted payments in both directions", () => {
  assert.deepEqual(getPaymentBadgePresentation("ko", 0), { adjusted: false, label: "지급완료" });
  assert.deepEqual(getPaymentBadgePresentation("ko", 1), { adjusted: true, label: "조정지급" });
  assert.deepEqual(getPaymentBadgePresentation("ko", -1), { adjusted: true, label: "조정지급" });
  assert.deepEqual(getPaymentBadgePresentation("vi", 0), { adjusted: false, label: "Đã trả" });
  assert.deepEqual(getPaymentBadgePresentation("vi", 1), { adjusted: true, label: "Trả điều chỉnh" });
});

test("adjusted payment badge uses amber while the normal badge stays green", () => {
  assert.match(card, /paymentBadge:[^\n]+background:"#dcfce7"[^\n]+color:"#166534"/);
  assert.match(card, /adjustedPaymentBadge: \{ background:"#fef3c7", color:"#92400e" \}/);
  assert.match(card, /paymentBadge\.adjusted \? s\.adjustedPaymentBadge/);
});

test("paid details use aligned common sections, cards, and rows", () => {
  assert.match(card, /function PaidPaymentDetails/);
  assert.match(card, /function PaymentSalarySummary/);
  assert.match(card, /function PaymentSection/);
  assert.match(card, /function PaymentCard/);
  assert.match(card, /function PaymentKeyValue/);
  for (const heading of ["💰", "💳", "📝", "🕒", "급여 정보", "지급 결과", "처리 정보"]) {
    assert.ok(card.includes(heading), heading);
  }
  assert.match(card, /paymentCard:[^\n]+width:"100%"[^\n]+boxSizing:"border-box"[^\n]+gap:9[^\n]+padding:12/);
  assert.match(card, /paymentKeyValue:[^\n]+minHeight:28[^\n]+gridTemplateColumns:"minmax\(90px, 1fr\) minmax\(0, auto\)"[^\n]+alignItems:"center"/);
});

test("paid and unpaid views share the summary and section/card system", () => {
  assert.match(card, /<PaymentSalarySummary[\s\S]+payment\?\.payment_status === "paid" \? \(/);
  assert.match(card, /function PaidPaymentDetails[\s\S]+<PaymentSection[\s\S]+<PaymentCard>/);
  assert.match(card, /function UnpaidPaymentForm[\s\S]+<PaymentSection[\s\S]+<PaymentCard>/);
  assert.doesNotMatch(card, /paymentSummary:|paidPaymentLayout|paymentResultCard|paymentInfoCard/);
});

test("long reasons, employee names, and actor names wrap without widening the modal", () => {
  assert.match(card, /paymentReasonText:[^\n]+whiteSpace:"normal"[^\n]+overflowWrap:"anywhere"/);
  assert.match(card, /employeeName} wrap/);
  assert.match(card, /actorLabel} wrap/);
  assert.match(card, /paymentValueWrap:[^\n]+whiteSpace:"normal"[^\n]+overflowWrap:"anywhere"/);
  assert.doesNotMatch(card, /difference_reason&&<Row/);
});

test("payment reason visibility follows only the non-zero difference", () => {
  assert.equal(shouldShowPaymentDifferenceReason(0), false);
  assert.equal(shouldShowPaymentDifferenceReason(1), true);
  assert.equal(shouldShowPaymentDifferenceReason(-1), true);
  assert.match(card, /shouldShowPaymentDifferenceReason\(difference\) \? \(/);
});

test("payment fields share card-aligned sizing at mobile widths", () => {
  assert.match(card, /paymentLayout:[^\n]+width:"100%"[^\n]+maxWidth:"100%"[^\n]+minWidth:0[^\n]+gap:13[^\n]+overflow:"hidden"/);
  assert.match(card, /paymentInput:[^\n]+width:"100%"[^\n]+maxWidth:"100%"[^\n]+minWidth:0[^\n]+boxSizing:"border-box"/);
  assert.match(card, /paymentField:[^\n]+minWidth:0[^\n]+gap:7/);
});

test("modal constrains its content width without changing payment and cancellation flows", () => {
  assert.match(modal, /sheet:\{[^\n]+minWidth:0[^\n]+boxSizing:"border-box"/);
  assert.match(modal, /body:\{[^\n]+maxWidth:"100%"[^\n]+overflowX:"hidden"/);
  assert.match(card, /method:"POST"[\s\S]+actualPaidAmount:actualNumber[\s\S]+differenceReason:reason/);
  assert.match(card, /method:"PATCH"[\s\S]+runId:employee\.batchId[\s\S]+reason:cancelReason/);
  assert.match(card, /background: "#b91c1c"/);
});
