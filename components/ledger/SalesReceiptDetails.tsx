import DashboardDetailRow from "./DashboardDetailRow";
﻿import type { SalesReceiptExplanation } from "@/lib/ledger/card-settlements";
import styles from "@/app/(protected)/admin/ledger/ledger-dashboard.module.css";

const text = {
  ko: {
    pos: "POS 결제매출",
    carry: "+ 이전 월 카드매출 이월 입금",
    unsettled: "− 당월 카드매출 월말 미정산",
    difference: "입금 배분·정산 차이",
    differenceNote: "배분 내역과 실제 매출입금의 차이입니다. 카드 정산 상세에서 확인해 주세요.",
    note: "카드매출은 판매월 기준이며, 실제 입금액은 카드사 입금월 기준입니다. 미정산 카드매출은 지출이 아닌 받을 돈입니다.",
    unavailable: "입금액 산출 근거를 확인할 수 없습니다.",
  },
  vi: {
    pos: "Doanh thu thanh toán POS",
    carry: "+ Tiền thẻ về từ các tháng trước",
    unsettled: "− Thẻ tháng này chưa quyết toán cuối tháng",
    difference: "Chênh lệch phân bổ·quyết toán",
    differenceNote: "Đây là chênh lệch giữa phân bổ và tiền thực nhận. Vui lòng kiểm tra chi tiết quyết toán thẻ.",
    note: "Doanh thu thẻ tính theo tháng bán hàng, tiền thực nhận theo tháng tiền thẻ về. Doanh thu thẻ chưa quyết toán là khoản phải thu, không phải chi phí.",
    unavailable: "Chưa thể xác minh cơ sở tiền thực nhận.",
  },
} as const;

const money = (amount: number) => `${new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 }).format(Math.round(amount))} ₫`;

export default function SalesReceiptDetails({ month, data, lang }: {
  month: string; data?: SalesReceiptExplanation; lang: "ko" | "vi";
}) {
  const copy = text[lang];
  const monthLabel = lang === "vi" ? `Tháng ${Number(month.slice(5, 7))}` : `${Number(month.slice(5, 7))}월`;
  return <>
    {data ? <div className={styles.detailRows}>
      <DashboardDetailRow emoji="🧾" name={`${monthLabel} ${copy.pos}`} amount={money(data.posSales)} />
      <DashboardDetailRow emoji="💳" name={copy.carry} amount={`+${money(data.priorMonthCardDeposits)}`} />
      <DashboardDetailRow emoji="⏳" name={copy.unsettled} amount={`−${money(data.monthEndUnsettledCardSales)}`} />
      {Math.abs(data.allocationDifference) >= 0.5 ? <DashboardDetailRow emoji="⚖️" name={copy.difference} amount={`${data.allocationDifference < 0 ? "−" : "+"}${money(Math.abs(data.allocationDifference))}`} /> : null}
    </div> : <p className={`${styles.sectionNote} ${styles.receiptNote}`}>{copy.unavailable}</p>}
    {data && Math.abs(data.allocationDifference) >= 0.5 ? <p className={`${styles.sectionNote} ${styles.receiptNote}`}>{copy.differenceNote}</p> : null}
    <p className={`${styles.sectionNote} ${styles.receiptNote}`}>{copy.note}</p>
  </>;
}
