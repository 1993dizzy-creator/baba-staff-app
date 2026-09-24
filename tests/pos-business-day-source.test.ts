import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
// @ts-expect-error Node's direct TypeScript tests require explicit extensions.
import { buildPosBusinessDaySource, buildPosLedgerRangeSource, canonicalPosJson, posSourceFingerprint, validPosBusinessDate } from "../lib/ledger/pos-sales-source.ts";
// @ts-expect-error Node's direct TypeScript tests require explicit extensions.
import { comparePosClosedSource, evaluatePosCloseTime, evaluatePosManualCloseTime, validatePosSystemActor } from "../lib/sales/pos-business-day-close-policy.ts";
// @ts-expect-error Node's direct TypeScript tests require explicit extensions.
import { createFallbackBusinessTimeSnapshot } from "../lib/store-settings/business-time-adapter-core.ts";

const date = "2026-08-20";
const receipt = { id: 1, ref_no: "A", business_date: date, ref_date: null, payment_status: 3, is_canceled: false, final_amount: 100_000, revision: 1, updated_at: null };
const payment = { id: 1, receipt_id: 1, business_date: date, payment_type: 1, payment_name: "tiền mặt", card_name: null, amount: 100_000 };

test("canonical day source matches final amounts, preserves all four buckets, and excludes canceled/unpaid receipts", () => {
  const source = buildPosBusinessDaySource(date, [receipt, { ...receipt, id: 2, is_canceled: true }, { ...receipt, id: 3, payment_status: 2 }],
    [payment, { ...payment, id: 2, receipt_id: 2 }, { ...payment, id: 3, receipt_id: 3 }]);
  assert.equal(source.receiptCount, 1);
  assert.equal(source.receiptTotal, 100_000);
  assert.equal(source.paymentTotal, 100_000);
  assert.deepEqual(source.rows.map(row => [row.bucket, row.amount]), [["cash", 100_000], ["transfer", 0], ["card", 0], ["other", 0]]);
  assert.equal(source.sourceFingerprint.length, 64);
});

test("day and month builders preserve August legacy snapshot order and SHA256 bucket fingerprints", () => {
  const day = buildPosBusinessDaySource(date, [receipt], [payment]);
  const month = buildPosLedgerRangeSource([date, "2026-08-21"], [receipt], [payment]);
  const legacy = { businessDate: date, bucket: "cash", receiptCount: 1, payments: [{
    paymentId: 1, receiptId: 1, refNo: "A", refDate: null, paymentMethod: "tiền mặt",
    paymentAmount: 100_000, receiptFinalAmount: 100_000, receiptRevision: 1, receiptUpdatedAt: null,
  }] };
  assert.deepEqual(day.rows[0].snapshot, legacy);
  assert.equal(day.rows[0].fingerprint, createHash("sha256").update(JSON.stringify(legacy)).digest("hex"));
  assert.deepEqual(month.rows.slice(0, 4), day.rows);
  assert.deepEqual(month.days[0], day);
  assert.equal(month.salesSummary.paymentTotalAmount, 100_000);
});

test("fingerprints ignore object insertion order and input row order but detect source drift", () => {
  const a = { a: 1, b: { z: 2, x: [3, 4] } };
  const b = { b: { x: [3, 4], z: 2 }, a: 1 };
  assert.equal(canonicalPosJson(a), canonicalPosJson(b));
  assert.equal(posSourceFingerprint(a), posSourceFingerprint(b));
  const otherReceipt = { ...receipt, id: 2 };
  const otherPayment = { ...payment, id: 2, receipt_id: 2 };
  const ordered = buildPosBusinessDaySource(date, [receipt, otherReceipt], [payment, otherPayment]);
  const shuffled = buildPosBusinessDaySource(date, [otherReceipt, receipt], [otherPayment, payment]);
  assert.equal(ordered.sourceFingerprint, shuffled.sourceFingerprint);
  assert.notEqual(buildPosBusinessDaySource(date, [receipt], [payment]).sourceFingerprint,
    buildPosBusinessDaySource(date, [{ ...receipt, revision: 2 }], [payment]).sourceFingerprint);
});

test("payment mismatch, unknown allocation and incomplete or malformed financial sources fail closed", () => {
  assert.throws(() => buildPosBusinessDaySource(date, [receipt], [{ ...payment, amount: 90_000 }]), /RECONCILIATION_MISMATCH/);
  assert.throws(() => buildPosBusinessDaySource(date, [receipt], [{ ...payment, payment_name: "unknown" }]), /BUCKET_ALLOCATION_MISMATCH/);
  assert.throws(() => buildPosBusinessDaySource(date, [receipt], []), /RECONCILIATION_MISMATCH/);
  for (const value of [null, "bad", -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => buildPosBusinessDaySource(date, [{ ...receipt, final_amount: value }], [payment]), /POS_SOURCE_/);
  }
  assert.throws(() => canonicalPosJson({ missing: undefined }), /SNAPSHOT_INCOMPLETE/);
  // @ts-expect-error Simulate an incomplete source response missing eligibility.
  assert.throws(() => buildPosBusinessDaySource(date, [{ ...receipt, payment_status: undefined }], [payment]), /SNAPSHOT_INCOMPLETE/);
  assert.throws(() => buildPosBusinessDaySource(date, [receipt], [payment, payment]), /SNAPSHOT_INCOMPLETE/);
  assert.throws(() => buildPosLedgerRangeSource([date, "2026-08-21"], [receipt], [{ ...payment, business_date: "2026-08-21" }]), /DATE_MISMATCH/);
  assert.equal(validPosBusinessDate("2026-02-30"), false);
});

