"use client";

import { currentPeriodPayables, type PayablePeriodContext, type PeriodPayableRow } from "@/lib/ledger/payable-period-payment";
import { sumPayableAmounts } from "@/lib/ledger/payables";
import styles from "./entries.module.css";

const money = (value: number) => `${value.toLocaleString("vi-VN", { maximumFractionDigits: 3 })} ₫`;
export default function PayablePeriodSnapshot({ lang, period, currentRows }: { lang: "ko" | "vi"; period: PayablePeriodContext; currentRows: PeriodPayableRow[] | null }) {
  const vi = lang === "vi";
  const byId = new Map((currentRows ?? []).map(row => [Number(row.id), row]));
  const remaining = currentRows === null ? null : sumPayableAmounts(currentPeriodPayables(currentRows, period).map(row => row.outstandingAmount));
  return <section aria-label={vi ? "Công nợ cuối tháng và hiện tại" : "월말 및 현재 미납금"}>
    <div className={styles.payableDetailHeader}>
      <span>{period.month} · {vi ? "Công nợ cuối tháng đã chọn" : "선택월 월말 기준 미납"} <strong>{money(period.closingOutstanding)}</strong></span>
      <span>{vi ? "Còn phải trả hiện tại" : "현재 남은 미납"} <strong>{remaining === null ? "…" : money(remaining)}</strong></span>
    </div>
    <p>{vi ? "Thanh toán theo thời gian chi thực tế. Số dư cuối tháng đã chọn được giữ nguyên." : "실제 지급일로 결제하며 선택월의 월말 기준 금액은 유지됩니다."}</p>
    {period.rows.map(row => {
      const source = { ...row.expense?.source_snapshot, ...row.expense?.display_snapshot };
      const name = String((vi ? source.item_name_vi : source.item_name) ?? source.item_name ?? source.itemName ?? source.name ?? "-");
      const current = byId.get(Number(row.id));
      return <div key={row.id} className={styles.paymentHistoryRow}>
        <span>{row.expense?.business_date} · {name}<br />{row.expense?.memo ?? "-"}</span>
        <span>{vi ? "Cuối tháng" : "월말 미납"} {money(row.outstandingAmount)}<br />
          {currentRows === null ? "…" : current?.outstandingAmount ? `${vi ? "Hiện tại" : "현재 미납"} ${money(current.outstandingAmount)}` : (vi ? "Không còn khoản phải trả" : "현재 지급 대상 없음")}
        </span>
      </div>;
    })}
  </section>;
}
