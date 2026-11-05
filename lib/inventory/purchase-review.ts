// Presentation rules for the /inventory/snapshots "입고 확인 필요" panel. Display only:
// the diagnostics, inventory logs, ledger statuses and audit history are never changed.

export type PurchaseReviewRow = {
  code: string;
  logId: number;
  projectionStatuses?: ReadonlyArray<{ inventory_log_id: number; status: string; code: string }>;
  projectionStatusUnavailable?: boolean;
};

// A linked receipt edit whose stock and ledger processing finished normally (status read,
// its own log present, every read status synced) needs no review. A failed or missing
// status read never counts as finished.
export function isResolvedLinkedCorrection(row: PurchaseReviewRow) {
  return row.code === "linked_correction" && !row.projectionStatusUnavailable &&
    !!row.projectionStatuses?.length &&
    row.projectionStatuses.some(status => status.inventory_log_id === row.logId) &&
    row.projectionStatuses.every(status => status.status === "synced");
}

export type PurchaseReviewState = "error" | "review" | "pending" | "unknown";

export function purchaseReviewState(row: PurchaseReviewRow): PurchaseReviewState {
  const statuses = row.projectionStatuses ?? [];
  if (statuses.some(status => status.status === "failed")) return "error";
  // Source-link problems (unlinked negative, invalid quantity/family) need a person.
  if (row.code !== "linked_correction" && row.code !== "fully_cancelled") return "review";
  if (statuses.some(status => status.status === "review_required")) return "review";
  if (row.projectionStatusUnavailable) return "unknown";
  if (statuses.some(status => status.status === "pending") || !statuses.some(status => status.inventory_log_id === row.logId)) return "pending";
  return "review";
}

export const PURCHASE_REVIEW_STATE_LABEL: Record<PurchaseReviewState, { ko: string; vi: string; color: string; background: string }> = {
  error: { ko: "처리 오류", vi: "Lỗi xử lý", color: "#b91c1c", background: "#fee2e2" },
  review: { ko: "확인 필요", vi: "Cần kiểm tra", color: "#b45309", background: "#fef3c7" },
  pending: { ko: "처리 대기", vi: "Đang chờ xử lý", color: "#1d4ed8", background: "#dbeafe" },
  unknown: { ko: "상태 확인 불가", vi: "Không kiểm tra được", color: "#4b5563", background: "#f3f4f6" },
};

// Business date (YYYY-MM-DD, Vietnam 03:00 cutoff, resolved server-side) → MM.DD.
export function shortBusinessDate(value: string | null | undefined) {
  const match = /^\d{4}-(\d{2})-(\d{2})/.exec(value ?? "");
  return match ? `${match[1]}.${match[2]}` : "--.--";
}
