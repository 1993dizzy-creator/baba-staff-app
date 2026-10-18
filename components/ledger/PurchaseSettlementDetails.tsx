import type { PurchaseSettlement } from "@/lib/ledger/payables";
import styles from "./PurchaseSettlementDetails.module.css";

export default function PurchaseSettlementDetails({ settlement, vi }: { settlement: PurchaseSettlement; vi: boolean }) {
  const money=(value:number)=>`${value.toLocaleString(vi?"vi-VN":"ko-KR",{maximumFractionDigits:3})}₫`;
  const status=vi?{paid:"Đã quyết toán",partial:"Thanh toán một phần",unpaid:"Chưa thanh toán"}[settlement.status]
    :{paid:"정산 완료",partial:"부분 지급",unpaid:"미지급"}[settlement.status];
  return <details className={styles.panel} data-testid="purchase-settlement">
    <summary>{vi?"Quyết toán phiếu nhập":"원입고 정산"} · {status}</summary>
    <dl>
      <div><dt>{vi?"Tiền nhập gốc":"원입고 매입금액"}</dt><dd>{money(settlement.originalAmount)}</dd></div>
      <div><dt>{vi?"Điều chỉnh không dùng tiền":"비현금 소액조정"}</dt><dd>{money(settlement.adjustmentAmount)}</dd></div>
      <div><dt>{vi?"Chi phí được ghi nhận":"최종 인정금액"}</dt><dd><strong>{money(settlement.effectiveAmount)}</strong></dd></div>
      <div><dt>{vi?"Thực thanh toán":"실제 지급액"}</dt><dd>{money(settlement.cashPaidAmount)}</dd></div>
      <div><dt>{vi?"Công nợ cuối":"최종 미지급액"}</dt><dd><strong>{money(settlement.remainingAmount)}</strong></dd></div>
      <div><dt>{vi?"Trạng thái":"정산 상태"}</dt><dd>{status}</dd></div>
    </dl>
    {settlement.adjustments.length?<div className={styles.reasons}>{settlement.adjustments.map(a=><p key={a.transactionId}>{money(a.amount)} · {vi?"Điều chỉnh theo khoản thanh toán đã đối chiếu, không phát sinh dòng tiền.":"확인된 실지급액에 맞춘 비현금 조정입니다. 추가 현금 이동은 없습니다."}</p>)}</div>:null}
    <details className={styles.audit}><summary>{vi?"Lịch sử thanh toán và điều chỉnh":"지급·조정 감사 내역"}</summary>
      {settlement.payments.map((p,index)=><p key={`${p.transactionId}:${index}`}>{p.businessDate} · {vi?"Thanh toán":"지급"} {p.transactionId==null?"":`#${p.transactionId}`} · {money(p.amount)}</p>)}
      {settlement.adjustments.map(a=><div key={a.transactionId}><p>{a.businessDate} · {vi?"Điều chỉnh":"조정"} #{a.transactionId} · {money(a.amount)}</p><p>{a.reason}</p><small>{a.sourceKey}</small><pre>{JSON.stringify(a.sourceSnapshot,null,2)}</pre></div>)}
    </details>
  </details>;
}
