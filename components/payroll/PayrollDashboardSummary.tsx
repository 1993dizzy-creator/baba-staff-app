"use client";

import type { CSSProperties } from "react";
import {
  PAYROLL_DASHBOARD_FILTERS,
  type PayrollDashboardFilter,
} from "@/lib/payroll/payroll-dashboard";

const text = {
  ko: {
    title: "이번 달 급여 현황",
    target: "급여 대상",
    calculable: "계산 가능",
    review: "확인 필요",
    paid: "지급완료",
    people: "명",
    filterLabel: "직원 필터",
    filters: { all: "전체", review: "확인 필요", unpaid: "미지급", paid: "지급완료" },
  },
  vi: {
    title: "Tình hình lương tháng này",
    target: "Nhân viên tính lương",
    calculable: "Tính được",
    review: "Cần kiểm tra",
    paid: "Đã trả",
    people: "người",
    filterLabel: "Lọc nhân viên",
    filters: { all: "Tất cả", review: "Cần kiểm tra", unpaid: "Chưa trả", paid: "Đã trả" },
  },
} as const;

export function PayrollDashboardSummary({
  summary,
  lang,
}: {
  summary: { target: number; calculable: number; review: number; paid: number };
  lang: "ko" | "vi";
}) {
  const t = text[lang];
  const tiles = [
    { key: "target", label: t.target, value: summary.target, tone: s.toneNeutral },
    { key: "calculable", label: t.calculable, value: summary.calculable, tone: s.toneOk },
    { key: "review", label: t.review, value: summary.review, tone: summary.review > 0 ? s.toneWarn : s.toneNeutral },
    { key: "paid", label: t.paid, value: summary.paid, tone: s.tonePaid },
  ];
  return (
    <section style={s.summary} aria-label={t.title}>
      {tiles.map((tile) => (
        <div key={tile.key} style={{ ...s.tile, ...tile.tone }}>
          <span style={s.tileLabel}>{tile.label}</span>
          <b style={s.tileValue}>
            {tile.value}
            <small style={s.tileUnit}>{lang === "vi" ? ` ${t.people}` : t.people}</small>
          </b>
        </div>
      ))}
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
  return (
    <div style={s.filters} role="group" aria-label={t.filterLabel}>
      {PAYROLL_DASHBOARD_FILTERS.map((filter) => {
        const active = value === filter;
        return (
          <button
            key={filter}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(filter)}
            style={{ ...s.filter, ...(active ? s.filterActive : {}) }}
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
  summary: { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(132px,1fr))", gap: 8, minWidth: 0 },
  tile: { display: "grid", gap: 2, minWidth: 0, padding: "10px 12px", borderRadius: 12, border: "1px solid #e5e7eb", background: "#fff" },
  tileLabel: { fontSize: 11.5, fontWeight: 700, color: "#64748b", overflowWrap: "anywhere" },
  tileValue: { fontSize: 22, lineHeight: 1.15, fontWeight: 900, color: "#0f172a", fontVariantNumeric: "tabular-nums" },
  tileUnit: { marginLeft: 2, fontSize: 12, fontWeight: 700, color: "#64748b" },
  toneNeutral: {},
  toneOk: { borderColor: "#bbf7d0", background: "#f0fdf4" },
  toneWarn: { borderColor: "#fde68a", background: "#fffbeb" },
  tonePaid: { borderColor: "#bfdbfe", background: "#eff6ff" },
  filters: { display: "flex", flexWrap: "wrap", gap: 6, minWidth: 0 },
  filter: { display: "inline-flex", alignItems: "center", gap: 6, flexShrink: 0, minHeight: 34, padding: "6px 12px", borderRadius: 999, border: "1px solid #d1d5db", background: "#fff", color: "#334155", fontSize: 12.5, fontWeight: 800 },
  filterActive: { borderColor: "#1d4ed8", background: "#1d4ed8", color: "#fff" },
  filterCount: { minWidth: 18, padding: "0 6px", borderRadius: 999, background: "#f1f5f9", color: "#475569", fontSize: 11, lineHeight: "18px", textAlign: "center", fontVariantNumeric: "tabular-nums" },
  filterCountActive: { background: "rgba(255,255,255,.22)", color: "#fff" },
} satisfies Record<string, CSSProperties>;
