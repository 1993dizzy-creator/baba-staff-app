"use client";

import type { CSSProperties } from "react";
import type { OpenOrderKpi } from "@/lib/pos/cukcuk/open-orders-core";

export type OpenOrdersPanelText = {
  openOrdersIncomplete: string;
  openOrdersDetailWarning: string;
  openOrdersUnavailable: string;
  openOrdersNotEnabled: string;
  openOrdersStale: string;
  openOrdersSyncIncomplete: string;
  overallScaleUnavailable: string;
  lastCheckedAt: string;
  noRecentCheck: string;
  openOrdersNote: string;
};

const time = (value: string | null | undefined) =>
  value && Number.isFinite(Date.parse(value))
    ? new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Ho_Chi_Minh", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(value))
    : null;

/** Sync/uncertainty notice for the four daily cards. No second set of KPI amounts or counts. */
export default function OpenOrdersPanel({ data, text, active = true }: {
  data: OpenOrderKpi | undefined;
  text: OpenOrdersPanelText;
  active?: boolean;
}) {
  if (!active || data?.status === "closed") return null;
  const checkedLine = `${text.lastCheckedAt}: ${time(data?.lastSuccessAt) ?? text.noRecentCheck}`;
  if (!data || data.status !== "ok" || !data.open || !data.provisional) {
    const warning = data?.status === "not_enabled" ? text.openOrdersNotEnabled
      : data?.status === "stale" ? text.openOrdersStale
        : data?.status === "incomplete" ? text.openOrdersSyncIncomplete : text.openOrdersUnavailable;
    return <section role="alert" style={warningCard}>
      <strong>{warning}</strong>
      <span>{text.overallScaleUnavailable}</span>
      <span>{checkedLine}</span>
    </section>;
  }
  return <section role={data.complete ? "status" : "alert"} style={data.complete ? note : warningCard}>
    {!data.complete ? <strong>{text.openOrdersIncomplete}</strong> : null}
    {data.detailWarnings && data.detailWarnings.length > 0 ? <span>{text.openOrdersDetailWarning}</span> : null}
    <span>{checkedLine} · {text.openOrdersNote}</span>
  </section>;
}

const note: CSSProperties = { display: "flex", flexDirection: "column", gap: 4, fontSize: 12, lineHeight: 1.45, color: "#6b7280", overflowWrap: "anywhere" };
const warningCard: CSSProperties = { ...note, padding: "10px 12px", borderRadius: 12, border: "1px solid #fcd34d", background: "#fffbeb", color: "#92400e", fontWeight: 600 };
