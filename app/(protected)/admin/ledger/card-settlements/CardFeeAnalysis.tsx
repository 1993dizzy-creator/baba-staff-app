"use client";
import type { ReactNode } from "react";
import styles from "./card-settlements.module.css";

// Unified card fee view for a past month: two KPIs (estimate, rate vs store average),
// compact status, and collapsed breakdown. CardFeeHistory shows actual historical rates
// by sale month. Read-only: nothing here books, confirms or cancels.
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
    estimated: "추정 수수료", confirmedKpi: "확정 수수료", rate: "추정 수수료율", confirmedRate: "확정 수수료율", storeAverage: "매장 평균", collecting: "집계 중",
    official: "공식 확정", auto: "자동", manualConfirm: "수동",
    provisional: "잠정 비용 처리", protected: "자동 중복 확정 보호", notOfficial: "공식 확정 미완료",
    closed: "장부 마감", beforeClose: "월마감 전", review: "확인 필요",
    duplicate: "수기 비용과 공식 확정이 겹칠 수 있습니다. 중복계상 여부를 확인하세요.",
    details: "세부 내역 · 수기 전표", gross: "월 카드매출", confirmedTotal: "확정 수수료", historicalPart: "└ 기존 확정", monthEndPart: "└ 월말 확정",
    unconfirmed: "미확정 추정(미정산 잔액)", manual: "수기 비용 전표", manualCovered: "└ 추정액 중 수기 처리분", unrecognized: "└ 남은 미반영 추정액",
    history: "역대 카드수수료율", lowest: "최저", highest: "최고", confirmedMonths: "확정 {n}개월 · 매출 가중",
    noHistory: "집계 중 · 아직 확정된 달이 없습니다.", monthCol: "매출월", rateCol: "수수료율", statusCol: "상태",
    statusConfirmed: "확정", statusProvisional: "잠정 · 평균 제외", statusPending: "확정 전", statusOpen: "월마감 전", statusPartial: "참고 · 카드매출 {n}일",
    historyHint: "카드매출 발생월 기준 · 확정된 달만 평균에 포함",
  },
  vi: {
    estimated: "Phí ước tính", confirmedKpi: "Phí đã xác nhận", rate: "Tỷ lệ phí ước tính", confirmedRate: "Tỷ lệ phí đã xác nhận", storeAverage: "TB cửa hàng", collecting: "Đang tổng hợp",
    official: "Đã xác nhận chính thức", auto: "Tự động", manualConfirm: "Thủ công",
    provisional: "Đã ghi chi phí tạm tính", protected: "Chặn xác nhận tự động trùng", notOfficial: "Chưa xác nhận chính thức",
    closed: "Đã chốt sổ", beforeClose: "Chưa chốt sổ", review: "Cần kiểm tra",
    duplicate: "Chi phí thủ công có thể trùng với xác nhận chính thức. Hãy kiểm tra ghi trùng.",
    details: "Chi tiết · Bút toán thủ công", gross: "Doanh thu thẻ tháng", confirmedTotal: "Phí đã xác nhận", historicalPart: "└ Đã xác nhận trước", monthEndPart: "└ Xác nhận cuối tháng",
    unconfirmed: "Ước tính chưa xác nhận (còn chưa quyết toán)", manual: "Bút toán chi phí thủ công", manualCovered: "└ Phần ước tính đã ghi thủ công", unrecognized: "└ Ước tính còn chưa ghi",
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

export default function CardFeeAnalysis({ fee, lang, notices = [], footer }: {
  fee: CardFeeView; lang: Lang; notices?: readonly string[]; footer?: ReactNode;
}) {
  const t = text[lang], estimate = fee.estimate;
  // KPI numbers are the existing API values; nothing is recalculated here.
  const confirmed = Boolean(fee.closure);
  const kpiAmount = estimate?.currentEstimate ?? (confirmed ? fee.finalConfirmedFee ?? 0 : fee.projectedTotalFee);
  const kpiRate = estimate ? estimate.rate : confirmed ? fee.confirmedRate : fee.remainingRate;
  const average = fee.feeHistory?.averageRate ?? null;
  const manualIds = estimate?.manualExpenses.map(row => `#${row.id}`).join(", ") ?? "";
  const chips: { label: string; tone: "ok" | "warn" | "muted" }[] = confirmed
    ? [{ label: `✅ ${t.official}`, tone: "ok" }, { label: fee.closure?.finalization_business_date ? t.auto : t.manualConfirm, tone: "muted" },
      { label: new Date(fee.closure!.confirmed_at).toLocaleDateString(lang === "vi" ? "vi-VN" : "ko-KR", { timeZone: "Asia/Ho_Chi_Minh" }), tone: "muted" }]
    : estimate?.provisionalManualOnly
      ? [{ label: `🧾 ${t.provisional} ${manualIds}`, tone: "warn" }, { label: `🛡️ ${t.protected}`, tone: "ok" }, { label: `⏳ ${t.notOfficial}`, tone: "muted" }]
      : [{ label: `⏳ ${t.notOfficial}`, tone: "muted" }, { label: fee.monthClosed ? `🔒 ${t.closed}` : t.beforeClose, tone: "muted" },
        ...(fee.autoStatus === "review_required" ? [{ label: t.review, tone: "warn" as const }] : [])];
  return <div className={styles.feeUnified}>
    <div className={styles.grid}>
      <article className={styles.miniCard}><span>{confirmed ? t.confirmedKpi : t.estimated}</span><strong>{money(kpiAmount)}</strong></article>
      <article className={styles.miniCard}><span>{confirmed ? t.confirmedRate : t.rate}</span><strong>{kpiRate == null ? "-" : percent(kpiRate)}</strong>
        <small className={styles.kpiNote}>{t.storeAverage} {average === null ? t.collecting : percent(average)}</small></article>
    </div>
    <p className={styles.chips}>{chips.map(chip => <span key={chip.label} className={chip.tone === "ok" ? styles.chipOk : chip.tone === "warn" ? styles.chipWarn : styles.chip}>{chip.label}</span>)}</p>
    {estimate?.duplicateRisk ? <p role="status" className={styles.validation}>{t.duplicate}</p> : null}
    {notices.map(notice => <p key={notice} role="status" className={styles.validation}>{notice}</p>)}
    {footer}
    <details className={styles.feeDetails}>
      <summary>{t.details}</summary>
      <dl className={styles.feeRows}>
        {estimate ? <div><dt>{t.gross}</dt><dd>{money(estimate.gross)}</dd></div> : null}
        <div className={styles.feeTotal}><dt>{t.confirmedTotal}</dt><dd>{money(confirmed ? fee.finalConfirmedFee ?? 0 : estimate?.confirmedFee ?? fee.historicalConfirmedFee)}</dd></div>
        <div><dt>{t.historicalPart}</dt><dd>{money(fee.historicalConfirmedFee)}</dd></div>
        {confirmed ? <div><dt>{t.monthEndPart}</dt><dd>{money(fee.monthEndFee)}</dd></div> : null}
        <div><dt>{t.unconfirmed}</dt><dd>{money(fee.currentOutstanding)}</dd></div>
        {estimate?.manualExpenseTotal ? <>
          <div className={styles.feeTotal}><dt>{t.manual} {manualIds}</dt><dd>{money(estimate.manualExpenseTotal)}</dd></div>
          <div><dt>{t.manualCovered}</dt><dd>{money(estimate.manualCoveredEstimate)}</dd></div>
          <div><dt>{t.unrecognized}</dt><dd>{money(estimate.unrecognizedEstimate)}</dd></div>
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
