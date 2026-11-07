"use client";
import { useState, type ReactNode } from "react";
import styles from "./card-settlements.module.css";

// Unified card fee view for a past month: two KPIs (difference, rate vs store average), cost/fee
// state, collapsed breakdown and the explicit card payment settlement step (the page posts it).
// CardFeeHistory shows actual historical rates by sale month.
export type CardFeeEstimateView = {
  gross: number; confirmedFee: number; unconfirmedEstimate: number; currentEstimate: number; rate: number | null;
  manualExpenses: { id: number; amount: number; memo: string | null }[];
  manualExpenseTotal: number; manualCoveredEstimate: number; unrecognizedEstimate: number; duplicateRisk: boolean; provisionalManualOnly: boolean;
};
export type CardFeeHistoryView = {
  months: { month: string; gross: number; saleDays: number; status: "confirmed" | "provisional" | "pending" | "open" | "partial"; fee: number | null; rate: number | null }[];
  confirmedCount: number; averageRate: number | null; lowest: { month: string; rate: number } | null; highest: { month: string; rate: number } | null;
};
export type CardFeeView = {
  month: string; monthClosed: boolean; autoStatus?: string; historicalConfirmedFee: number; monthEndFee: number; currentOutstanding: number;
  projectedTotalFee: number; finalConfirmedFee: number | null; remainingRate: number | null; confirmedRate: number | null;
  closure: { confirmed_at: string; finalization_business_date?: string | null } | null; estimate?: CardFeeEstimateView; feeHistory?: CardFeeHistoryView;
};
const text = {
  ko: {
    estimated: "잠정 정산 차액", confirmedKpi: "확정 수수료", rate: "잠정 차액률", confirmedRate: "확정 수수료율", storeAverage: "매장 평균", collecting: "집계 중",
    costRow: "비용 처리", feeRow: "수수료 확정", costConfirmed: "비용 반영 완료", costManual: "임시 비용 반영 · {amount}", costNone: "비용 미반영",
    feeConfirmed: "확정 · {mode} · {date}", feeUnconfirmed: "미확정", auto: "자동", manualConfirm: "수동",
    provisionalHint: "같은 금액이 자동 확정으로 다시 비용 처리되지 않도록 보호됩니다. 실제 수수료가 확정되면 차액만 현재 열린 월에서 정정합니다.",
    duplicate: "임시 비용과 공식 확정이 겹칠 수 있습니다. 중복 비용 여부를 확인하세요.",
    details: "정산 상세", gross: "카드매출", deposits: "입금 반영", unsettled: "미정산 차액", costAmount: "비용 반영 금액",
    settle: "카드대금 입금 완료 · 수수료 확정", settleTitle: "카드대금 정산완료", settleGross: "정산 대상 카드매출", settleDeposits: "실제 입금 반영",
    settleFee: "확정할 수수료", settleRate: "확정 후 수수료율", settleNote: "이 달 카드매출의 마지막 입금까지 등록한 뒤 확정하세요. 확정할 때 POS와 장부 카드매출이 일치하는지 다시 확인하고, 확정 후의 입금은 다음 달 매출부터 배분됩니다.",
    settleCheck: "이 달 카드매출의 마지막 카드입금까지 확인했습니다.", settleBack: "돌아가기", settleConfirm: "수수료 확정",
    history: "역대 카드수수료율", average: "평균", lowest: "최저", highest: "최고",
    noHistory: "집계 중 · 아직 확정된 달이 없습니다.", monthCol: "매출월", rateCol: "수수료율", statusCol: "상태",
    statusConfirmed: "확정", statusProvisional: "잠정 · 평균 제외", statusPending: "확정 전", statusOpen: "월마감 전", statusPartial: "참고 · 카드매출 {n}일",
    historyHint: "카드매출 발생월 기준 · 확정된 달만 평균에 포함",
  },
  vi: {
    estimated: "Chênh lệch quyết toán tạm tính", confirmedKpi: "Phí đã xác nhận", rate: "Tỷ lệ chênh lệch tạm tính", confirmedRate: "Tỷ lệ phí đã xác nhận", storeAverage: "TB cửa hàng", collecting: "Đang tổng hợp",
    costRow: "Chi phí", feeRow: "Xác nhận phí", costConfirmed: "Đã ghi chi phí", costManual: "Ghi chi phí tạm · {amount}", costNone: "Chưa ghi chi phí",
    feeConfirmed: "Đã xác nhận · {mode} · {date}", feeUnconfirmed: "Chưa xác nhận", auto: "Tự động", manualConfirm: "Thủ công",
    provisionalHint: "Số tiền này được bảo vệ để không bị tự động ghi chi phí lần nữa. Khi phí thực tế được xác nhận, chỉ phần chênh lệch được điều chỉnh ở tháng đang mở.",
    duplicate: "Chi phí tạm có thể trùng với xác nhận chính thức. Hãy kiểm tra chi phí trùng.",
    details: "Chi tiết quyết toán", gross: "Doanh thu thẻ", deposits: "Tiền về đã trừ", unsettled: "Chênh lệch chưa quyết toán", costAmount: "Số tiền đã ghi chi phí",
    settle: "Đã nhận đủ tiền thẻ · Xác nhận phí", settleTitle: "Hoàn tất quyết toán tiền thẻ", settleGross: "Doanh thu thẻ cần quyết toán", settleDeposits: "Tiền thực nhận đã trừ",
    settleFee: "Phí sẽ xác nhận", settleRate: "Tỷ lệ phí sau xác nhận", settleNote: "Chỉ xác nhận sau khi đã ghi nhận khoản tiền thẻ cuối cùng của tháng này. Khi xác nhận, hệ thống kiểm tra lại doanh thu thẻ POS và sổ cái; tiền về sau đó được trừ vào doanh thu tháng sau.",
    settleCheck: "Tôi đã kiểm tra khoản tiền thẻ cuối cùng của doanh thu tháng này.", settleBack: "Quay lại", settleConfirm: "Xác nhận phí",
    history: "Tỷ lệ phí thẻ các tháng", average: "Trung bình", lowest: "Thấp nhất", highest: "Cao nhất",
    noHistory: "Đang tổng hợp · chưa có tháng nào được xác nhận.", monthCol: "Tháng bán", rateCol: "Tỷ lệ phí", statusCol: "Trạng thái",
    statusConfirmed: "Đã xác nhận", statusProvisional: "Tạm tính · không tính TB", statusPending: "Chưa xác nhận", statusOpen: "Chưa chốt sổ", statusPartial: "Tham khảo · {n} ngày bán thẻ",
    historyHint: "Theo tháng phát sinh doanh thu thẻ · chỉ tháng đã xác nhận được tính trung bình",
  },
} as const;
type Lang = "ko" | "vi";
const money = (n: number) => `${new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 3 }).format(n)} ₫`;
const percent = (rate: number) => `${(rate * 100).toFixed(2)}%`;
// Year is always shown so months of different years never look alike.
function monthLabel(month: string, lang: Lang) {
  const [year, number] = [month.slice(0, 4), Number(month.slice(5, 7))];
  return lang === "vi" ? `T${number}/${year}` : `${year}년 ${number}월`;
}
const shortMonth = (month: string, lang: Lang) => lang === "vi" ? `T${Number(month.slice(5, 7))}/${month.slice(0, 4)}` : `${month.slice(0, 4)}.${month.slice(5, 7)}`;
// Visible history rows before the table scrolls inside its own box.
const HISTORY_VISIBLE_ROWS = 5;

