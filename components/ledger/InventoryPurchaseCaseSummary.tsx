"use client";

import type { PurchaseCase } from "@/lib/inventory/purchase-cases";
import type { InventoryProjectionIssue } from "./InventoryProjectionResolution";
import styles from "./InventoryPurchaseCaseSummary.module.css";

export default function InventoryPurchaseCaseSummary({ issue, vi }: {
  issue: InventoryProjectionIssue & Partial<PurchaseCase>; vi: boolean;
}) {
  const number = (value: number | null | undefined) => value == null ? "—" : Number(value).toLocaleString("en-US",{maximumFractionDigits:3});
  const name = vi ? issue.itemNameVi || issue.itemName : issue.itemName;
  const root = issue.rootInventoryLogId;
  const eventLabels = {purchase:vi?"Nhập gốc":"원입고",correction:vi?"Sửa / hủy phiếu nhập":"입고 수정·취소",
    stock_check:vi?"Kiểm kê (không đổi số lượng nhập)":"재고조사 (입고 수량 집계 제외)",ledger:vi?"Xử lý sổ":"장부 처리"};
  return <div className={styles.summary} data-testid={`inventory-purchase-case-${root ?? issue.inventoryLogId}`}>
    <div className={styles.heading}><strong>{name}</strong><span>{root ? `${vi?"Phiếu nhập gốc":"원입고"} #${root}` : vi?"Cần liên kết phiếu nhập gốc":"원입고 연결 필요"}</span></div>
    <div className={styles.supplier}>{vi?"Nhà cung cấp":"거래처"}: {issue.supplier || (vi?"Chưa xác định":"미확정")}</div>
    <dl className={styles.facts}>
      <div><dt>{vi?"Ngày":"날짜"}</dt><dd>{issue.businessDate || "—"}</dd></div>
      <div><dt>{vi?"Số lượng nhập":"입고 수량"}</dt><dd>{number(issue.originalQuantity)} → {number(issue.effectiveQuantity)}{issue.unit || ""} ({number(issue.quantityDelta)})</dd></div>
      <div><dt>{vi?"Số tiền sổ":"장부 금액"}</dt><dd>{number(issue.ledgerAmount)}{issue.ledgerAmount == null ? "" : "₫"}</dd></div>
      <div><dt>{vi?"Trạng thái cuối":"최종 상태"}</dt><dd>{issue.finalStatus==="failed" ? vi?"Thất bại · cần kiểm tra":"실패 · 확인 필요" : vi?"Cần quản trị viên kiểm tra":"관리자 확인 필요"}</dd></div>
    </dl>
    {issue.timeline?.length ? <details className={styles.history}>
      <summary>{vi?"Quá trình xử lý":"처리 과정"}</summary>
      <ol>{issue.timeline.map(event=><li key={event.id} data-testid={`purchase-case-event-${event.id}`}>
        <div><strong>{event.kind==='ledger' && event.action==='inventory_purchase_auto_corrected'
          ? vi?"Đã tự động điều chỉnh sổ":"장부 자동 정정 완료"
          : event.kind==='ledger' && event.action==='inventory_source_rebooked'
          ? event.payableCancelled ? vi?"Đảo bút toán và hủy công nợ cũ":"역분개·기존 미납취소"
          : vi?"Đảo bút toán và điều chỉnh sổ":"역분개·장부 정정" : eventLabels[event.kind]}</strong>{event.logId ? ` #${event.logId}` : ""}
          {event.transactionId ? ` · ${vi?"Bút toán":"장부"} #${event.transactionId}` : ""}</div>
        <div><time dateTime={event.occurredAt}>{Number.isFinite(Date.parse(event.occurredAt))
          ? new Date(event.occurredAt).toLocaleString(vi?"vi-VN":"ko-KR",{timeZone:"Asia/Ho_Chi_Minh",hour12:false}) : "—"}</time>
          {` · ${vi?"Người xử lý":"담당자"}: ${event.actor || "—"}`}</div>
        {event.quantityDelta != null ? <div>{vi?"Thay đổi số lượng":"수량 변화"}: {number(event.quantityDelta)}{issue.unit || ""}</div> : null}
        {event.amount != null ? <div>{vi?"Số tiền sau xử lý":"처리 후 금액"}: {event.beforeAmount!=null ? `${number(event.beforeAmount)}₫ → ` : ""}{number(event.amount)}₫</div> : null}
        {event.reversalTransactionId ? <div>{vi?"Bút toán đảo":"역분개 장부"} #{event.reversalTransactionId}</div> : null}
      </li>)}</ol>
    </details> : null}
  </div>;
}
