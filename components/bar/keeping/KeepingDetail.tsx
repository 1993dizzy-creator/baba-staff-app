"use client";
/* eslint-disable @next/next/no-img-element -- private signed URLs */
import { useRef, useState } from "react";
import ImagePreviewModal from "@/components/bar/ImagePreviewModal";
import KeepingActionModal, { type KeepingAction } from "@/components/bar/keeping/KeepingActionModal";
import { KeepingSourceBadge, KeepingStatusBadge } from "@/components/bar/keeping/KeepingBasics";
import KeepingRecentLogs from "@/components/bar/keeping/KeepingRecentLogs";
import { primaryButtonStyle, secondaryButtonStyle } from "@/components/bar/keeping/KeepingUi";
import type { BarKeeping, KeepingCapabilities } from "@/lib/bar/keeping-types";
import { formatBarDateTime } from "@/lib/bar/log-format";
import { keepingDetailText, keepingListText, keepingText } from "@/lib/text/bar-keeping";

type Props = { item: BarKeeping; capabilities: KeepingCapabilities; lang: "ko" | "vi"; back: string; onRefresh: () => Promise<void> };

export default function KeepingDetail({ item, capabilities, lang, onRefresh }: Props) {
  const t = keepingText[lang], listText = keepingListText[lang], detailText = keepingDetailText[lang];
  const [action, setAction] = useState<KeepingAction | null>(null), [preview, setPreview] = useState(false), [refreshKey, setRefreshKey] = useState(0);
  const actionRef = useRef<HTMLButtonElement>(null), photoRef = useRef<HTMLButtonElement>(null);
  const remainingWidth = Math.min(100, Math.max(0, Number.isFinite(item.remainingPercent) ? item.remainingPercent : 0));
  const canManagePhoto = capabilities.manage && (item.status === "active" || capabilities.editClosed);
  async function saved() { await onRefresh(); setRefreshKey(value => value + 1); }

  return <div style={{ padding: "0 0 20px" }}>
    {item.isExpired ? <div style={warning("#fee2e2", "#991b1b")}>{t.expiryPassed}</div> : item.isExpirySoon ? <div style={warning("#fef3c7", "#92400e")}>{t.expirySoon}</div> : null}
    <section style={{ border: "1px solid #dcdfe4", borderRadius: 18, background: "#fff", overflow: "hidden", boxShadow: "0 6px 20px rgba(0,0,0,.04)" }}>
      <div style={{ position: "relative", background: "#f3f4f6" }}>
        {item.imageUrl ? <button ref={photoRef} type="button" onClick={() => setPreview(true)} aria-label={detailText.photoView} style={{ width: "100%", padding: 0, border: 0, background: "transparent", cursor: "zoom-in" }}><img src={item.imageUrl} alt={`${item.customerName} ${item.liquorName}`} style={{ display: "block", width: "100%", height: "clamp(210px,66vw,290px)", objectFit: "contain" }} /></button> : <div style={{ height: 210, display: "grid", placeItems: "center", color: "#6b7280", fontSize: 12 }}>{lang === "vi" ? "Không có ảnh" : "사진 없음"}</div>}
        <div style={{ position: "absolute", top: 13, right: 13, zIndex: 1 }}><KeepingStatusBadge status={item.status} reason={item.closeReason} lang={lang} /></div>
        {canManagePhoto ? <button type="button" onClick={() => setAction("replace_photo")} style={{ position: "absolute", left: 13, bottom: 13, zIndex: 1, padding: "7px 9px", border: 0, borderRadius: 999, background: "rgba(17,24,39,.78)", color: "#fff", display: "inline-flex", alignItems: "center", gap: 5, fontSize: 10, fontWeight: 700, cursor: "pointer" }}><CameraIcon />{detailText.photoChange}</button> : <div style={{ position: "absolute", left: 13, bottom: 13, zIndex: 1, padding: "5px 8px", borderRadius: 999, background: "rgba(17,24,39,.72)", color: "#fff", display: "inline-flex", alignItems: "center", gap: 5, fontSize: 10, fontWeight: 700, pointerEvents: "none" }}><CameraIcon />{detailText.photoView}</div>}
      </div>
      <div style={{ padding: 15 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ minWidth: 0, display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
            <h1 style={{ minWidth: 0, margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 18 }}>{item.customerName}</h1>
            <span style={{ flexShrink: 0, color: "#6b7280", fontSize: 11, whiteSpace: "nowrap" }}>{detailText.useCount(item.useCount)}</span>
          </div>
          <div style={{ minWidth: 0, marginTop: 4, display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, color: "#6b7280", fontSize: 12, lineHeight: 1.45 }}>
            {item.customerContact ? <div style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}><span>{detailText.contact}</span><strong> · {item.customerContact}</strong></div> : <span style={{ flex: 1 }} />}
            <div style={{ flexShrink: 0, whiteSpace: "nowrap", textAlign: "right" }}><span>{listText.zone}</span><strong style={{ color: "#4b5563" }}> · {item.zoneCode || "-"}</strong></div>
          </div>
          {item.customerIdentifier ? <div style={customerMeta}><span>{detailText.customerFeature}</span><strong> · {item.customerIdentifier}</strong></div> : null}
          <div style={{ minWidth: 0, width: "fit-content", maxWidth: "100%", marginTop: 10, display: "inline-flex", alignItems: "center", gap: 5, fontSize: 15, fontWeight: 700 }}>
            <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.liquorName}</span>
            {item.liquorSource ? <KeepingSourceBadge source={item.liquorSource} label={item.liquorSource === "inventory" ? listText.soldProduct : listText.outsideBottle} /> : null}
          </div>
        </div>
        <div style={{ marginTop: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 6, color: "#374151", fontSize: 12, fontWeight: 800 }}><span>{t.remaining}</span><strong style={{ whiteSpace: "nowrap" }}>{item.remainingPercent}%</strong></div>
          <div aria-hidden="true" style={{ height: 7, overflow: "hidden", borderRadius: 999, background: "#d1d5db" }}><div style={{ width: `${remainingWidth}%`, height: "100%", borderRadius: 999, background: "#10b981" }} /></div>
        </div>
        {capabilities.manage && item.status === "active" ? <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 12 }}><button ref={actionRef} onClick={() => setAction("use")} style={primaryButtonStyle}>{t.use}</button><button onClick={() => setAction("update")} style={secondaryButtonStyle}>{t.edit}</button></div> : null}
        {item.status === "closed" && capabilities.reactivate ? <div style={{ marginTop: 12 }}><button ref={actionRef} onClick={() => setAction("reactivate")} style={{ ...primaryButtonStyle, width: "100%" }}>{t.reactivate}</button></div> : null}
        <div style={{ marginTop: 16, padding: "12px 0", borderTop: "1px solid #e5e7eb", borderBottom: "1px solid #e5e7eb" }}>
          <h2 style={{ margin: "0 0 10px", fontSize: 13 }}>{item.status === "closed" ? (lang === "vi" ? "Thông tin kết thúc" : "종료 정보") : (lang === "vi" ? "Thông tin lưu giữ" : "보관 정보")}</h2>
          <dl style={{ display: "grid", gridTemplateColumns: "96px minmax(0,1fr)", gap: "8px 10px", margin: 0, fontSize: 12 }}><DT>{t.storedAt}</DT><DD>{date(item.storedAt, lang)}</DD><DT>{t.lastUsed}</DT><DD>{item.lastUsedAt ? formatBarDateTime(item.lastUsedAt, lang) : "-"}</DD><DT>{t.expiresAt}</DT><DD>{item.expiresAt ? date(item.expiresAt, lang) : "-"}</DD>{item.status === "closed" ? <><DT>{t.closeReason}</DT><DD>{reason(item.closeReason, t)}</DD><DT>{t.closedAt}</DT><DD>{item.closedAt ? formatBarDateTime(item.closedAt, lang) : "-"}</DD>{item.closeNote ? <><DT>{t.closeNote}</DT><DD>{item.closeNote}</DD></> : null}</> : null}{item.note ? <><DT>{t.note}</DT><DD pre>{item.note}</DD></> : null}</dl>
        </div>
        <KeepingRecentLogs id={item.id} lang={lang} refreshKey={refreshKey} />
      </div>
    </section>
    {preview && item.imageUrl ? <ImagePreviewModal src={item.imageUrl} alt={`${item.customerName} ${item.liquorName}`} closeLabel={t.cancel} onClose={() => setPreview(false)} returnFocusRef={photoRef} /> : null}
    {action ? <KeepingActionModal item={item} action={action} lang={lang} onClose={() => setAction(null)} onSaved={saved} returnFocusRef={actionRef} /> : null}
  </div>;
}

