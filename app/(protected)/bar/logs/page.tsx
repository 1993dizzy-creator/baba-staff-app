"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { handleBarApiUnauthorized } from "@/lib/bar/client-auth";
import { formatBarDateTime, formatBarLogSummary } from "@/lib/bar/log-format";
import type { BarActivityLog } from "@/lib/bar/types";
import { useLanguage } from "@/lib/language-context";
import { barText } from "@/lib/text/bar";
import { ui } from "@/lib/styles/ui";

export default function BarLogsPage() {
  const { lang } = useLanguage();
  const t = barText[lang];
  const searchParams = useSearchParams();
  const entityType = searchParams.get("entityType");
  const code = searchParams.get("code");
  const entityId = searchParams.get("id");
  const isZoneFilter = entityType === "zone" && Boolean(code);
  const isKeepingFilter = entityType === "keeping" && Boolean(entityId);
  const filterKey = `${entityType ?? ""}:${code ?? ""}:${entityId ?? ""}`;
  const [logs, setLogs] = useState<BarActivityLog[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const requestRef = useRef(0);

  const load = useCallback(async (cursor: string | null, append: boolean) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const requestId = ++requestRef.current;
    setLoading(true);
    setError("");
    try {
      const query = new URLSearchParams({ pageSize: "20" });
      if (cursor) query.set("cursor", cursor);
      if (entityType) query.set("entityType", entityType);
      if (code) query.set("code", code);
      if (entityId) query.set("id", entityId);
      const response = await fetch(`/api/bar/logs?${query}`, { cache: "no-store", signal: controller.signal });
      if (await handleBarApiUnauthorized(response)) return;
      if (!response.ok) throw new Error(t.logsLoadError);
      const result = await response.json();
      if (requestRef.current !== requestId) return;
      setLogs((current) => append ? [...current, ...(result.logs ?? [])] : result.logs ?? []);
      setNextCursor(result.nextCursor ?? null);
      setHasMore(Boolean(result.hasMore));
    } catch (caught) {
      if (controller.signal.aborted || requestRef.current !== requestId) return;
      setError(caught instanceof Error ? caught.message : t.logsLoadError);
    } finally {
      if (requestRef.current === requestId) setLoading(false);
    }
  }, [code, entityId, entityType, t.logsLoadError]);

  useEffect(() => {
    setLogs([]);
    setNextCursor(null);
    setHasMore(false);
    void load(null, false);
    return () => abortRef.current?.abort();
  }, [filterKey, load]);

  return <div style={{ padding: "12px 0 20px" }}>
    <h1 style={{ margin: 0, fontSize: 26, color: "#111827" }}>{t.logsTitle}</h1>
    <p style={{ margin: "8px 0 16px", color: "#6b7280", fontSize: 14 }}>{t.logsDescription}</p>
    {isZoneFilter ? (
      <div style={{ marginBottom: 12, padding: "9px 11px", border: "1px solid #dbeafe", borderRadius: 9, background: "#eff6ff", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, color: "#1e3a8a", fontSize: 12 }}>
        <strong>{lang === "vi" ? `${t.zoneLogsSuffix} ${code}` : `${code} ${t.zoneLogsSuffix}`}</strong>
        <Link href="/bar/logs" style={{ color: "#1d4ed8", fontWeight: 700, textDecoration: "none" }}>{t.allBarLogs}</Link>
      </div>
    ) : null}
    {isKeepingFilter ? (
      <div style={{ marginBottom: 12, padding: "9px 11px", border: "1px solid #dbeafe", borderRadius: 9, background: "#eff6ff", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, color: "#1e3a8a", fontSize: 12 }}>
        <strong>{lang === "vi" ? `Nhật ký giữ rượu #${entityId}` : `키핑 #${entityId} 기록`}</strong>
        <Link href="/bar/logs" style={{ color: "#1d4ed8", fontWeight: 700, textDecoration: "none" }}>{t.allBarLogs}</Link>
      </div>
    ) : null}
    {error ? <section role="alert" style={{ ...ui.card, padding: 18, color: "#b91c1c" }}>{error}</section> : null}
    {!error && !loading && logs.length === 0 ? <section style={{ ...ui.card, padding: 24, textAlign: "center", color: "#6b7280" }}>{t.logsEmpty}</section> : null}
    <div style={{ display: "grid", gap: 10 }}>
      {logs.map((log) => (
        <article key={log.id} style={{ ...ui.card, padding: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 10, color: "#6b7280", fontSize: 12 }}>
            <strong style={{ color: "#374151" }}>{log.actorName}</strong>
            <time dateTime={log.createdAt}>{formatBarDateTime(log.createdAt, lang)}</time>
          </div>
          <p style={{ margin: "8px 0 0", color: "#111827", lineHeight: 1.5 }}>{formatBarLogSummary(log, lang)}</p>
          {log.entityType === "keeping" ? <Link href={`/bar/keeping/${log.entityId}`} style={{ display: "inline-block", marginTop: 6, color: "#2563eb", fontSize: 12, fontWeight: 700, textDecoration: "none" }}>{log.entityCode}</Link> : null}
        </article>
      ))}
    </div>
    {loading ? <p aria-live="polite" style={{ textAlign: "center", color: "#6b7280" }}>…</p> : null}
    {hasMore && nextCursor && !loading ? <button type="button" onClick={() => void load(nextCursor, true)} style={{ ...ui.subButton, minHeight: 46, marginTop: 12 }}>{t.loadMore}</button> : null}
  </div>;
}
