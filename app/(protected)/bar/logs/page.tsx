"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import BarLogEntry from "@/components/bar/BarLogEntry";
import { fetchBarApi, handleBarApiUnauthorized } from "@/lib/bar/client-auth";
import type { BarActivityLog } from "@/lib/bar/types";
import { useLanguage } from "@/lib/language-context";
import { barText } from "@/lib/text/bar";
import { ui } from "@/lib/styles/ui";

type LogEntityType = "zone" | "keeping";

export default function BarLogsPage() {
  const { lang } = useLanguage();
  const t = barText[lang];
  const router = useRouter(), pathname = usePathname(), searchParams = useSearchParams();
  const entityType: LogEntityType = searchParams.get("entityType") === "keeping" ? "keeping" : "zone";
  const code = entityType === "zone" ? searchParams.get("code") : null;
  const entityId = entityType === "keeping" ? searchParams.get("id") : null;
  const actionType = searchParams.get("actionType");
  const isTargetFilter = Boolean(code || entityId);
  const filterKey = `${entityType}:${code ?? ""}:${entityId ?? ""}:${actionType ?? ""}`;
  const [logs, setLogs] = useState<BarActivityLog[]>([]), [nextCursor, setNextCursor] = useState<string | null>(null), [hasMore, setHasMore] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState("");
  const abortRef = useRef<AbortController | null>(null), requestRef = useRef(0);

  const changeTab = (nextType: LogEntityType) => {
    const next = new URLSearchParams();
    next.set("entityType", nextType);
    router.replace(`${pathname}?${next}`, { scroll: false });
  };
  const load = useCallback(async (cursor: string | null, append: boolean) => {
    abortRef.current?.abort(); const controller = new AbortController(); abortRef.current = controller; const requestId = ++requestRef.current;
    setLoading(true); setError("");
    try {
      const query = new URLSearchParams({ pageSize: "20", entityType });
      if (cursor) query.set("cursor", cursor); if (code) query.set("code", code); if (entityId) query.set("id", entityId); if (actionType) query.set("actionType", actionType);
      const response = await fetchBarApi(`/api/bar/logs?${query}`, { cache: "no-store", signal: controller.signal });
      if (await handleBarApiUnauthorized(response)) return; if (!response.ok) throw new Error(t.logsLoadError);
      const result = await response.json(); if (requestRef.current !== requestId) return;
      setLogs(current => append ? [...current, ...(result.logs ?? [])] : result.logs ?? []); setNextCursor(result.nextCursor ?? null); setHasMore(Boolean(result.hasMore));
    } catch (caught) { if (!controller.signal.aborted && requestRef.current === requestId) setError(caught instanceof Error ? caught.message : t.logsLoadError); }
    finally { if (requestRef.current === requestId) setLoading(false); }
  }, [actionType, code, entityId, entityType, t.logsLoadError]);

  useEffect(() => { setLogs([]); setNextCursor(null); setHasMore(false); void load(null, false); return () => abortRef.current?.abort(); }, [filterKey, load]);

  return <div style={{ padding: "2px 0 20px", minWidth: 0 }}>
    <div role="tablist" aria-label={lang === "vi" ? "Loại nhật ký" : "로그 유형"} style={{ ...ui.card, padding: 4, marginBottom: 8, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
      <button type="button" role="tab" aria-selected={entityType === "zone"} onClick={() => changeTab("zone")} style={tabStyle(entityType === "zone")}>{t.zoneTab}</button>
      <button type="button" role="tab" aria-selected={entityType === "keeping"} onClick={() => changeTab("keeping")} style={tabStyle(entityType === "keeping")}>{t.keepingTab}</button>
    </div>
    {isTargetFilter ? <div style={{ marginBottom: 8, padding: "7px 9px", borderRadius: 8, background: "#f3f4f6", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, color: "#374151", fontSize: 11 }}><strong>{code ? (lang === "vi" ? `${t.zoneLogsSuffix} ${code}` : `${code} ${t.zoneLogsSuffix}`) : (lang === "vi" ? `Nhật ký giữ rượu #${entityId}` : `키핑 #${entityId} 기록`)}</strong><Link href={`/bar/logs?entityType=${entityType}`} style={{ color: "#4b5563", fontWeight: 800, textDecoration: "underline", textUnderlineOffset: 2 }}>{t.viewAllLogs}</Link></div> : null}
    {error ? <section role="alert" style={{ ...ui.card, padding: 14, color: "#b91c1c", fontSize: 12 }}>{error} <button type="button" onClick={() => void load(null, false)} style={{ marginLeft: 6, border: 0, background: "transparent", color: "inherit", fontWeight: 800, textDecoration: "underline" }}>{t.retry}</button></section> : null}
    {!error && !loading && logs.length === 0 ? <section style={{ ...ui.card, padding: 20, textAlign: "center", color: "#6b7280", fontSize: 12 }}>{t.logsEmpty}</section> : null}
    {!error ? <div aria-busy={loading} style={{ display: "grid", gap: 8 }}>{logs.map(log => <BarLogEntry key={log.id} log={log} lang={lang} />)}</div> : null}
    {loading ? <div role="status" aria-live="polite" style={{ minHeight: logs.length ? 52 : 120, display: "grid", placeItems: "center", color: "#6b7280", fontSize: 12 }}>{t.recentLogsLoading}</div> : null}
    {hasMore && nextCursor && !loading ? <button type="button" onClick={() => void load(nextCursor, true)} style={{ ...ui.subButton, minHeight: 44, marginTop: 10 }}>{t.loadMore}</button> : null}
  </div>;
}

function tabStyle(active: boolean): React.CSSProperties { return { minHeight: 36, border: active ? "1px solid #93c5fd" : "1px solid transparent", borderRadius: 8, background: active ? "#eff6ff" : "transparent", color: active ? "#1d4ed8" : "#6b7280", fontSize: 13, fontWeight: 900, cursor: "pointer" }; }
