"use client";
/* eslint-disable @next/next/no-img-element -- private signed thumbnail URLs */
import Link from "next/link";
import { useEffect, useState } from "react";
import { handleBarApiUnauthorized } from "@/lib/bar/client-auth";
import { keepingText } from "@/lib/text/bar-keeping";
import { keepingLiquorName } from "@/lib/bar/keeping-types";

type Item = { id: number; customerName: string; liquorName: string; liquorNameKo: string | null; liquorNameVi: string | null; liquorSource: "inventory" | "external" | null; remainingPercent: number; thumbnailUrl: string | null };
export default function ZoneKeepingSummary({ zoneCode, lang, refreshKey }: { zoneCode: string; lang: "ko" | "vi"; refreshKey: number }) {
  const t = keepingText[lang];
  const [items, setItems] = useState<Item[]>([]); const [total, setTotal] = useState(0); const [loading, setLoading] = useState(true); const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/bar/keepings/zone/${zoneCode}?refresh=${refreshKey}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => { if (await handleBarApiUnauthorized(response)) return null; if (!response.ok) throw new Error(t.error); return response.json(); })
      .then((result) => { if (result) { setItems(result.items ?? []); setTotal(result.total ?? 0); setError(""); } })
      .catch((caught) => { if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : t.error); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [refreshKey, t.error, zoneCode]);
  return <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid #e5e7eb" }}>
    <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center", fontSize: 12 }}><strong>{t.active} · {total}</strong><Link href={`/bar/keeping?status=active&zone=${encodeURIComponent(zoneCode)}`} style={link}>{t.all}</Link></div>
    {loading ? <p style={muted}>{t.loading}</p> : error ? <p role="alert" style={{ ...muted, color: "#b91c1c" }}>{error}</p> : items.length === 0 ? <p style={muted}>{t.noActive}</p> : <div tabIndex={0} aria-label={lang === "vi" ? `Danh sách ${total} chai đang giữ tại khu vực ${zoneCode}` : `${zoneCode} 구역 활성 키핑 ${total}건 목록`} style={{ marginTop: 7, maxHeight: 198, overflowY: "auto", overscrollBehavior: "contain", WebkitOverflowScrolling: "touch", scrollbarGutter: "stable" }}>
      {items.map((item) => <Link key={item.id} href={`/bar/keeping/${item.id}?from=${encodeURIComponent(`/bar/keeping?status=active&zone=${zoneCode}`)}`} style={{ display: "flex", alignItems: "center", gap: 9, padding: "7px 0", borderTop: "1px solid #f3f4f6", color: "inherit", textDecoration: "none" }}><div style={{ width: 44, height: 52, flex: "0 0 auto", borderRadius: 8, overflow: "hidden", background: "#f3f4f6" }}>{item.thumbnailUrl ? <img src={item.thumbnailUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : null}</div><div style={{ minWidth: 0, flex: 1 }}><div style={ellipsis}>{item.customerName}</div><div style={{ ...ellipsis, fontSize: 11, color: "#6b7280", fontWeight: 400 }}>{keepingLiquorName(item, lang)}</div></div><strong style={{ flexShrink: 0, fontSize: 12 }}>{item.remainingPercent}%</strong></Link>)}
    </div>}
  </div>;
}
const muted: React.CSSProperties = { margin: "8px 0 0", fontSize: 12, color: "#6b7280" };
const link: React.CSSProperties = { display: "inline-block", marginTop: 7, color: "#2563eb", fontSize: 12, fontWeight: 700, textDecoration: "none" };
const ellipsis: React.CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12, fontWeight: 700 };
