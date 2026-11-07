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
    costRow: "비용 반영", feeRow: "수수료 확정", costConfirmed: "확정 전표", costManual: "수기 전표 {ids} · {amount}", costNone: "미반영",
    feeConfirmed: "확정 · {mode} · {date}", feeUnconfirmed: "미확정", auto: "자동", manualConfirm: "수동",
    provisionalHint: "같은 금액이 자동 확정으로 다시 비용 처리되지 않도록 보호됩니다. 실제 수수료가 확정되면 차액만 현재 열린 월에서 정정합니다.",
    duplicate: "수기 비용과 공식 확정이 겹칠 수 있습니다. 중복계상 여부를 확인하세요.",
    details: "세부 내역 · 수기 전표", gross: "월 카드매출", confirmedTotal: "확정 수수료", historicalPart: "└ 기존 확정", monthEndPart: "└ 월말 확정",
    unconfirmed: "미확정 차액(미정산 잔액)", manual: "수기 비용 전표", unrecognized: "└ 비용 미반영 차액",
    settle: "카드대금 입금 완료 · 수수료 확정", settleTitle: "카드대금 정산완료", settleGross: "정산 대상 카드매출", settleDeposits: "실제 입금 반영",
    settleFee: "확정할 수수료", settleRate: "확정 후 수수료율", settleNote: "이 달 카드매출의 마지막 입금까지 등록한 뒤 확정하세요. 확정할 때 POS와 장부 카드매출이 일치하는지 다시 확인하고, 확정 후의 입금은 다음 달 매출부터 배분됩니다.",
    settleBack: "돌아가기", settleConfirm: "수수료 확정",
    history: "역대 카드수수료율", lowest: "최저", highest: "최고", confirmedMonths: "확정 {n}개월 · 매출 가중",
    noHistory: "집계 중 · 아직 확정된 달이 없습니다.", monthCol: "매출월", rateCol: "수수료율", statusCol: "상태",
    statusConfirmed: "확정", statusProvisional: "잠정 · 평균 제외", statusPending: "확정 전", statusOpen: "월마감 전", statusPartial: "참고 · 카드매출 {n}일",
    historyHint: "카드매출 발생월 기준 · 확정된 달만 평균에 포함",
  },
  vi: {
    estimated: "Chênh lệch quyết toán tạm tính", confirmedKpi: "Phí đã xác nhận", rate: "Tỷ lệ chênh lệch tạm tính", confirmedRate: "Tỷ lệ phí đã xác nhận", storeAverage: "TB cửa hàng", collecting: "Đang tổng hợp",
    costRow: "Ghi chi phí", feeRow: "Xác nhận phí", costConfirmed: "Bút toán đã xác nhận", costManual: "Bút toán thủ công {ids} · {amount}", costNone: "Chưa ghi",
    feeConfirmed: "Đã xác nhận · {mode} · {date}", feeUnconfirmed: "Chưa xác nhận", auto: "Tự động", manualConfirm: "Thủ công",
    provisionalHint: "Số tiền này được bảo vệ để không bị tự động ghi chi phí lần nữa. Khi phí thực tế được xác nhận, chỉ phần chênh lệch được điều chỉnh ở tháng đang mở.",
    duplicate: "Chi phí thủ công có thể trùng với xác nhận chính thức. Hãy kiểm tra ghi trùng.",
    details: "Chi tiết · Bút toán thủ công", gross: "Doanh thu thẻ tháng", confirmedTotal: "Phí đã xác nhận", historicalPart: "└ Đã xác nhận trước", monthEndPart: "└ Xác nhận cuối tháng",
    unconfirmed: "Chênh lệch chưa xác nhận (còn chưa quyết toán)", manual: "Bút toán chi phí thủ công", unrecognized: "└ Chênh lệch chưa ghi chi phí",
    settle: "Đã nhận đủ tiền thẻ · Xác nhận phí", settleTitle: "Hoàn tất quyết toán tiền thẻ", settleGross: "Doanh thu thẻ cần quyết toán", settleDeposits: "Tiền thực nhận đã trừ",
    settleFee: "Phí sẽ xác nhận", settleRate: "Tỷ lệ phí sau xác nhận", settleNote: "Chỉ xác nhận sau khi đã ghi nhận khoản tiền thẻ cuối cùng của tháng này. Khi xác nhận, hệ thống kiểm tra lại doanh thu thẻ POS và sổ cái; tiền về sau đó được trừ vào doanh thu tháng sau.",
    settleBack: "Quay lại", settleConfirm: "Xác nhận phí",
    history: "Tỷ lệ phí thẻ các tháng", lowest: "Thấp nhất", highest: "Cao nhất", confirmedMonths: "{n} tháng đã xác nhận · theo doanh thu",
    noHistory: "Đang tổng hợp · chưa có tháng nào được xác nhận.", monthCol: "Tháng bán", rateCol: "Tỷ lệ phí", statusCol: "Trạng thái",
    statusConfirmed: "Đã xác nhận", statusProvisional: "Tạm tính · không tính TB", statusPending: "Chưa xác nhận", statusOpen: "Chưa chốt sổ", statusPartial: "Tham khảo · {n} ngày bán thẻ",
    historyHint: "Theo tháng phát sinh doanh thu thẻ · chỉ tháng đã xác nhận được tính trung bình",
  },
} as const;
type Lang = "ko" | "vi";
const money = (n: number) => `${new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 3 }).format(n)} ₫`;
const percent = (rate: number) => `${(rate * 100).toFixed(2)}%`;
function monthLabel(month: string, lang: Lang, latestYear: string) {
  const [year, number] = [month.slice(0, 4), Number(month.slice(5, 7))];
  if (lang === "vi") return year === latestYear ? `T${number}` : `T${number}/${year}`;
  return year === latestYear ? `${number}월` : `${year.slice(2)}년 ${number}월`;
}