export default function CardFeeAnalysis({ fee, lang, notices = [], footer, canSettle = false, settling = false, onSettle }: {
  fee: CardFeeView; lang: Lang; notices?: readonly string[]; footer?: ReactNode;
  canSettle?: boolean; settling?: boolean; onSettle?: (confirmedFee: number) => void | Promise<void>;
}) {
  const t = text[lang], estimate = fee.estimate;
  const [settleOpen, setSettleOpen] = useState(false), [lastDepositChecked, setLastDepositChecked] = useState(false);
  // KPI numbers are the existing API values; nothing is recalculated here.
  const confirmed = Boolean(fee.closure);
  const kpiAmount = estimate?.currentEstimate ?? (confirmed ? fee.finalConfirmedFee ?? 0 : fee.projectedTotalFee);
  const kpiRate = estimate ? estimate.rate : confirmed ? fee.confirmedRate : fee.remainingRate;
  // Two separate facts: whether a cost is booked, and whether the actual fee is confirmed.
  const provisional = !confirmed && Boolean(estimate?.provisionalManualOnly);
  const costState = confirmed ? t.costConfirmed : provisional ? t.costManual.replace("{amount}", money(estimate!.manualExpenseTotal)) : t.costNone;
  const feeState = confirmed ? t.feeConfirmed.replace("{mode}", fee.closure?.finalization_business_date ? t.auto : t.manualConfirm)
    .replace("{date}", new Date(fee.closure!.confirmed_at).toLocaleDateString(lang === "vi" ? "vi-VN" : "ko-KR", { timeZone: "Asia/Ho_Chi_Minh" })) : t.feeUnconfirmed;
  // Settlement detail: the four amounts a user needs. Deposits applied = gross − remainder − booked official fee.
  const bookedFee = confirmed ? fee.finalConfirmedFee ?? 0 : (provisional ? estimate!.manualExpenseTotal : 0) + fee.historicalConfirmedFee;
  const grossAmount = estimate?.gross ?? 0;
  const depositsApplied = Math.max(0, grossAmount - fee.currentOutstanding - (confirmed ? fee.finalConfirmedFee ?? 0 : fee.historicalConfirmedFee));
  return <div className={styles.feeUnified}>
    <div className={styles.grid}>
      <article className={styles.miniCard}><span>{confirmed ? t.confirmedKpi : t.estimated}</span><strong>{money(kpiAmount)}</strong></article>
      <article className={styles.miniCard}><span>{confirmed ? t.confirmedRate : t.rate}</span><strong>{kpiRate == null ? "-" : percent(kpiRate)}</strong></article>
    </div>
    <dl className={styles.feeState}>
      <div><dt>{t.costRow}</dt><dd>{costState}</dd></div>
      <div><dt>{t.feeRow}</dt><dd className={confirmed ? styles.feeStateDone : undefined}>{feeState}</dd></div>
    </dl>
    {provisional ? <p className={styles.hint}>{t.provisionalHint}</p> : null}
    {estimate?.duplicateRisk ? <p role="status" className={styles.validation}>{t.duplicate}</p> : null}
    {notices.map(notice => <p key={notice} role="status" className={styles.validation}>{notice}</p>)}
    {footer}
    {canSettle && onSettle && estimate && !confirmed ? (settleOpen ? <section className={styles.settlePanel} aria-label={t.settleTitle}>
      <strong>{t.settleTitle}</strong>
      <dl className={styles.feeRows}>
        <div><dt>{t.settleGross}</dt><dd>{money(estimate.gross)}</dd></div>
        <div><dt>{t.settleDeposits}</dt><dd>{money(Math.max(0, estimate.gross - fee.currentOutstanding - fee.historicalConfirmedFee))}</dd></div>
        <div className={styles.feeTotal}><dt>{t.settleFee}</dt><dd>{money(fee.currentOutstanding)}</dd></div>
        {estimate.gross > 0 ? <div><dt>{t.settleRate}</dt><dd>{percent((fee.historicalConfirmedFee + fee.currentOutstanding) / estimate.gross)}</dd></div> : null}
      </dl>
      <p className={styles.hint}>{t.settleNote}</p>
      {/* Explicit confirmation of the month's final deposit; the shown amount is sent and re-checked server-side. */}
      <label className={styles.settleCheck}><input type="checkbox" checked={lastDepositChecked} disabled={settling} onChange={e => setLastDepositChecked(e.target.checked)} />{t.settleCheck}</label>
      <div className={styles.actions}>
        <button type="button" className={styles.secondary} disabled={settling} onClick={() => { setSettleOpen(false); setLastDepositChecked(false); }}>{t.settleBack}</button>
        <button type="button" className={styles.primary} disabled={settling || !lastDepositChecked} onClick={() => void onSettle(fee.currentOutstanding)}>{t.settleConfirm}</button>
      </div>
    </section> : <button type="button" className={styles.primary} style={{ width: "100%" }} disabled={settling} onClick={() => setSettleOpen(true)}>{t.settle}</button>) : null}
    <details className={styles.feeDetails}>
      <summary>{t.details}</summary>
      {/* No voucher ids, memos or zero lines here; vouchers, audit and duplicate guards are unchanged server-side. */}
      <dl className={styles.feeRows}>
        {estimate ? <div><dt>{t.gross}</dt><dd>{money(grossAmount)}</dd></div> : null}
        {estimate ? <div><dt>{t.deposits}</dt><dd>{money(depositsApplied)}</dd></div> : null}
        {fee.currentOutstanding ? <div><dt>{t.unsettled}</dt><dd>{money(fee.currentOutstanding)}</dd></div> : null}
        {bookedFee ? <div className={styles.feeTotal}><dt>{t.costAmount}</dt><dd>{money(bookedFee)}</dd></div> : null}
      </dl>
    </details>
  </div>;
}

