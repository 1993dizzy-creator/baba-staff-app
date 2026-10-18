"use client";

import type { InventoryProjectionIssue } from "./InventoryProjectionResolution";
import { purchaseCaseDisplay } from "@/lib/inventory/purchase-case-display";
import { purchaseReviewEventLabel, purchaseReviewExplanation } from "@/lib/text/inventory-purchase-review";
import styles from "./InventoryPurchaseCaseSummary.module.css";

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const number = (value: number) => value.toLocaleString("en-US", { maximumFractionDigits: 6 });
const valueText = (text: string) => text.slice(text.indexOf(": ") + 2);

export default function InventoryPurchaseCaseDetails({ issue, vi }: { issue: InventoryProjectionIssue; vi: boolean }) {
  const display = purchaseCaseDisplay(issue, vi);
  const evidence = issue.receiptEvidence;
  const priceBefore = evidence?.booked.price;
  const priceAfter = evidence?.current.price;
  const priceChanged = finite(priceBefore) && finite(priceAfter) && priceBefore !== priceAfter;
  const amount = display.changes.find(change => change.kind === "amount");
  const amountKnown = !!display.candidate && [display.candidate.oldAmount, display.candidate.newAmount, display.candidate.delta].every(finite);
  const causes = display.changes.filter(change => change.kind !== "amount");
  const unit = issue.unit || display.candidate?.unit;
  const priceUnit = unit ? `/${unit.toLowerCase()}` : "";
  // Sort a copy; never merge events with equal labels or timestamps.
  const timeline = [...(issue.timeline || [])].sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt)
    || a.id.localeCompare(b.id, undefined, { numeric: true }));
  return <details className={styles.history} data-testid="purchase-case-details">
    <summary>{vi ? "Xem chi tiết" : "상세보기"}</summary>
    <div className={styles.detailBody} data-testid="purchase-case-detail-body">
      <dl className={styles.detailFacts}>
        {priceChanged ? <div data-testid="purchase-case-price-cause">
          <dt>{vi ? "Nguyên nhân · Đơn giá mua" : "변경 원인 · 구매 단가"}</dt>
          <dd>{number(priceBefore)}₫{priceUnit} → <strong>{number(priceAfter)}₫{priceUnit}</strong></dd>
        </div> : null}
        {causes.map(change => <div key={change.kind} data-testid={`purchase-case-${change.kind}-cause`}>
          <dt>{vi ? "Nguyên nhân" : "변경 원인"} · {change.kind === "supplier" ? vi ? "Nhà cung cấp" : "거래처" : vi ? "Số lượng" : "수량"}</dt>
          <dd>{valueText(change.text)}</dd>
        </div>)}
        {!priceChanged && causes.length === 0 ? <div><dt>{vi ? "Nguyên nhân thay đổi" : "변경 원인"}</dt>
          <dd className={styles.explanation}>{amount
            ? vi ? "Số tiền nhập đã sửa khác với bút toán hiện tại." : "수정 입고금액과 기존 장부 기록 금액이 다릅니다."
            : vi ? "Chưa xác định được trường thay đổi từ dữ liệu hiện có." : "현재 자료로 변경 항목을 확정할 수 없습니다."}</dd>
        </div> : null}
        {amount ? <div data-testid="purchase-case-ledger-impact"><dt>{vi ? "Số tiền sổ" : "장부 금액"}</dt>
          <dd>{valueText(amount.text).slice(0, valueText(amount.text).lastIndexOf(" ("))}<strong className={styles.amountDelta}>{valueText(amount.text).slice(valueText(amount.text).lastIndexOf(" ("))}</strong></dd>
        </div> : !amountKnown ? <div><dt>{vi ? "Ảnh hưởng đến sổ" : "장부 영향"}</dt>
          <dd className={styles.explanation}>{vi ? "Chưa đủ căn cứ xác định chênh lệch tiền." : "금액 차이를 확정할 근거가 부족합니다."}</dd>
        </div> : null}
        <div data-testid="purchase-case-review-reason"><dt>{vi ? "Lý do cần kiểm tra" : "확인 필요 사유"}</dt>
          <dd className={styles.reviewExplanation}>{purchaseReviewExplanation(display.code, vi, !!amount)}</dd>
        </div>
      </dl>
      <details className={styles.timeline} data-testid="purchase-case-timeline">
        <summary>{vi ? `Lịch sử xử lý ${timeline.length} mục` : `처리 이력 ${timeline.length}건`}</summary>
        {timeline.length ? <ol>{timeline.map(event => <li key={event.id} data-testid={`purchase-case-event-${event.id}`}>
          <strong>{purchaseReviewEventLabel(event.kind, event.action, event.payableCancelled, vi)}</strong>
          <div className={styles.eventMeta}><time dateTime={event.occurredAt}>{Number.isFinite(Date.parse(event.occurredAt))
            ? new Date(event.occurredAt).toLocaleString(vi ? "vi-VN" : "ko-KR", { timeZone: "Asia/Ho_Chi_Minh", hour12: false }) : "—"}</time>
            {` · ${vi ? "Người xử lý" : "담당자"}: ${event.actor || "—"}`}</div>
          {finite(event.quantityDelta) && event.quantityDelta !== 0 ? <div>{event.kind === "purchase" ? vi ? "Số lượng nhập" : "입고 수량" : vi ? "Thay đổi số lượng" : "수량 변화"}: {number(event.quantityDelta)}{unit || ""}</div> : null}
          {finite(event.amount) && event.beforeAmount !== event.amount ? <div>{vi ? "Số tiền sau xử lý" : "처리 후 금액"}: {finite(event.beforeAmount) ? `${number(event.beforeAmount)}₫ → ` : ""}{number(event.amount)}₫</div> : null}
        </li>)}</ol> : <p className={styles.explanation}>{vi ? "Không có lịch sử xử lý được cung cấp." : "제공된 처리 이력이 없습니다."}</p>}
      </details>
      <details className={styles.technical} data-testid="purchase-case-technical">
        <summary>{vi ? "Thông tin kỹ thuật · kiểm toán" : "기술정보 · 감사 기록"}</summary>
        <div>{vi ? "Phiếu nhập gốc" : "원입고"}: {issue.rootInventoryLogId ? `#${issue.rootInventoryLogId}` : "—"} · {vi ? "Phiếu cần xử lý" : "처리 대상"}: #{issue.inventoryLogId}</div>
        <pre>{JSON.stringify({ code: issue.code, previewCode: display.candidate?.code, status: issue.status, finalStatus: issue.finalStatus, relatedLogIds: issue.relatedLogIds,
          receiptEvidence: evidence, timeline: issue.timeline }, null, 2)}</pre>
      </details>
    </div>
  </details>;
}
