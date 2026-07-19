"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import BarLogEntry from "@/components/bar/BarLogEntry";
import { fetchBarApi, handleBarApiUnauthorized } from "@/lib/bar/client-auth";
import type { BarActivityLog } from "@/lib/bar/types";
import { ui } from "@/lib/styles/ui";

export default function BarZoneOverviewLogs({ lang, text }: { lang: "ko" | "vi"; text: { title: string; loading: string; empty: string; error: string; retry: string; viewAll: string } }) {
  const [logs, setLogs] = useState<BarActivityLog[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState("");
  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true); setError("");
    try {
      const response = await fetchBarApi("/api/bar/logs?entityType=zone&limit=5", { cache: "no-store", signal });
      if (await handleBarApiUnauthorized(response)) return;
      if (!response.ok) throw new Error(text.error);
      setLogs((await response.json()).logs ?? []);
    } catch (caught) {
      if (!(caught instanceof DOMException && caught.name === "AbortError")) setError(caught instanceof Error ? caught.message : text.error);
    } finally { if (!signal?.aborted) setLoading(false); }
  }, [text.error]);
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [load]);

  return <section style={{ ...ui.card, marginTop: 8, padding: 12 }}>
    <h2 style={{ margin: "0 0 5px", color: "#1f2937", fontSize: 13, fontWeight: 800 }}>{text.title}</h2>
    {loading ? <p role="status" aria-live="polite" style={stateStyle}>{text.loading}</p> : null}
    {error ? <p role="alert" style={{ ...stateStyle, color: "#b91c1c" }}>{error} <button type="button" onClick={() => void load()} style={retryStyle}>{text.retry}</button></p> : null}
    {!loading && !error && logs.length === 0 ? <p style={stateStyle}>{text.empty}</p> : null}
    {!loading && !error ? logs.map(log => <BarLogEntry key={log.id} log={log} lang={lang} compact />) : null}
    {!loading && !error ? <Link href="/bar/logs?entityType=zone" style={{ display: "inline-block", marginTop: 8, color: "#4b5563", fontSize: 11, fontWeight: 800, textDecoration: "underline", textUnderlineOffset: 2 }}>{text.viewAll}</Link> : null}
  </section>;
}

const stateStyle: React.CSSProperties = { margin: "10px 0", color: "#6b7280", fontSize: 12, textAlign: "center" };
const retryStyle: React.CSSProperties = { marginLeft: 5, border: 0, padding: 0, background: "transparent", color: "inherit", font: "inherit", fontWeight: 800, textDecoration: "underline" };
