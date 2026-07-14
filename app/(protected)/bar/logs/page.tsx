"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { handleBarApiUnauthorized } from "@/lib/bar/client-auth";
import type { BarActivityLog } from "@/lib/bar/types";
import { useLanguage } from "@/lib/language-context";
import { barText } from "@/lib/text/bar";
import { ui } from "@/lib/styles/ui";

export default function BarLogsPage() {
  const { lang } = useLanguage();
  const t = barText[lang];
  const [logs, setLogs] = useState<BarActivityLog[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const inFlightRef = useRef(false);

  const load = useCallback(async (cursor: string | null, append: boolean) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setLoading(true); setError("");
    try {
      const query = new URLSearchParams({ pageSize: "20" });
      if (cursor) query.set("cursor", cursor);
      const response = await fetch(`/api/bar/logs?${query}`, { cache: "no-store" });
      if (await handleBarApiUnauthorized(response)) return;
      if (!response.ok) throw new Error(t.logsLoadError);
      const result = await response.json();
      setLogs((current) => append ? [...current, ...(result.logs ?? [])] : result.logs ?? []);
      setNextCursor(result.nextCursor ?? null); setHasMore(Boolean(result.hasMore));
    } catch (caught) { setError(caught instanceof Error ? caught.message : t.logsLoadError); }
    finally { inFlightRef.current = false; setLoading(false); }
  }, [t.logsLoadError]);

  useEffect(() => { void load(null, false); }, [load]);
  return <div style={{ padding: "12px 0 20px" }}>
    <h1 style={{ margin: 0, fontSize: 26, color: "#111827" }}>{t.logsTitle}</h1>
    <p style={{ margin: "8px 0 16px", color: "#6b7280", fontSize: 14 }}>{t.logsDescription}</p>
    {error ? <section role="alert" style={{ ...ui.card, padding: 18, color: "#b91c1c" }}>{error}</section> : null}
    {!error && !loading && logs.length === 0 ? <section style={{ ...ui.card, padding: 24, textAlign: "center", color: "#6b7280" }}>{t.logsEmpty}</section> : null}
    <div style={{ display: "grid", gap: 10 }}>{logs.map((log) => <article key={log.id} style={{ ...ui.card, padding: 14 }}><div style={{ display: "flex", justifyContent: "space-between", gap: 10, color: "#6b7280", fontSize: 12 }}><strong style={{ color: "#374151" }}>{log.actorName}</strong><time dateTime={log.createdAt}>{new Intl.DateTimeFormat(lang === "vi" ? "vi-VN" : "ko-KR", { dateStyle: "short", timeStyle: "short" }).format(new Date(log.createdAt))}</time></div><p style={{ margin: "8px 0 0", color: "#111827", lineHeight: 1.5 }}>{summarize(log, lang)}</p></article>)}</div>
    {loading ? <p aria-live="polite" style={{ textAlign: "center", color: "#6b7280" }}>…</p> : null}
    {hasMore && nextCursor && !loading ? <button type="button" onClick={() => void load(nextCursor, true)} style={{ ...ui.subButton, minHeight: 46, marginTop: 12 }}>{t.loadMore}</button> : null}
  </div>;
}

function summarize(log: BarActivityLog, lang: "ko" | "vi") {
  const target = log.entityCode || (log.entityType === "staff_profile" ? `#${log.entityId}` : "BAR");
  const ko: Record<string, string> = { zone_content_updated: `${target} 비고를 수정했습니다.`, zone_assignee_assigned: `${target} 담당자를 지정했습니다.`, zone_assignee_changed: `${target} 담당자를 변경했습니다.`, zone_assignee_removed: `${target} 담당자를 해제했습니다.`, staff_color_changed: `${target} 담당 색상을 변경했습니다.`, zone_photo_added: `${target} 사진을 등록했습니다.`, zone_photo_replaced: `${target} 사진을 교체했습니다.`, zone_photo_removed: `${target} 사진을 삭제했습니다.` };
  const vi: Record<string, string> = { zone_content_updated: `Đã sửa ghi chú ${target}.`, zone_assignee_assigned: `Đã chỉ định người phụ trách ${target}.`, zone_assignee_changed: `Đã đổi người phụ trách ${target}.`, zone_assignee_removed: `Đã bỏ người phụ trách ${target}.`, staff_color_changed: `Đã đổi màu phụ trách ${target}.`, zone_photo_added: `Đã thêm ảnh ${target}.`, zone_photo_replaced: `Đã thay ảnh ${target}.`, zone_photo_removed: `Đã xóa ảnh ${target}.` };
  return (lang === "vi" ? vi : ko)[log.actionType] ?? (lang === "vi" ? `Đã thay đổi ${target}.` : `${target} 정보를 변경했습니다.`);
}