// Actual historical rates by sale month. Confirmed months only enter the sales-weighted average.
export function CardFeeHistory({ history, lang }: { history: CardFeeHistoryView; lang: Lang }) {
  const t = text[lang];
  const label = (month: string) => monthLabel(month, lang);
  const scrolls = history.months.length > HISTORY_VISIBLE_ROWS;
  const statusText = (row: CardFeeHistoryView["months"][number]) => row.status === "confirmed" ? t.statusConfirmed
    : row.status === "provisional" ? t.statusProvisional : row.status === "pending" ? t.statusPending
      : row.status === "open" ? t.statusOpen : t.statusPartial.replace("{n}", String(row.saleDays));
  return <div className={styles.feeHistory} aria-label={t.history}>
    <h3 className={styles.sectionTitle}>📈 {t.history}</h3>
    {history.confirmedCount === 0 || history.averageRate === null ? <p className={styles.empty}>{t.noHistory}</p>
      : <div className={styles.historyStats}>
        <article className={styles.miniCard}><span>{t.average}</span><strong>{percent(history.averageRate)}</strong></article>
        {([[t.lowest, history.lowest], [t.highest, history.highest]] as const).map(([title, point]) => <article key={title} className={styles.miniCard}><span>{title}</span>
          <strong className={styles.rateWithMonth}>{point ? percent(point.rate) : "-"}{point ? <small>({shortMonth(point.month, lang)})</small> : null}</strong></article>)}
      </div>}
    {/* Up to 5 rows inline; 6+ rows scroll inside the box with a sticky header (never sideways). */}
    {history.months.length ? <div className={scrolls ? `${styles.historyTableBox} ${styles.historyTableScroll}` : styles.historyTableBox} data-history-scroll={scrolls ? "true" : undefined}>
      <table className={styles.feeTable}>
        <thead><tr><th scope="col">{t.monthCol}</th><th scope="col">{t.rateCol}</th><th scope="col">{t.statusCol}</th></tr></thead>
        <tbody>{history.months.map(row => <tr key={row.month} className={row.status === "confirmed" ? undefined : styles.historyMuted}>
          <th scope="row">{label(row.month)}</th><td>{row.rate === null ? t.collecting : percent(row.rate)}</td><td>{statusText(row)}</td>
        </tr>)}</tbody>
      </table>
    </div> : null}
    <p className={styles.hint}>{t.historyHint}</p>
  </div>;
}
