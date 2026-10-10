"use client";

import Link from "next/link";
import { purchaseRepairError, purchaseRepairState } from "@/lib/inventory/purchase-repair-contract";
import type { InventoryDailySyncResult } from "@/lib/inventory/daily-sync-result";
import { ui } from "@/lib/styles/ui";

export default function InventoryDailySyncResults({ results, businessDate, lang }: {
  results: InventoryDailySyncResult[]; businessDate: string; lang: "ko" | "vi";
}) {
  const vi = lang === "vi";
  if (!results.length) return null;
  return <section data-testid="inventory-daily-sync-results" aria-live="polite" style={{ ...ui.card, padding: 16, marginBottom: 16, display: "grid", gap: 12 }}>
    {results.flatMap(item => item.targets.map(target => {
      const name = (vi ? item.currentItemNameVi || item.currentItemName : item.currentItemName || item.currentItemNameVi) || `#${item.itemId}`;
      const quantityReview = target.code === "QUANTITY_CORRECTION_REQUIRED";
      const confirmation = ["SUPPLIER_CHANGE_CONFIRMATION_REQUIRED", "PURCHASE_AMOUNT_CONFIRMATION_REQUIRED", "PURCHASE_ORIGINAL_CANCELLED"].includes(target.code);
      const reason = target.status === "synced" ? (vi ? "Đã đồng bộ thông tin phiếu nhập." : "입고정보 동기화를 완료했습니다.")
        : confirmation ? purchaseRepairState(target.code, vi) : purchaseRepairError(target.code, vi);
      const href = quantityReview ? `/inventory?itemId=${item.itemId}&mode=edit`
        : `/admin/ledger/entries?month=${businessDate.slice(0, 7)}#inventory-projection-${target.purchaseLogId}`;
      const action = quantityReview ? (vi ? "Mở điều chỉnh nhập mua" : "구매입고 정정 열기")
        : confirmation ? (vi ? "Kiểm tra và xác nhận phiếu nhập gốc trong sổ" : "장부에서 원입고 확인·승인")
        : target.status === "failed" ? (vi ? "Kiểm tra lịch sử nhập và thử lại đồng bộ" : "입고 이력 확인 후 동기화 재시도")
        : (vi ? "Kiểm tra thanh toán và lịch sử sửa sổ" : "지급·장부 수정 이력 확인");
      return <div key={`${item.itemId}:${target.purchaseLogId}`} style={{ fontSize: 13, lineHeight: 1.6, overflowWrap: "anywhere" }}>
        <strong>{name} · {vi ? "Phiếu nhập gốc" : "대상 원입고"} #{target.purchaseLogId}</strong>
        <div>{reason}{target.status !== "synced" ? ` (${target.code})` : ""}</div>
        {target.status !== "synced" && <Link href={href}>{action}</Link>}
      </div>;
    }))}
  </section>;
}
