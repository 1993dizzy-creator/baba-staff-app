"use client";

import type { SettlementPeriod, SettlementPolicyValue } from "@/lib/ledger/settlement-periods";
import { formatPartnerSettlementTerm } from "@/lib/partners/text";
import styles from "./SettlementPeriodSummary.module.css";

const WEEKDAYS = { ko: ["일", "월", "화", "수", "목", "금", "토"], vi: ["CN", "T2", "T3", "T4", "T5", "T6", "T7"] } as const;
// Same display rounding as the ledger entries page.
const money = (value: number) => `${new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 }).format(Math.round(value))} ₫`;
const shortDate = (date: string) => { const [, month, day] = date.split("-").map(Number); return `${month}/${day}`; };
const withWeekday = (date: string, lang: "ko" | "vi") => `${shortDate(date)}(${WEEKDAYS[lang][new Date(`${date}T00:00:00Z`).getUTCDay()]})`;

// Read-only: settlement term + per-period 매입 원금 / 결제 배분 / 잔여 미지급, derived from the
// existing payables and allocations. The 정산 기준일 is shown apart from the latest actual
// payment date and never labelled overdue; payment actions stay in the existing sheet.
export default function SettlementPeriodSummary({ lang, policy, periods }: { lang: "ko" | "vi"; policy: SettlementPolicyValue | null | undefined; periods: SettlementPeriod[] | null | undefined }) {
  const vi = lang === "vi";
  const term = policy ? formatPartnerSettlementTerm(policy, lang) : null;
  if (!term) return null;
  const t = vi ? {
    title: "Theo kỳ thanh toán", term: "Điều kiện", purchase: "Mua", paid: "Đã trả", adjustment: "Điều chỉnh", remaining: "Còn lại", undated: "Mua không rõ ngày", range: "giao dịch",
    reference: "Ngày chốt", lastPaid: "Trả thực tế gần nhất", none: "Chưa có", fallback: "Điều kiện này không chia theo kỳ; xem danh sách bên dưới.", empty: "Không còn công nợ theo kỳ.",
    open: "Đang trong kỳ", settling: "Chờ đến ngày chốt", reference_passed: "Đã qua ngày chốt", count: "khoản",
    note: "Ngày chốt là mốc tổng hợp sổ sách, không phải ngày trả thực tế hay xác nhận quá hạn.",
  } : {
    title: "정산기간별 미납", term: "정산조건", purchase: "매입", paid: "지급", adjustment: "조정", remaining: "잔여", undated: "날짜 없는 매입", range: "거래분",
    reference: "정산 기준일", lastPaid: "최근 실제 지급", none: "없음", fallback: "이 정산조건은 기간별로 나누지 않습니다. 아래 기존 목록을 확인하세요.", empty: "정산기간별 남은 미지급이 없습니다.",
    open: "정산기간 진행 중", settling: "정산 기준일 전", reference_passed: "정산 기준일 지남", count: "건",
    note: "정산 기준일은 장부 집계 기준입니다. 실제 지급일이나 연체 확정이 아닙니다.",
  };
  return <section className={styles.block} aria-label={t.title} data-testid="settlement-period-summary">
    <p className={styles.term}><span>{t.term}</span><b>{term}</b></p>
    {periods == null ? <p className={styles.muted}>{t.fallback}</p>
      : periods.length === 0 ? <p className={styles.muted}>{t.empty}</p>
      : <ul className={styles.list}>{periods.map(period => {
        const status = period.position === "open" || period.position === "settling" || period.position === "reference_passed" ? t[period.position] : null;
        return <li key={period.key} className={styles.period}>
          <div className={styles.periodHead}>
            <strong>{period.kind === "undated" ? t.undated : `${shortDate(period.start!)}~${shortDate(period.end!)} ${t.range}`}</strong>
            <span className={styles.count}>{period.payableCount}{vi ? ` ${t.count}` : t.count}</span>
            {status ? <span className={`${styles.status} ${period.position === "reference_passed" ? styles.statusPassed : ""}`}>{status}</span> : null}
          </div>
          <dl className={styles.amounts}>
            <div><dt>{t.purchase}</dt><dd>{money(period.purchaseAmount)}</dd></div>
            <div><dt>{t.paid}</dt><dd>{money(period.paidAmount)}</dd></div>
            {period.adjustmentAmount !== 0 ? <div><dt>{t.adjustment}</dt><dd>{money(period.adjustmentAmount)}</dd></div> : null}
            <div className={styles.remaining}><dt>{t.remaining}</dt><dd>{money(period.remainingAmount)}</dd></div>
          </dl>
          <p className={styles.dates}>
            {period.referenceDate ? <span>{t.reference} {withWeekday(period.referenceDate, lang)}</span> : null}
            <span>{t.lastPaid} {period.lastPaymentDate ? shortDate(period.lastPaymentDate) : t.none}</span>
          </p>
        </li>;
      })}</ul>}
    <p className={styles.note}>{t.note}</p>
  </section>;
}
