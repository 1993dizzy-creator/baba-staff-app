import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  getPendingPaymentSince,
  isPendingPaymentReviewDue,
  parsePendingResolutionBody,
  selectPendingCloseHoldDates,
// @ts-expect-error Direct Node TypeScript tests require explicit extensions.
} from "../lib/sales/pos-pending-payment-policy.ts";

const now = new Date("2026-10-20T16:00:00.000Z");
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();
const pending = (extra: Record<string, unknown> = {}) => ({ paymentStatus: 1, isCanceled: false, ...extra });

test("30-minute review badge: 29 min no, 30 min yes; canceled/paid never", () => {
  assert.equal(isPendingPaymentReviewDue(pending({ refDate: minutesAgo(29) }), now), false);
  assert.equal(isPendingPaymentReviewDue(pending({ refDate: minutesAgo(30) }), now), true);
  assert.equal(isPendingPaymentReviewDue(pending({ refDate: minutesAgo(90), isCanceled: true }), now), false);
  assert.equal(isPendingPaymentReviewDue({ paymentStatus: 3, isCanceled: false, refDate: minutesAgo(90) }, now), false);
});

test("status_changed_at wins over ref_date; unknown start is never due (same as the DB function)", () => {
  const receipt = pending({ refDate: minutesAgo(120), statusChangedAt: minutesAgo(10) });
  assert.equal(getPendingPaymentSince(receipt), receipt.statusChangedAt);
  assert.equal(isPendingPaymentReviewDue(receipt, now), false);
  assert.equal(isPendingPaymentReviewDue(pending({ refDate: null, statusChangedAt: null }), now), false);
});

test("hold dates: recorded pending holds without a closure, oldest first, de-duplicated", () => {
  assert.deepEqual(
    selectPendingCloseHoldDates(["2026-10-21", "2026-10-17", "2026-10-21", "2026-10-20"], ["2026-10-20"]),
    ["2026-10-17", "2026-10-21"]
  );
  assert.deepEqual(selectPendingCloseHoldDates([], []), []);
});

test("resolution body: evidence, method and request id are mandatory; cancel carries no payment", () => {
  const base = { evidenceNote: "Card slip 001234", expectedRevision: 0, requestId: "3f1c2a7e-8b4d-4c1e-9a2b-0c3d4e5f6a7b" };
  assert.deepEqual(parsePendingResolutionBody({ ...base, resolution: "paid", paymentMethod: "card" }), {
    ...base, resolution: "paid", paymentMethod: "card", cashReceivedAmount: null,
  });
  assert.equal(parsePendingResolutionBody({ ...base, resolution: "paid" }), null);
  assert.equal(parsePendingResolutionBody({ ...base, resolution: "paid", paymentMethod: "split" }), null);
  assert.equal(parsePendingResolutionBody({ ...base, resolution: "paid", paymentMethod: "cash" }), null);
  assert.equal(parsePendingResolutionBody({ ...base, resolution: "paid", paymentMethod: "cash", cashReceivedAmount: 1.5 }), null);
  assert.equal(parsePendingResolutionBody({ ...base, evidenceNote: "ok", resolution: "canceled" }), null);
  assert.equal(parsePendingResolutionBody({ ...base, resolution: "canceled", paymentMethod: "cash" }), null);
  assert.equal(parsePendingResolutionBody({ ...base, requestId: "x", resolution: "canceled" }), null);
  assert.equal(parsePendingResolutionBody({ ...base, resolution: "canceled" })?.paymentMethod, null);
});

test("wiring: sync cannot revert an admin resolution; close view and default date use the hold", () => {
  const sync = readFileSync("lib/pos/cukcuk/sales-receipt-sync.ts", "utf8");
  assert.match(sync, /getAdminResolvedPendingReceiptIds\(/);
  assert.match(sync, /\.or\("is_modified\.is\.null,is_modified\.eq\.false"\);\s*\n\s*\n\s*if \(error\) \{\s*throw new Error\(`Failed to update sales receipt/);
  const view = readFileSync("lib/sales/pos-business-day-final.ts", "utf8");
  assert.match(view, /canClose:writable&&time\.allowed&&!month\.data&&!closure&&Boolean\(source\)&&pending\.count===0/);
  const today = readFileSync("app/api/admin/sales/today/route.ts", "utf8");
  assert.match(today, /explicitBusinessDate\s*\?\s*resolved\.businessDate\s*:\s*\(await findOldestPendingCloseHoldDate\(resolved\.businessDate\)\)\s*\?\?\s*resolved\.businessDate/);
  const route = readFileSync("app/api/admin/sales/receipts/[id]/payment-status/route.ts", "utf8");
  assert.match(route, /requireRole\(\["owner", "master", "manager"\]\)/);
  assert.match(route, /p_actor_username: auth\.actor\.username/);
});
