import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isResolvedLinkedCorrection, purchaseReviewState, shortBusinessDate, type PurchaseReviewRow } from "../lib/inventory/purchase-review.ts";

const synced = (id: number, code = "METADATA_SYNCED") => ({ inventory_log_id: id, status: "synced", code });
const linked = (statuses: PurchaseReviewRow["projectionStatuses"], extra: Partial<PurchaseReviewRow> = {}): PurchaseReviewRow =>
  ({ code: "linked_correction", logId: 20, projectionStatuses: statuses, projectionStatusUnavailable: false, ...extra });

test("normally processed linked corrections are hidden", () => {
  assert.equal(isResolvedLinkedCorrection(linked([synced(10, "PROJECTED"), synced(20)])), true);
  assert.equal(isResolvedLinkedCorrection(linked([synced(20, "PAID_BILLED_CORRECTED")])), true);
});

test("failed, pending, missing or unreadable status keeps the row visible with a plain state", () => {
  const cases: [PurchaseReviewRow, string][] = [
    [linked([synced(10), { inventory_log_id: 20, status: "failed", code: "X" }]), "error"],
    [linked([synced(10), { inventory_log_id: 20, status: "review_required", code: "X" }]), "review"],
    [linked([synced(10), { inventory_log_id: 20, status: "pending", code: "X" }]), "pending"],
    [linked([synced(10)]), "pending"], // own log has no status yet
    [linked([]), "pending"],
    [linked([synced(10), synced(20)], { projectionStatusUnavailable: true }), "unknown"],
  ];
  for (const [row, state] of cases) {
    assert.equal(isResolvedLinkedCorrection(row), false, state);
    assert.equal(purchaseReviewState(row), state);
  }
  for (const code of ["unlinked_nonpositive_purchase", "invalid_purchase_quantity", "invalid_correction_family"])
    assert.equal(purchaseReviewState({ code, logId: 1, projectionStatuses: [synced(1)] }), "review", code);
  assert.equal(purchaseReviewState({ code: "invalid_correction_family", logId: 1, projectionStatuses: [{ inventory_log_id: 1, status: "failed", code: "X" }] }), "error");
});

test("business date shows as MM.DD", () => {
  assert.equal(shortBusinessDate("2026-11-04"), "11.04");
  assert.equal(shortBusinessDate(null), "--.--");
});

test("panel: title, one line per row (date · name · state · 해결), no internal IDs or codes, opens the existing log detail", () => {
  const page = readFileSync("app/(protected)/inventory/snapshots/page.tsx", "utf8");
  const start = page.indexOf('data-testid="snapshot-purchase-review"');
  const panel = page.slice(start, page.indexOf("</section>", start));
  assert.ok(start > 0);
  assert.match(page, /reviewPurchaseDiagnostics = purchaseDiagnostics\.filter\(row => !isCompletedCancellation\(row\) && !isResolvedLinkedCorrection\(row\)\)/);
  assert.match(panel, /"Nhập hàng cần kiểm tra":"입고 확인 필요"/);
  assert.match(panel, /shortBusinessDate\(row\.log\.business_date\)/);
  assert.match(panel, /"Xử lý":"해결"/);
  assert.match(panel, /onClick=\{\(\)=>void fetchItemLogs\(mapLogToSnapshotItem\(row\.log\)\)\}/);
  assert.doesNotMatch(panel, /row\.logIds|status\.code|#\{row\.logId\}|row\.quantity|원입고 연결 정정|과거 기록을 자동 수정하지 않습니다/);
});
