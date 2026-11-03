"use client";

import { payrollDashboardFilters, type PayrollDashboardFilter } from "@/lib/payroll/payroll-dashboard";
import styles from "./PayrollDashboard.module.css";

const text = {
  ko: {
    title: "급여 요약", target: "급여 대상", calculable: "계산 가능", review: "확인 필요", people: "명",
    progress: "지급 진행", filterLabel: "직원 필터",
    filters: { all: "전체", calculable: "계산 가능", review: "확인 필요", pending: "계산 대기", unpaid: "미지급", paid: "지급완료" },
  },
  vi: {
    title: "Tổng quan lương", target: "Nhân viên tính lương", calculable: "Tính được", review: "Cần kiểm tra", people: "người",
    progress: "Tiến độ chi trả", filterLabel: "Lọc nhân viên",
    filters: { all: "Tất cả", calculable: "Tính được", review: "Cần kiểm tra", pending: "Chờ tính", unpaid: "Chưa trả", paid: "Đã trả" },
  },
} as const;

export function PayrollDashboardSummary({ summary, lang, payable = false, progress }: {
  summary: { target: number; calculable: number; review: number; paid: number };
  lang: "ko" | "vi";
  payable?: boolean;
  progress?: { target_employee_count: number; paid_employee_count: number } | null;
}) {
  const t = text[lang];
  const total = progress?.target_employee_count ?? summary.target;
  const paid = progress?.paid_employee_count ?? summary.paid;
  return <section className={styles.summary} aria-label={t.title}>
    <div className={styles.summaryMetrics}>
      {(["target", "calculable", "review"] as const).map(key => <div className={styles.summaryMetric} key={key}>
        <span>{t[key]}</span><b className={key === "review" && summary.review > 0 ? styles.attention : undefined}>{summary[key]}<small> {t.people}</small></b>
      </div>)}
    </div>
    {payable && <div className={styles.progress}>
      <span>{t.progress}</span><progress aria-label={t.progress} max={total || 1} value={paid}/><b>{paid} / {total}</b>
    </div>}
  </section>;
}

export function PayrollDashboardFilters({ value, counts, lang, onChange, payable = false }: {
  value: PayrollDashboardFilter;
  counts: Record<PayrollDashboardFilter, number>;
  lang: "ko" | "vi";
  onChange: (filter: PayrollDashboardFilter) => void;
  payable?: boolean;
}) {
  const t = text[lang];
  return <div className={styles.filters} role="group" aria-label={t.filterLabel}>
    {payrollDashboardFilters(payable).map(filter => <button key={filter} type="button" aria-pressed={value === filter}
      onClick={() => onChange(filter)} className={styles.filter}>
      {t.filters[filter]}<span className={styles.filterCount}>{counts[filter]}</span>
    </button>)}
  </div>;
}
