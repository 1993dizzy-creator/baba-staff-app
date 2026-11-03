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
    review: "확인 필요",
    paid: "지급완료",
    people: "명",
    filterLabel: "직원 필터",
    filters: { all: "전체", review: "확인 필요", unpaid: "미지급", paid: "지급완료" },
  },
  vi: {
    title: "Tình hình lương tháng này",
    target: "Nhân viên tính lương",
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
  summary: { display: "grid", gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: 5, minWidth: 0 },
  tile: { display: "flex", flexDirection: "column", gap: 2, minWidth: 0, padding: "5px 7px", borderRadius: 9, borderWidth: 1, borderStyle: "solid", borderColor: "#e5e7eb", background: "#fff" },
  tileLabel: { fontSize: 10, lineHeight: 1.25, fontWeight: 700, color: "#64748b", overflowWrap: "anywhere" },
  tileValue: { marginTop: "auto", fontSize: 17, lineHeight: 1.15, fontWeight: 900, color: "#0f172a", fontVariantNumeric: "tabular-nums" },
  tileUnit: { marginLeft: 2, fontSize: 10.5, fontWeight: 700, color: "#64748b" },
  toneNeutral: {},
  toneWarn: { borderColor: "#fde68a", background: "#fffbeb" },
  tonePaid: { borderColor: "#bfdbfe", background: "#eff6ff" },
  filters: { display: "flex", flexWrap: "nowrap", overflowX: "auto", WebkitOverflowScrolling: "touch", scrollSnapType: "x proximity", gap: 6, minWidth: 0, maxWidth: "100%", paddingBottom: 2 },
  filter: { display: "inline-flex", alignItems: "center", gap: 6, flex: "0 0 auto", whiteSpace: "nowrap", scrollSnapAlign: "start", minHeight: 34, padding: "6px 12px", borderRadius: 999, borderWidth: 1, borderStyle: "solid", borderColor: "#d1d5db", background: "#f9fafb", color: "#334155", fontSize: 12.5, fontWeight: 800 },
  filterActive: { borderColor: "#111827", background: "#111827", color: "#fff" },
  filterCount: { minWidth: 18, padding: "0 6px", borderRadius: 999, background: "#f1f5f9", color: "#475569", fontSize: 11, lineHeight: "18px", textAlign: "center", fontVariantNumeric: "tabular-nums" },
  filterCountActive: { background: "rgba(255,255,255,.22)", color: "#fff" },
} satisfies Record<string, CSSProperties>;
