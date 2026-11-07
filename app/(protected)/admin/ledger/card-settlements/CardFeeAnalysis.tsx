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
  months: { month: string; gross: number; saleDays: number; status: "confirmed" | "provisional" | "estimate_exception" | "pending" | "open" | "partial"; fee: number | null; rate: number | null }[];
  confirmedCount: number; averageRate: number | null; lowest: { month: string; rate: number } | null; highest: { month: string; rate: number } | null;
};
export type CardFeeView = {
  month: string; monthClosed: boolean; autoStatus?: string; historicalConfirmedFee: number; monthEndFee: number; currentOutstanding: number;
  projectedTotalFee: number; finalConfirmedFee: number | null; remainingRate: number | null; confirmedRate: number | null;
  closure: { confirmed_at: string; finalization_business_date?: string | null } | null; estimate?: CardFeeEstimateView; feeHistory?: CardFeeHistoryView;
  // Derived on every read: next-month first deposit starts "awaiting_confirmation"; nothing is booked automatically.
  settlementStatus?: "current_month" | "no_card_sales" | "awaiting_deposit" | "awaiting_confirmation" | "confirmed" | "review_required" | "estimate_exception";
  estimateException?: { amount: number; reason: string | null; recordedAt: string } | null;
};
type SettlementStatus = NonNullable<CardFeeView["settlementStatus"]>;
const text = {
  ko: {
    estimated: "잠정 정산 차액", confirmedKpi: "확정 수수료", rate: "잠정 차액률", confirmedRate: "확정 수수료율", storeAverage: "매장 평균", collecting: "집계 중",
    costRow: "비용 처리", feeRow: "정산 상태", costConfirmed: "비용 반영 완료", costManual: "임시 비용 반영 · {amount}", costNone: "비용 미반영",
    feeConfirmed: "확정 완료 · {mode} · {date}", feeUnconfirmed: "미확정", auto: "자동", manualConfirm: "수동",
    status_awaiting_deposit: "입금 대기", status_awaiting_confirmation: "확인 대기", status_confirmed: "확정 완료", status_review_required: "확인 필요", status_estimate_exception: "예외 마감 · 추정 기준",
    exceptionKpi: "추정 기준 수수료", exceptionRate: "추정 수수료율",
    exceptionHint: "실제 카드사 수수료를 확인하지 못해 임시 비용 {amount} 기준으로 마감했습니다. 공식 확인된 수수료가 아니며 평균 수수료율에서 제외됩니다.",
    waitingDeposit: "익월 첫 카드입금이 등록되면 확인 대기로 바뀝니다. 그 전에는 수수료를 확정하지 않습니다.",
    notLinked: "익월 입금이 아직 이 달 카드매출에 배분되지 않아 확정할 수 없습니다.",
    provisionalHint: "같은 금액이 자동 확정으로 다시 비용 처리되지 않도록 보호됩니다. 실제 수수료가 확정되면 차액만 현재 열린 월에서 정정합니다.",
    duplicate: "임시 비용과 공식 확정이 겹칠 수 있습니다. 중복 비용 여부를 확인하세요.",
    details: "정산 상세", gross: "카드매출", deposits: "입금 반영", unsettled: "미정산 차액", costAmount: "비용 반영 금액",
    settleTitle: "카드대금 정산", settleGross: "전월 카드매출", settleDeposits: "실제 입금 반영액", settleFee: "남은 정산 차액", settleRate: "예상 수수료율",
    settleNote: "확정할 때 POS·장부 카드매출을 다시 대조하고 차액을 다시 계산합니다. 수수료는 직접 입력하지 않습니다.",
    settleCheck: "이 달 카드대금이 모두 입금된 것을 확인했습니다.", settleConfirm: "카드수수료 확정",
    history: "역대 카드수수료율", average: "평균", lowest: "최저", highest: "최고",
    noHistory: "집계 중 · 아직 확정된 달이 없습니다.", monthCol: "매출월", rateCol: "수수료율", statusCol: "상태",
    statusConfirmed: "확정", statusProvisional: "잠정 · 평균 제외", statusPending: "확정 전", statusOpen: "월마감 전", statusPartial: "참고 · 카드매출 {n}일", statusException: "예외 마감 · 평균 제외",
    historyHint: "카드매출 발생월 기준 · 확정된 달만 평균에 포함",
  },
  vi: {
    estimated: "Chênh lệch quyết toán tạm tính", confirmedKpi: "Phí đã xác nhận", rate: "Tỷ lệ chênh lệch tạm tính", confirmedRate: "Tỷ lệ phí đã xác nhận", storeAverage: "TB cửa hàng", collecting: "Đang tổng hợp",
    costRow: "Chi phí", feeRow: "Trạng thái quyết toán", costConfirmed: "Đã ghi chi phí", costManual: "Ghi chi phí tạm · {amount}", costNone: "Chưa ghi chi phí",
    feeConfirmed: "Đã xác nhận · {mode} · {date}", feeUnconfirmed: "Chưa xác nhận", auto: "Tự động", manualConfirm: "Thủ công",
    status_awaiting_deposit: "Chờ tiền về", status_awaiting_confirmation: "Chờ xác nhận", status_confirmed: "Đã xác nhận", status_review_required: "Cần kiểm tra", status_estimate_exception: "Đóng ngoại lệ · theo ước tính",
    exceptionKpi: "Phí theo ước tính", exceptionRate: "Tỷ lệ phí ước tính",
    exceptionHint: "Không xác nhận được phí thực tế của ngân hàng nên tháng này được đóng theo chi phí tạm {amount}. Đây không phải phí đã xác nhận chính thức và không được tính vào tỷ lệ trung bình.",
    waitingDeposit: "Khi có khoản tiền thẻ đầu tiên của tháng sau, trạng thái chuyển sang chờ xác nhận. Trước đó phí không được xác nhận.",
    notLinked: "Tiền về tháng sau chưa được trừ vào doanh thu thẻ tháng này nên chưa thể xác nhận.",
    provisionalHint: "Số tiền này được bảo vệ để không bị tự động ghi chi phí lần nữa. Khi phí thực tế được xác nhận, chỉ phần chênh lệch được điều chỉnh ở tháng đang mở.",
    duplicate: "Chi phí tạm có thể trùng với xác nhận chính thức. Hãy kiểm tra chi phí trùng.",
    details: "Chi tiết quyết toán", gross: "Doanh thu thẻ", deposits: "Tiền về đã trừ", unsettled: "Chênh lệch chưa quyết toán", costAmount: "Số tiền đã ghi chi phí",
    settleTitle: "Quyết toán tiền thẻ", settleGross: "Doanh thu thẻ tháng trước", settleDeposits: "Tiền thực nhận đã trừ", settleFee: "Chênh lệch còn lại", settleRate: "Tỷ lệ phí dự kiến",
    settleNote: "Khi xác nhận, hệ thống đối chiếu lại doanh thu thẻ POS và sổ cái và tính lại chênh lệch. Không nhập phí thủ công.",
    settleCheck: "Tôi đã kiểm tra toàn bộ tiền thẻ của tháng này đã về.", settleConfirm: "Xác nhận phí thẻ",
    history: "Tỷ lệ phí thẻ các tháng", average: "Trung bình", lowest: "Thấp nhất", highest: "Cao nhất",
    noHistory: "Đang tổng hợp · chưa có tháng nào được xác nhận.", monthCol: "Tháng bán", rateCol: "Tỷ lệ phí", statusCol: "Trạng thái",
    statusConfirmed: "Đã xác nhận", statusProvisional: "Tạm tính · không tính TB", statusPending: "Chưa xác nhận", statusOpen: "Chưa chốt sổ", statusPartial: "Tham khảo · {n} ngày bán thẻ", statusException: "Đóng ngoại lệ · không tính TB",
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
  const [lastDepositChecked, setLastDepositChecked] = useState(false);
  // KPI numbers are the existing API values; nothing is recalculated here.
  const confirmed = Boolean(fee.closure);
  const status: SettlementStatus | null = fee.settlementStatus ?? (confirmed ? "confirmed" : null);
  const exception = status === "estimate_exception";
  // Unconfirmed past month: the settlement block (numbers + one confirmation) is always visible.
  // A provisional-fee month (October) can never be settled here, so it keeps the detail view instead.
  const showSettlement = (status === "awaiting_deposit" || status === "awaiting_confirmation" || status === "review_required") && !estimate?.provisionalManualOnly;
  const kpiAmount = estimate?.currentEstimate ?? (confirmed ? fee.finalConfirmedFee ?? 0 : fee.projectedTotalFee);
  const kpiRate = estimate ? estimate.rate : confirmed ? fee.confirmedRate : fee.remainingRate;
  // Two separate facts: whether a cost is booked, and whether the actual fee is confirmed.
  const provisional = !confirmed && Boolean(estimate?.provisionalManualOnly);
  const costState = confirmed ? t.costConfirmed : provisional ? t.costManual.replace("{amount}", money(estimate!.manualExpenseTotal)) : t.costNone;
  const feeState = confirmed ? t.feeConfirmed.replace("{mode}", fee.closure?.finalization_business_date ? t.auto : t.manualConfirm)
    .replace("{date}", new Date(fee.closure!.confirmed_at).toLocaleDateString(lang === "vi" ? "vi-VN" : "ko-KR", { timeZone: "Asia/Ho_Chi_Minh" }))
    : status && status !== "current_month" && status !== "no_card_sales" ? t[`status_${status}`] : t.feeUnconfirmed;
  // Settlement detail: the four amounts a user needs. Deposits applied = gross − remainder − booked official fee.
  const bookedFee = confirmed ? fee.finalConfirmedFee ?? 0 : (provisional ? estimate!.manualExpenseTotal : 0) + fee.historicalConfirmedFee;
  const grossAmount = estimate?.gross ?? 0;
  const depositsApplied = Math.max(0, grossAmount - fee.currentOutstanding - (confirmed ? fee.finalConfirmedFee ?? 0 : fee.historicalConfirmedFee));
  return <div className={styles.feeUnified}>
    <div className={styles.grid}>
      <article className={styles.miniCard}><span>{confirmed ? t.confirmedKpi : exception ? t.exceptionKpi : t.estimated}</span><strong>{money(kpiAmount)}</strong></article>
      <article className={styles.miniCard}><span>{confirmed ? t.confirmedRate : exception ? t.exceptionRate : t.rate}</span><strong>{kpiRate == null ? "-" : percent(kpiRate)}</strong></article>
    </div>
    <dl className={styles.feeState}>
      <div><dt>{t.costRow}</dt><dd>{costState}</dd></div>
      <div><dt>{t.feeRow}</dt><dd className={status === "confirmed" ? styles.feeStateDone : status === "review_required" ? styles.feeStateReview : undefined}>{feeState}</dd></div>
    </dl>
    {exception ? <p className={styles.hint}>{t.exceptionHint.replace("{amount}", money(fee.estimateException?.amount ?? estimate?.manualExpenseTotal ?? 0))}</p>
      : provisional ? <p className={styles.hint}>{t.provisionalHint}</p> : null}
    {estimate?.duplicateRisk ? <p role="status" className={styles.validation}>{t.duplicate}</p> : null}
    {notices.map(notice => <p key={notice} role="status" className={styles.validation}>{notice}</p>)}
    {footer}
    {showSettlement && estimate && !confirmed ? <section className={styles.settlePanel} aria-label={t.settleTitle}>
      <strong>{t.settleTitle}</strong>
      <dl className={styles.feeRows}>
        <div><dt>{t.settleGross}</dt><dd>{money(estimate.gross)}</dd></div>
        <div><dt>{t.settleDeposits}</dt><dd>{money(depositsApplied)}</dd></div>
        <div className={styles.feeTotal}><dt>{t.settleFee}</dt><dd>{money(fee.currentOutstanding)}</dd></div>
        {estimate.gross > 0 ? <div><dt>{t.settleRate}</dt><dd>{percent((fee.historicalConfirmedFee + fee.currentOutstanding) / estimate.gross)}</dd></div> : null}
      </dl>
      {status === "awaiting_deposit" ? <p className={styles.hint}>{t.waitingDeposit}</p>
        : status === "awaiting_confirmation" && !canSettle ? <p className={styles.hint}>{t.notLinked}</p> : null}
      {/* One confirmation: the admin only confirms the final deposit; amount and rate are never typed and are re-checked server-side. */}
      {status === "awaiting_confirmation" && canSettle && onSettle ? <>
        <p className={styles.hint}>{t.settleNote}</p>
        <label className={styles.settleCheck}><input type="checkbox" checked={lastDepositChecked} disabled={settling} onChange={e => setLastDepositChecked(e.target.checked)} />{t.settleCheck}</label>
        <button type="button" className={styles.primary} style={{ width: "100%" }} disabled={settling || !lastDepositChecked} onClick={() => void onSettle(fee.currentOutstanding)}>{t.settleConfirm}</button>
      </> : null}
    </section> : null}
    {showSettlement && estimate && !confirmed ? null : <details className={styles.feeDetails}>
      <summary>{t.details}</summary>
      {/* No voucher ids, memos or zero lines here; vouchers, audit and duplicate guards are unchanged server-side. */}
      <dl className={styles.feeRows}>
        {estimate ? <div><dt>{t.gross}</dt><dd>{money(grossAmount)}</dd></div> : null}
        {estimate ? <div><dt>{t.deposits}</dt><dd>{money(depositsApplied)}</dd></div> : null}
        {fee.currentOutstanding ? <div><dt>{t.unsettled}</dt><dd>{money(fee.currentOutstanding)}</dd></div> : null}
        {bookedFee ? <div className={styles.feeTotal}><dt>{t.costAmount}</dt><dd>{money(bookedFee)}</dd></div> : null}
      </dl>
    </details>}
  </div>;
}

// Actual historical rates by sale month. Confirmed months only enter the sales-weighted average.
export function CardFeeHistory({ history, lang }: { history: CardFeeHistoryView; lang: Lang }) {
  const t = text[lang];
  const label = (month: string) => monthLabel(month, lang);
  const scrolls = history.months.length > HISTORY_VISIBLE_ROWS;
  const statusText = (row: CardFeeHistoryView["months"][number]) => row.status === "confirmed" ? t.statusConfirmed
    : row.status === "provisional" ? t.statusProvisional : row.status === "estimate_exception" ? t.statusException : row.status === "pending" ? t.statusPending
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
