"use client";

import type { CSSProperties } from "react";
import {
  PAYROLL_DASHBOARD_FILTERS,
  type PayrollDashboardFilter,
} from "@/lib/payroll/payroll-dashboard";

const text = {
  ko: {
    title: "급여지급현황",
    filterLabel: "직원 필터",
    filters: { all: "전체", review: "확인 필요", unpaid: "미지급" },
  },
  vi: {
    title: "Tình hình chi trả lương",
    filterLabel: "Lọc nhân viên",
    filters: { all: "Tất cả", review: "Cần kiểm tra", unpaid: "Chưa trả" },
  },
} as const;

export function PayrollDashboardSummary({
  summary,
  paymentBatch,
  lang,
}: {
  summary: { target: number };
  paymentBatch?: { target_employee_count: number; paid_employee_count: number } | null;
  lang: "ko" | "vi";
}) {
  const t = text[lang];
  return (
    <section style={s.summary} aria-label={t.title}>
      <b style={s.summaryCount}>{paymentBatch?.paid_employee_count ?? 0}/{paymentBatch?.target_employee_count ?? summary.target}</b>
      <span>{t.title}</span>
    </section>
  );
}

export function PayrollDashboardFilters({
  value,
  counts,
  lang,
  onChange,
}: {
  value: PayrollDashboardFilter;
  counts: Record<PayrollDashboardFilter, number>;
  lang: "ko" | "vi";
  onChange: (filter: PayrollDashboardFilter) => void;
}) {
  const t = text[lang];
  const filters = PAYROLL_DASHBOARD_FILTERS.filter(filter => filter !== "paid");
  return (
    <div style={s.filters} role="group" aria-label={t.filterLabel}>
      {filters.map((filter, index) => {
        const active = value === filter;
        return (
          <button
            key={filter}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(filter)}
            style={{ ...s.filter, marginLeft: index === 0 ? "auto" : 0, marginRight: index === filters.length - 1 ? "auto" : 0, ...(active ? s.filterActive : {}) }}
          >
            <span>{t.filters[filter]}</span>
            <span style={{ ...s.filterCount, ...(active ? s.filterCountActive : {}) }}>{counts[filter]}</span>
          </button>
        );
      })}
    </div>
  );
}

const s = {
  summary: { display: "flex", justifyContent: "center", alignItems: "baseline", gap: 6, minWidth: 0, fontSize: 12, lineHeight: 1.4, whiteSpace: "nowrap", color: "#475569" },
  summaryCount: { fontWeight: 800, fontVariantNumeric: "tabular-nums", color: "#111827" },
  filters: { display: "flex", flexWrap: "nowrap", overflowX: "auto", WebkitOverflowScrolling: "touch", scrollSnapType: "x proximity", gap: 6, minWidth: 0, maxWidth: "100%", paddingBottom: 2 },
  filter: { display: "inline-flex", alignItems: "center", gap: 6, flex: "0 0 auto", whiteSpace: "nowrap", scrollSnapAlign: "start", minHeight: 34, padding: "6px 12px", borderRadius: 999, borderWidth: 1, borderStyle: "solid", borderColor: "#d1d5db", background: "#f9fafb", color: "#334155", fontSize: 12.5, fontWeight: 800 },
  filterActive: { borderColor: "#111827", background: "#111827", color: "#fff" },
  filterCount: { minWidth: 18, padding: "0 6px", borderRadius: 999, background: "#f1f5f9", color: "#475569", fontSize: 11, lineHeight: "18px", textAlign: "center", fontVariantNumeric: "tabular-nums" },
  filterCountActive: { background: "rgba(255,255,255,.22)", color: "#fff" },
} satisfies Record<string, CSSProperties>;