test("empty days and zero-final receipts retain a complete canonical close source", () => {
  const empty = buildPosBusinessDaySource(date, [], []);
  const free = buildPosBusinessDaySource(date, [{ ...receipt, final_amount: 0 }], []);
  assert.equal(empty.receiptTotal, 0);
  assert.equal(free.receiptCount, 1);
  assert.notEqual(empty.sourceFingerprint, free.sourceFingerprint);
  assert.ok(empty.rows.every(row => row.amount === 0));
});

test("closed-source comparison reports total and bucket deltas including allocation-only drift", () => {
  const closed = buildPosBusinessDaySource(date, [receipt], [payment]);
  const changed = buildPosBusinessDaySource(date, [receipt], [{ ...payment, payment_name: "chuyển khoản" }]);
  assert.deepEqual(comparePosClosedSource(changed, closed.sourceSnapshot, closed.sourceFingerprint), {
    isClosed: true, drift: true, totalDelta: 0, bucketDeltas: { cash: -100_000, transfer: 100_000, card: 0, other: 0 },
  });
  assert.equal(comparePosClosedSource(closed, null, null).isClosed, false);
  assert.throws(() => comparePosClosedSource(closed, {}, closed.sourceFingerprint), /SNAPSHOT_INCOMPLETE/);
});

test("system actor is resolved by username and fails closed on disabled, inactive or non-owner/master accounts", () => {
  const actor = { id: 789, username: "pos", role: "master", is_active: true, app_login_enabled: true };
  assert.equal(validatePosSystemActor(actor).id, 789);
  for (const invalid of [null, { ...actor, username: "other" }, { ...actor, is_active: false },
    { ...actor, app_login_enabled: false }, { ...actor, role: "manager" }, { ...actor, id: 0 }]) {
    assert.throws(() => validatePosSystemActor(invalid), /SYSTEM_ACTOR_UNAVAILABLE/);
  }
});

test("configured overnight close permits past dates or closeAt and rejects early close, future dates and unknown current hours", () => {
  const fallback = createFallbackBusinessTimeSnapshot(date);
  const snapshot = { ...fallback, source: "configured" as const, isFallback: false,
    hours: fallback.hours.map(hour => ({ ...hour, isClosed: false, openTime: "16:00", closeTime: "01:00" })) };
  assert.equal(evaluatePosCloseTime(date, date, new Date("2026-08-20T23:59:00+07:00"), snapshot).allowed, false);
  assert.equal(evaluatePosCloseTime(date, date, new Date("2026-08-21T00:59:59+07:00"), snapshot).allowed, false);
  assert.equal(evaluatePosCloseTime(date, date, new Date("2026-08-21T01:00:00+07:00"), snapshot).allowed, true);
  assert.equal(evaluatePosCloseTime(date, "2026-08-21", new Date("2026-08-21T05:00:00+07:00"), snapshot).allowed, true);
  assert.equal(evaluatePosCloseTime("2026-08-21", date, new Date("2026-08-21T01:00:00+07:00"), snapshot).allowed, false);
  assert.equal(evaluatePosCloseTime(date, date, new Date("2026-08-21T02:00:00+07:00"), fallback).allowed, false);
});

test("manual close starts at 23:00 for the current business date without changing configured close or cutoff", () => {
  const fallback = createFallbackBusinessTimeSnapshot(date);
  const snapshot = { ...fallback, source: "configured" as const, isFallback: false,
    hours: fallback.hours.map(hour => ({ ...hour, isClosed: false, openTime: "16:00", closeTime: "01:00" })) };
  const configured = evaluatePosCloseTime(date, date, new Date("2026-08-20T23:00:00+07:00"), snapshot);
  const before = evaluatePosManualCloseTime(date, date, new Date("2026-08-20T22:59:59+07:00"), snapshot);
  const at = evaluatePosManualCloseTime(date, date, new Date("2026-08-20T23:00:00+07:00"), snapshot);
  assert.equal(before.allowed, false);
  assert.equal(at.allowed, true);
  assert.equal(evaluatePosManualCloseTime(date, date, new Date("2026-08-20T23:30:00+07:00"), snapshot).allowed, true);
  assert.equal(evaluatePosManualCloseTime(date, date, new Date("2026-08-21T00:30:00+07:00"), snapshot).allowed, true);
  assert.equal(evaluatePosManualCloseTime(date, "2026-08-21", new Date("2026-08-21T00:30:00+07:00"), snapshot).allowed, true);
  assert.equal(evaluatePosManualCloseTime("2026-08-21", date, new Date("2026-08-20T23:30:00+07:00"), snapshot).allowed, false);
  assert.equal(configured.allowed, false);
  assert.equal(at.closeAt, configured.closeAt);
  assert.equal(at.cutoffAt, configured.cutoffAt);
});
