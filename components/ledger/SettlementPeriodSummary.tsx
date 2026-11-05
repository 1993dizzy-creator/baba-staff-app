"use client";

import { useId, useState } from "react";
import type { SettlementPeriod, SettlementPolicyValue } from "@/lib/ledger/settlement-periods";
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
export default function SettlementPeriodSummary({ lang, policy, periods }: { lang: "ko" | "vi"; policy: SettlementPolicyValue | null | undefined; periods: SettlementPeriod[] | null | undefined }) {
  const vi = lang === "vi";
  const [open, setOpen] = useState(false);
  const listId = useId();
  const term = policy ? formatPartnerSettlementTerm(policy, lang) : null;
  if (!term) return null;
  const t = vi
    ? { range: "giao dịch", undated: "Mua không rõ ngày", reference: "chốt", periods: (n: number) => `${n} kỳ còn nợ`, detail: "Chi tiết", hide: "Thu gọn", paid: "đã trả", remaining: "còn", note: "Ngày chốt là mốc tổng hợp sổ sách." }
    : { range: "거래분", undated: "날짜 없는 매입", reference: "기준일", periods: (n: number) => `미지급 정산기간 ${n}개`, detail: "상세", hide: "접기", paid: "지급", remaining: "잔여", note: "기준일은 장부 집계 기준입니다." };
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
      {list.map(period => <li key={period.key}>
        <span>{label(period)}{period.referenceDate ? ` · ${t.reference} ${withWeekday(period.referenceDate, lang)}` : ""}</span>
        <b>{period.paidAmount > 0 ? `${t.paid} ${money(period.paidAmount)} · ` : ""}{t.remaining} {money(period.remainingAmount)}</b>
      </li>)}
      <li className={styles.note}>{t.note}</li>
    </ul> : null}
  </section>;
}
