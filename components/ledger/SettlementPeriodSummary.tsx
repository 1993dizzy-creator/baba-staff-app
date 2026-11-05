"use client";

import { useId, useState } from "react";
import { settlementCarriedFromMonth, type SettlementPeriod, type SettlementPolicyValue } from "@/lib/ledger/settlement-periods";
import { formatPartnerSettlementTerm } from "@/lib/partners/text";
import styles from "./SettlementPeriodSummary.module.css";

const WEEKDAYS = { ko: ["일", "월", "화", "수", "목", "금", "토"], vi: ["CN", "T2", "T3", "T4", "T5", "T6", "T7"] } as const;
// Same display rounding as the ledger entries page.
const money = (value: number) => `${new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 }).format(Math.round(value))} ₫`;
const shortDate = (date: string) => { const [, month, day] = date.split("-").map(Number); return `${month}/${day}`; };
const withWeekday = (date: string, lang: "ko" | "vi") => `${shortDate(date)}(${WEEKDAYS[lang][new Date(`${date}T00:00:00Z`).getUTCDay()]})`;

// Read-only, compact: one line (wrapping to at most two) with the settlement term and, for a
// single open period, its range and 정산 기준일. Several periods open a small detail list on
// demand. No badges, no repeated totals, no payment actions; the 정산 기준일 is a ledger
// grouping reference and is never presented as an actual payment or overdue date.
export default function SettlementPeriodSummary({ lang, policy, periods, viewMonth = "", onSelectPeriod }: { lang: "ko" | "vi"; policy: SettlementPolicyValue | null | undefined; periods: SettlementPeriod[] | null | undefined; viewMonth?: string; onSelectPeriod?: (key: string) => void }) {
  const vi = lang === "vi";
  const [open, setOpen] = useState(false);
  const listId = useId();
  const term = policy ? formatPartnerSettlementTerm(policy, lang) : null;
  if (!term) return null;
  const t = vi
    ? { range: "giao dịch", undated: "Mua không rõ ngày", reference: "chốt", periods: (n: number) => `${n} kỳ còn nợ`, detail: "Chi tiết", hide: "Thu gọn", count: (n: number) => `${n} khoản`, carried: (month: string) => `gồm nợ T${Number(month.slice(5))}`, go: "Đến nhóm ngày" }
    : { range: "거래분", undated: "날짜 없는 매입", reference: "기준일", periods: (n: number) => `미지급 정산기간 ${n}개`, detail: "상세", hide: "접기", count: (n: number) => `${n}건`, carried: (month: string) => `${Number(month.slice(5))}월 이월 포함`, go: "날짜 목록으로 이동" };
  const label = (period: SettlementPeriod) => period.kind === "undated" ? t.undated : `${shortDate(period.start!)}~${shortDate(period.end!)} ${t.range}`;
  const list = periods ?? [];
  const single = list.length === 1 ? list[0] : null;
  const summary = [term, single ? label(single) : list.length > 1 ? t.periods(list.length) : null,
    single?.referenceDate ? `${t.reference} ${withWeekday(single.referenceDate, lang)}` : null].filter(Boolean).join(" · ");
  return <section className={styles.block} data-testid="settlement-period-summary">
    <div className={styles.line}>
      <span className={styles.summary}><span aria-hidden="true">📅 </span>{summary}</span>
      {list.length > 1 ? <button type="button" className={styles.toggle} aria-expanded={open} aria-controls={listId} onClick={() => setOpen(value => !value)}>{open ? t.hide : t.detail}<i aria-hidden="true">{open ? "⌄" : "›"}</i></button> : null}
    </div>
    {open && list.length > 1 ? <ul id={listId} className={styles.list}>
      {list.map(period => {
        const carried = settlementCarriedFromMonth(period, viewMonth);
        // One compact row per period: 기간 (+이월) / 기준일 · 건수 / 잔여 미지급. Clicking moves to that date group.
        const body = <>
          <span className={styles.rowMain}>
            <strong>{label(period)}</strong>
            <small>{[period.referenceDate ? `${t.reference} ${withWeekday(period.referenceDate, lang)}` : null, t.count(period.payableCount), carried ? t.carried(carried) : null].filter(Boolean).join(" · ")}</small>
          </span>
          <b className={styles.rowAmount}>{money(period.remainingAmount)}</b>
          {onSelectPeriod ? <i aria-hidden="true">›</i> : null}
        </>;
        return <li key={period.key} className={carried ? styles.carried : undefined}>
          {onSelectPeriod ? <button type="button" className={styles.row} aria-label={`${label(period)} · ${t.go}`} onClick={() => onSelectPeriod(period.key)}>{body}</button> : <div className={styles.row}>{body}</div>}
        </li>;
      })}
    </ul> : null}
  </section>;
}
