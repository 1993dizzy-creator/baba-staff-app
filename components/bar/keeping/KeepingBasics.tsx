"use client";
/* eslint-disable @next/next/no-img-element -- private signed thumbnail URLs */
import Link from "next/link";
import type { BarKeepingListItem } from "@/lib/bar/keeping-types";
import type { KeepingCloseReason, KeepingStatus } from "@/lib/bar/keeping";
import { keepingRemainingDays } from "@/lib/bar/keeping";
import { keepingListText, keepingText } from "@/lib/text/bar-keeping";

export function KeepingStatusBadge({ status, reason, lang }: { status: KeepingStatus; reason: KeepingCloseReason | null; lang: "ko" | "vi" }) {
  const t = keepingText[lang];
  const label = status === "active" ? t.active : reason === "finished" ? t.finished : reason === "returned" ? t.returned : reason === "discarded" ? t.discarded : reason === "expired" ? t.expiredReason : t.other;
  return <span style={{ flexShrink: 0, padding: "4px 8px", borderRadius: 999, background: status === "active" ? "#dcfce7" : "#f3f4f6", color: status === "active" ? "#166534" : "#374151", fontSize: 10, fontWeight: 800 }}>{label}</span>;
}

export function KeepingListCard({ item, lang, href }: { item: BarKeepingListItem; lang: "ko" | "vi"; href: string }) {
  const t = keepingText[lang];
  const listText = keepingListText[lang];
  const period = item.status === "closed" ? closedLabel(item.closedAt, lang) : remainingLabel(item.expiresAt, lang);
  return (
    <Link href={href} style={{ minHeight: 102, padding: 11, border: "1px solid #dcdfe4", borderRadius: 16, background: "#fff", boxShadow: "0 4px 14px rgba(0,0,0,.035)", display: "flex", gap: 11, color: "inherit", textDecoration: "none" }}>
      <div style={{ width: 64, height: 78, flex: "0 0 auto", borderRadius: 10, overflow: "hidden", background: "#f3f4f6", display: "grid", placeItems: "center" }}>
        {item.thumbnailUrl ? <img src={item.thumbnailUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <span style={{ color: "#9ca3af", fontSize: 11 }}>{lang === "vi" ? "Không ảnh" : "사진 없음"}</span>}
      </div>
      <div style={{ minWidth: 0, flex: 1, display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", gap: 8 }}>
        <div style={{ minWidth: 0, display: "flex", flexDirection: "column", alignItems: "stretch" }}>
          <div style={{ minWidth: 0, display: "flex", alignItems: "baseline", gap: 4 }}>
            <strong style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 15 }}>{item.customerName}</strong>
            <span style={{ flexShrink: 0, color: "#6b7280", fontSize: 10, whiteSpace: "nowrap" }}>· {lang === "vi" ? `Dùng ${item.useCount} lần` : `사용 ${item.useCount}회`}</span>
          </div>
          <div style={{ minWidth: 0, width: "fit-content", maxWidth: "100%", marginTop: 2, display: "inline-flex", alignItems: "center", gap: 5, fontSize: 13 }}>
            <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.liquorName}</span>
            {item.liquorSource ? <KeepingSourceBadge source={item.liquorSource} label={item.liquorSource === "inventory" ? listText.soldProduct : listText.outsideBottle} /> : null}
          </div>
          <div style={{ marginTop: 2, minWidth: 0, color: "#6b7280", fontSize: 10, lineHeight: "14px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            <span>{listText.zone}</span><span style={{ color: "#4b5563", fontWeight: 700 }}> · {item.zoneCode || "-"}</span>
          </div>
          <span style={{ marginTop: "auto", color: "#6b7280", fontSize: 10, lineHeight: "14px", whiteSpace: "nowrap" }}>{t.storedAt} {shortDate(item.storedAt, lang)}</span>
        </div>
        <div style={{ minWidth: 68, flexShrink: 0, display: "flex", flexDirection: "column", alignItems: "flex-end", justifyContent: "space-between", textAlign: "right" }}>
          <KeepingStatusBadge status={item.status} reason={item.closeReason} lang={lang} />
          <strong style={{ fontSize: 14 }}>{item.remainingPercent}%</strong>
          <span style={{ color: item.status === "active" && item.expiresAt && keepingRemainingDays(item.expiresAt) < 0 ? "#b91c1c" : "#6b7280", fontSize: 10, fontWeight: 700, whiteSpace: "nowrap" }}>{period}</span>
        </div>
      </div>
    </Link>
  );
}

export function KeepingSourceBadge({ source, label }: { source: "inventory" | "external"; label: string }) {
  return <span style={{ height: 18, padding: "0 5px", borderRadius: 999, background: source === "inventory" ? "#eff6ff" : "#fff7ed", color: source === "inventory" ? "#3b5f8a" : "#9a5b24", display: "inline-flex", alignItems: "center", flexShrink: 0, fontSize: 10, fontWeight: 700, lineHeight: 1, whiteSpace: "nowrap" }}>{label}</span>;
}

function remainingLabel(expiresAt: string | null, lang: "ko" | "vi") {
  if (!expiresAt) return "-";
  const days = keepingRemainingDays(expiresAt);
  if (days > 0) return lang === "vi" ? `Còn ${days} ngày` : `${days}일 남음`;
  if (days === 0) return lang === "vi" ? "Hết hạn hôm nay" : "오늘 만료";
  return lang === "vi" ? `Quá ${Math.abs(days)} ngày` : `${Math.abs(days)}일 지남`;
}

function closedLabel(closedAt: string | null, lang: "ko" | "vi") {
  if (!closedAt) return "-";
  return `${lang === "vi" ? "Kết thúc" : "종료"} ${shortDate(closedAt, lang)}`;
}

function shortDate(value: string, lang: "ko" | "vi") {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Ho_Chi_Minh", month: "2-digit", day: "2-digit" }).formatToParts(new Date(value.length === 10 ? `${value}T00:00:00+07:00` : value));
  const month = parts.find((part) => part.type === "month")?.value ?? "";
  const day = parts.find((part) => part.type === "day")?.value ?? "";
  return lang === "vi" ? `${day}/${month}` : `${month}.${day}.`;
}

export function KeepingSkeleton() {
  return <div aria-hidden style={{ minHeight: 102, padding: 11, border: "1px solid #e5e7eb", borderRadius: 16, display: "flex", gap: 11 }}><div style={{ width: 64, height: 78, borderRadius: 10, background: "#e5e7eb" }} /><div style={{ flex: 1, display: "grid", gap: 8, alignContent: "center" }}>{["60%", "85%", "48%"].map((width) => <div key={width} style={{ height: 11, width, borderRadius: 6, background: "#e5e7eb" }} />)}</div></div>;
}