export default function CardFeeAnalysis({ fee, lang, notices = [], footer, canSettle = false, settling = false, onSettle }: {
  fee: CardFeeView; lang: Lang; notices?: readonly string[]; footer?: ReactNode;
  canSettle?: boolean; settling?: boolean; onSettle?: () => void | Promise<void>;
}) {
  const t = text[lang], estimate = fee.estimate;
  const [settleOpen, setSettleOpen] = useState(false);
  // KPI numbers are the existing API values; nothing is recalculated here.
  const confirmed = Boolean(fee.closure);
  const kpiAmount = estimate?.currentEstimate ?? (confirmed ? fee.finalConfirmedFee ?? 0 : fee.projectedTotalFee);
  const kpiRate = estimate ? estimate.rate : confirmed ? fee.confirmedRate : fee.remainingRate;
  const average = fee.feeHistory?.averageRate ?? null;
  const manualIds = estimate?.manualExpenses.map(row => `#${row.id}`).join(", ") ?? "";
  // Two separate facts: whether a cost is booked, and whether the actual fee is confirmed.
  const provisional = !confirmed && Boolean(estimate?.provisionalManualOnly);
  const costState = confirmed ? t.costConfirmed : provisional ? t.costManual.replace("{ids}", manualIds).replace("{amount}", money(estimate!.manualExpenseTotal)) : t.costNone;
  const feeState = confirmed ? t.feeConfirmed.replace("{mode}", fee.closure?.finalization_business_date ? t.auto : t.manualConfirm)
    .replace("{date}", new Date(fee.closure!.confirmed_at).toLocaleDateString(lang === "vi" ? "vi-VN" : "ko-KR", { timeZone: "Asia/Ho_Chi_Minh" })) : t.feeUnconfirmed;
  const confirmedTotal = confirmed ? fee.finalConfirmedFee ?? 0 : estimate?.confirmedFee ?? fee.historicalConfirmedFee;
  return <div className={styles.feeUnified}>
    <div className={styles.grid}>
      <article className={styles.miniCard}><span>{confirmed ? t.confirmedKpi : t.estimated}</span><strong>{money(kpiAmount)}</strong></article>
      <article className={styles.miniCard}><span>{confirmed ? t.confirmedRate : t.rate}</span><strong>{kpiRate == null ? "-" : percent(kpiRate)}</strong>
        <small className={styles.kpiNote}>{t.storeAverage} {average === null ? t.collecting : percent(average)}</small></article>
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
      <div className={styles.actions}>
        <button type="button" className={styles.secondary} disabled={settling} onClick={() => setSettleOpen(false)}>{t.settleBack}</button>
        <button type="button" className={styles.primary} disabled={settling} onClick={() => void onSettle()}>{t.settleConfirm}</button>
      </div>
    </section> : <button type="button" className={styles.primary} style={{ width: "100%" }} disabled={settling} onClick={() => setSettleOpen(true)}>{t.settle}</button>) : null}
    <details className={styles.feeDetails}>
      <summary>{t.details}</summary>
      <dl className={styles.feeRows}>
        {estimate ? <div><dt>{t.gross}</dt><dd>{money(estimate.gross)}</dd></div> : null}
        {/* Zero lines are omitted; a confirmed total keeps its parts only when both are non-zero. */}
        {confirmedTotal ? <div className={styles.feeTotal}><dt>{t.confirmedTotal}</dt><dd>{money(confirmedTotal)}</dd></div> : null}
        {confirmed && fee.historicalConfirmedFee && fee.monthEndFee ? <>
          <div><dt>{t.historicalPart}</dt><dd>{money(fee.historicalConfirmedFee)}</dd></div>
          <div><dt>{t.monthEndPart}</dt><dd>{money(fee.monthEndFee)}</dd></div>
        </> : null}
        {fee.currentOutstanding ? <div><dt>{t.unconfirmed}</dt><dd>{money(fee.currentOutstanding)}</dd></div> : null}
        {estimate?.manualExpenseTotal ? <>
          <div className={styles.feeTotal}><dt>{t.manual} {manualIds}</dt><dd>{money(estimate.manualExpenseTotal)}</dd></div>
          {estimate.unrecognizedEstimate ? <div><dt>{t.unrecognized}</dt><dd>{money(estimate.unrecognizedEstimate)}</dd></div> : null}
        </> : null}
      </dl>
      {estimate?.manualExpenses.filter(row => row.memo).map(row => <p key={row.id} className={styles.hint}>#{row.id} {row.memo}</p>)}
    </details>
  </div>;
}

// Actual historical rates by sale month. Confirmed months only enter the sales-weighted average.
export function CardFeeHistory({ history, lang }: { history: CardFeeHistoryView; lang: Lang }) {
  const t = text[lang];
  const latestYear = history.months[0]?.month.slice(0, 4) ?? "";
  const label = (month: string) => monthLabel(month, lang, latestYear);
  const statusText = (row: CardFeeHistoryView["months"][number]) => row.status === "confirmed" ? t.statusConfirmed
    : row.status === "provisional" ? t.statusProvisional : row.status === "pending" ? t.statusPending
      : row.status === "open" ? t.statusOpen : t.statusPartial.replace("{n}", String(row.saleDays));
  return <div className={styles.feeHistory} aria-label={t.history}>
    <h3 className={styles.sectionTitle}>📈 {t.history}</h3>
    {history.confirmedCount === 0 || history.averageRate === null ? <p className={styles.empty}>{t.noHistory}</p>
      : <div className={styles.historyStats}>
        <article className={styles.miniCard}><span>{t.storeAverage}</span><strong>{percent(history.averageRate)}</strong><small className={styles.kpiNote}>{t.confirmedMonths.replace("{n}", String(history.confirmedCount))}</small></article>
        <article className={styles.miniCard}><span>{t.lowest}</span><strong>{history.lowest ? percent(history.lowest.rate) : "-"}</strong><small className={styles.kpiNote}>{history.lowest ? label(history.lowest.month) : ""}</small></article>
        <article className={styles.miniCard}><span>{t.highest}</span><strong>{history.highest ? percent(history.highest.rate) : "-"}</strong><small className={styles.kpiNote}>{history.highest ? label(history.highest.month) : ""}</small></article>
      </div>}
    {history.months.length ? <table className={styles.feeTable}>
      <thead><tr><th scope="col">{t.monthCol}</th><th scope="col">{t.rateCol}</th><th scope="col">{t.statusCol}</th></tr></thead>
      <tbody>{history.months.map(row => <tr key={row.month} className={row.status === "confirmed" ? undefined : styles.historyMuted}>
        <th scope="row">{label(row.month)}</th><td>{row.rate === null ? t.collecting : percent(row.rate)}</td><td>{statusText(row)}</td>
      </tr>)}</tbody>
    </table> : null}
    <p className={styles.hint}>{t.historyHint}</p>
  </div>;
}