const customerMeta: React.CSSProperties = { marginTop: 4, color: "#6b7280", fontSize: 12, lineHeight: 1.45, overflowWrap: "anywhere" };
function DT({ children }: { children: React.ReactNode }) { return <dt style={{ color: "#6b7280", fontWeight: 700 }}>{children}</dt>; }
function DD({ children, pre = false }: { children: React.ReactNode; pre?: boolean }) { return <dd style={{ margin: 0, whiteSpace: pre ? "pre-wrap" : undefined, overflowWrap: "anywhere" }}>{children}</dd>; }
const warning = (background: string, color: string): React.CSSProperties => ({ marginBottom: 8, padding: "9px 11px", borderRadius: 9, background, color, fontSize: 12, fontWeight: 800 });
function date(value: string, lang: "ko" | "vi") { return new Intl.DateTimeFormat(lang === "vi" ? "vi-VN" : "ko-KR", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(`${value.slice(0, 10)}T00:00:00+07:00`)); }
function reason(value: BarKeeping["closeReason"], t: typeof keepingText.ko | typeof keepingText.vi) { return value === "finished" ? t.finished : value === "returned" ? t.returned : value === "discarded" ? t.discarded : value === "expired" ? t.expiredReason : t.other; }
function CameraIcon() { return <svg aria-hidden width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M4 7h3l1.5-2h7L17 7h3v12H4V7Z" stroke="currentColor" strokeWidth="1.8" /><circle cx="12" cy="13" r="3.5" stroke="currentColor" strokeWidth="1.8" /></svg>; }
