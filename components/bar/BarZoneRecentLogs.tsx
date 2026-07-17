"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { handleBarApiUnauthorized } from "@/lib/bar/client-auth";
import { formatBarDateTime, formatBarLogSummary, getBarLogNote } from "@/lib/bar/log-format";
import type { BarActivityLog } from "@/lib/bar/types";

type Text = {
  recentLogs: string;
  recentLogsEmpty: string;
  recentLogsLoading: string;
  recentLogsError: string;
  retry: string;
  viewAllLogs: string;
};

export default function BarZoneRecentLogs({ zoneCode, lang, refreshKey, text }: {
  zoneCode: string;
  lang: "ko" | "vi";
  refreshKey: number;
  text: Text;
}) {
  const panelId = useId();
  const [expanded, setExpanded] = useState(false);
  const [logs, setLogs] = useState<BarActivityLog[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const cacheRef = useRef(new Map<string, BarActivityLog[]>());
  const requestRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const previousRefreshKeyRef = useRef(refreshKey);

  const load = useCallback(async (code: string, useCache: boolean) => {
    const cached = cacheRef.current.get(code);
    if (useCache && cached) {
      setLogs(cached);
      setError("");
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const requestId = ++requestRef.current;
    setLoading(true);
    setError("");
    try {
      const query = new URLSearchParams({ entityType: "zone", code, limit: "5" });
      const response = await fetch(`/api/bar/logs?${query}`, { cache: "no-store", signal: controller.signal });
      if (await handleBarApiUnauthorized(response)) return;
      if (!response.ok) throw new Error(text.recentLogsError);
      const result = await response.json();
      if (requestRef.current !== requestId) return;
      const nextLogs = (result.logs ?? []) as BarActivityLog[];
      cacheRef.current.set(code, nextLogs);
      setLogs(nextLogs);
    } catch (caught) {
      if (controller.signal.aborted || requestRef.current !== requestId) return;
      setError(caught instanceof Error ? caught.message : text.recentLogsError);
    } finally {
      if (requestRef.current === requestId) setLoading(false);
    }
  }, [text.recentLogsError]);

  useEffect(() => {
    abortRef.current?.abort();
    requestRef.current += 1;
    setLogs(cacheRef.current.get(zoneCode) ?? []);
    setError("");
    setLoading(false);
    if (expanded) void load(zoneCode, true);
  }, [expanded, load, zoneCode]);

  useEffect(() => {
    if (previousRefreshKeyRef.current === refreshKey) return;
    previousRefreshKeyRef.current = refreshKey;
    cacheRef.current.delete(zoneCode);
    if (expanded) void load(zoneCode, false);
  }, [expanded, load, refreshKey, zoneCode]);

  useEffect(() => () => abortRef.current?.abort(), []);

  return (
    <div style={{ marginTop: 14, borderTop: "1px solid #e5e7eb" }}>
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={() => setExpanded((current) => !current)}
        style={{ width: "100%", minHeight: 42, padding: "9px 2px", border: 0, background: "transparent", color: "#374151", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, fontSize: 12, fontWeight: 700, cursor: "pointer" }}
      >
        <span>{text.recentLogs}</span>
        <svg aria-hidden="true" width="15" height="15" viewBox="0 0 20 20" fill="none" style={{ transform: expanded ? "rotate(180deg)" : "none", transition: "transform 150ms ease" }}>
          <path d="m5 7.5 5 5 5-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {expanded ? (
        <div id={panelId} style={{ padding: "2px 2px 4px" }}>
          {loading ? <p aria-live="polite" style={{ margin: "8px 0", color: "#6b7280", fontSize: 12 }}>{text.recentLogsLoading}</p> : null}
          {error ? <div role="alert" style={{ margin: "8px 0", color: "#b91c1c", fontSize: 12 }}>{error} <button type="button" onClick={() => void load(zoneCode, false)} style={{ marginLeft: 6, border: 0, padding: 0, background: "transparent", color: "#b91c1c", font: "inherit", fontWeight: 700, textDecoration: "underline", cursor: "pointer" }}>{text.retry}</button></div> : null}
          {!loading && !error && logs.length === 0 ? <p style={{ margin: "8px 0", color: "#6b7280", fontSize: 12 }}>{text.recentLogsEmpty}</p> : null}
          {!error && logs.length > 0 ? (
            <div style={{ display: "grid" }}>
              {logs.map((log) => { const note = getBarLogNote(log); return <div key={log.id} style={{ padding: "9px 0", borderTop: "1px solid #f3f4f6" }}>
                <div style={{ color: "#374151", fontSize: 12, lineHeight: 1.5, overflowWrap: "anywhere" }}>{formatBarLogSummary(log, lang, { includeTarget: false })}</div>
                {note ? <div style={{ marginTop: 4, whiteSpace: "pre-wrap", overflowWrap: "anywhere", color: "#4b5563", fontSize: 11 }}><strong style={{ color: "#6b7280" }}>{lang === "vi" ? "Ghi chú" : "비고"}</strong> · {note}</div> : null}
                <div style={{ marginTop: 5, color: "#9ca3af", fontSize: 10, lineHeight: 1.4, textAlign: "right" }}>{log.actorName} · <time dateTime={log.createdAt}>{formatBarDateTime(log.createdAt, lang, true)}</time></div>
              </div>; })}
            </div>
          ) : null}
          {!loading && !error ? <Link href={`/bar/logs?entityType=zone&code=${encodeURIComponent(zoneCode)}`} style={{ display: "inline-block", marginTop: 7, color: "#2563eb", fontSize: 12, fontWeight: 700, textDecoration: "none" }}>{text.viewAllLogs}</Link> : null}
        </div>
      ) : null}
    </div>
  );
}
