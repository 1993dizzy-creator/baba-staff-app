"use client";

import type { CSSProperties } from "react";
import type { OpenOrderKpi } from "@/lib/pos/cukcuk/open-orders-core";

export type OpenOrdersPanelText = {
  openOrdersTitle: string;
  openOrdersAmount: string;
  openOrdersCount: string;
  openOrdersLines: string;
  provisionalTotal: string;
  provisionalAverage: string;
  uncertainOrders: string;
  openOrdersIncomplete: string;
  openOrdersUnavailable: string;
  openOrdersStale: string;
  openOrdersClosed: string;
  lastCheckedAt: string;
  noRecentCheck: string;
  openOrdersNote: string;
  receiptCountSuffix: string;
  itemCountSuffix: string;
};

const vnd = (value: number) =>
  new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 }).format(value);

const time = (value: string | null) =>
  value
    ? new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(value))
    : null;

/**
 * Open-order estimate beside (never inside) the paid KPIs. Hidden until the central
 * read is enabled; when data is missing or late it shows a warning and the last good
 * check time instead of 0₫.
 */
export default function OpenOrdersPanel({ data, text }: { data: OpenOrderKpi | undefined; text: OpenOrdersPanelText }) {
  if (!data || data.status === "not_enabled") return null;
  const checked = time(data.lastSuccessAt);
  const checkedLine = `${text.lastCheckedAt}: ${checked ?? text.noRecentCheck}`;

  if (data.status === "closed") {
    return <section style={card}><p style={muted}>{text.openOrdersClosed}</p></section>;
  }
  if (data.status !== "ok" || !data.open || !data.provisional) {
    return (
      <section role="alert" style={warningCard}>
        <strong>{data.status === "stale" ? text.openOrdersStale : text.openOrdersUnavailable}</strong>
        <span>{checkedLine}</span>
      </section>
    );
  }

  const items = [
    { label: text.openOrdersAmount, value: vnd(data.open.amount) },
    { label: text.openOrdersCount, value: `${data.open.orderCount}${text.receiptCountSuffix}` },
    { label: text.openOrdersLines, value: `${data.open.menuLineCount}${text.itemCountSuffix}` },
    { label: text.provisionalTotal, value: vnd(data.provisional.amount) },
    { label: text.provisionalAverage, value: vnd(data.provisional.averageAmount) },
  ];
  return (
    <section style={card} aria-label={text.openOrdersTitle}>
      <div style={header}>
        <h2 style={title}>{text.openOrdersTitle}</h2>
        <span style={muted}>{checkedLine}</span>
      </div>
      <div style={grid}>
        {items.map((item) => (
          <div key={item.label} style={cell}>
            <span style={muted}>{item.label}</span>
            <strong style={value}>{item.value}</strong>
          </div>
        ))}
      </div>
      {!data.complete ? (
        <p role="alert" style={warningText}>
          {text.openOrdersIncomplete}
          {data.uncertain && data.uncertain.orderCount > 0
            ? ` · ${text.uncertainOrders} ${data.uncertain.orderCount}${text.receiptCountSuffix} · ${vnd(data.uncertain.amount)}`
            : ""}
        </p>
      ) : null}
      <p style={muted}>{text.openOrdersNote}</p>
    </section>
  );
}

const card: CSSProperties = { display: "flex", flexDirection: "column", gap: 8, padding: 14, borderRadius: 16, border: "1px solid #e5e7eb", background: "#ffffff" };
const warningCard: CSSProperties = { display: "flex", flexDirection: "column", gap: 4, padding: "10px 12px", borderRadius: 12, border: "1px solid #fcd34d", background: "#fffbeb", color: "#92400e", fontSize: 12, lineHeight: 1.45, fontWeight: 600 };
const header: CSSProperties = { display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "baseline", gap: 6 };
const title: CSSProperties = { margin: 0, fontSize: 15, fontWeight: 800, color: "#111827" };
// auto-fit keeps two columns on phones and one row on PC without horizontal scroll.
const grid: CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 8 };
const cell: CSSProperties = { display: "flex", flexDirection: "column", gap: 2, minWidth: 0, padding: "8px 10px", borderRadius: 12, background: "#f9fafb" };
const value: CSSProperties = { fontSize: 15, fontWeight: 800, color: "#111827", overflowWrap: "anywhere" };
const muted: CSSProperties = { margin: 0, fontSize: 12, color: "#6b7280", lineHeight: 1.45 };
const warningText: CSSProperties = { margin: 0, fontSize: 12, color: "#92400e", fontWeight: 700 };
