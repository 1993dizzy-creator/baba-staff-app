"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { KeepingListCard, KeepingSkeleton } from "@/components/bar/keeping/KeepingBasics";
import { primaryButtonStyle, secondaryButtonStyle } from "@/components/bar/keeping/KeepingUi";
import type { BarKeepingListItem } from "@/lib/bar/keeping-types";
import { handleBarApiUnauthorized } from "@/lib/bar/client-auth";
import { useLanguage } from "@/lib/language-context";
import { keepingText } from "@/lib/text/bar-keeping";
import { keepingNewText } from "@/lib/text/bar-keeping-new";
import { ui } from "@/lib/styles/ui";

type Result = { items: BarKeepingListItem[]; hasMore: boolean; nextCursor: string | null; capabilities: { manage: boolean } };

export default function BarKeepingPage() {
  const { lang } = useLanguage();
  const t = keepingText[lang];
  const nt = keepingNewText[lang];
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const queryKey = params.toString();
  const [items, setItems] = useState<BarKeepingListItem[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [initialized, setInitialized] = useState(false);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState("");
  const [manage, setManage] = useState(false);
  const [counts, setCounts] = useState({ active: 0, closed: 0 });
  const [search, setSearch] = useState(params.get("q") ?? "");
  const status = params.get("status") === "closed" ? "closed" : "active";
  const sort = params.get("sort") === "old_activity" ? "old_activity" : "recent_activity";
  const zone = params.get("zone");

  const replace = useCallback((changes: Record<string, string | null>) => {
    const nextParams = new URLSearchParams(params.toString());
    Object.entries(changes).forEach(([key, value]) => value ? nextParams.set(key, value) : nextParams.delete(key));
    const query = nextParams.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [params, pathname, router]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (search.trim() !== (params.get("q") ?? "")) replace({ q: search.trim() || null });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [params, replace, search]);

  const load = useCallback(async (cursor: string | undefined, signal?: AbortSignal) => {
    if (cursor) setMore(true); else setLoading(true);
    setError("");
    try {
      const requestParams = new URLSearchParams(queryKey);
      requestParams.set("sort", sort);
      if (cursor) requestParams.set("cursor", cursor);
      const response = await fetch(`/api/bar/keepings?${requestParams}`, { cache: "no-store", signal });
      if (await handleBarApiUnauthorized(response)) return;
      if (!response.ok) throw new Error(t.error);
      const result = await response.json() as Result;
      setItems((current) => cursor ? [...current, ...result.items] : result.items);
      setNext(result.hasMore ? result.nextCursor : null);
      setManage(result.capabilities.manage);
    } catch (caught) {
      if (!(caught instanceof DOMException && caught.name === "AbortError")) setError(caught instanceof Error ? caught.message : t.error);
    } finally {
      if (!signal?.aborted) {
        setLoading(false);
        setMore(false);
        setInitialized(true);
      }
    }
  }, [queryKey, sort, t.error]);

  useEffect(() => {
    const controller = new AbortController();
    void load(undefined, controller.signal);
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/bar/keepings/counts", { cache: "no-store", signal: controller.signal })
      .then(async (response) => { if (await handleBarApiUnauthorized(response)) return null; if (!response.ok) throw new Error(t.error); return response.json(); })
      .then((result) => { if (result?.counts) setCounts({ active: Number(result.counts.active) || 0, closed: Number(result.counts.closed) || 0 }); })
      .catch((caught) => { if (!controller.signal.aborted) console.warn("[KEEPING_COUNTS_CLIENT_ERROR]", caught); });
    return () => controller.abort();
  }, [t.error]);

  const initialLoading = !initialized && loading;
  const empty = initialized && !loading && !error && items.length === 0;
  const detailSuffix = useMemo(() => queryKey ? `?from=${encodeURIComponent(`/bar/keeping?${queryKey}`)}` : "", [queryKey]);
  const hasSearchOrZone = Boolean(params.get("q") || zone);

  return (
    <div className="bar-keeping-page" style={{ minWidth: 0, display: "flex", flexDirection: "column" }}>
      <style>{`@media (max-width:800px){.bar-keeping-page{height:calc(100vh - 160px - env(safe-area-inset-top));height:calc(100dvh - 160px - env(safe-area-inset-top));overflow:hidden}.bar-keeping-scroll{min-height:0;flex:1;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;padding-bottom:calc(8px + env(safe-area-inset-bottom))}}`}</style>
      <div style={{ position: "relative", marginBottom: 8 }}>
        <span aria-hidden="true" style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", fontSize: 16, color: "#9ca3af", pointerEvents: "none" }}>🔍</span>
        <input type="text" value={search} onChange={(event) => setSearch(event.target.value)} aria-label={nt.searchPlaceholder} placeholder={nt.searchPlaceholder} style={{ ...ui.input, paddingLeft: 40, paddingRight: search ? 40 : 14, marginBottom: 0 }} />
        {search ? <button type="button" aria-label={t.reset} onClick={() => setSearch("")} style={{ position: "absolute", right: 1, top: 1, width: 42, height: 42, border: 0, background: "transparent", color: "#6b7280", fontSize: 18 }}>×</button> : null}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 104px", alignItems: "stretch", gap: 8, marginBottom: 8 }}>
        <div role="tablist" aria-label={lang === "vi" ? "Trạng thái" : "보관 상태"} style={{ ...ui.card, padding: 4, marginBottom: 0, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
          <button type="button" role="tab" aria-selected={status === "active"} aria-label={lang === "vi" ? `${counts.active} chai đang được lưu giữ` : `보관 중 키핑 ${counts.active}건`} onClick={() => replace({ status: "active", closeReason: null })} style={statusButton(status === "active")}><span>{t.active}</span><CountBadge count={counts.active} active={status === "active"} /></button>
          <button type="button" role="tab" aria-selected={status === "closed"} aria-label={lang === "vi" ? `${counts.closed} chai đã kết thúc lưu giữ` : `종료 키핑 ${counts.closed}건`} onClick={() => replace({ status: "closed" })} style={statusButton(status === "closed")}><span>{t.closed}</span><CountBadge count={counts.closed} active={status === "closed"} /></button>
        </div>
        <select aria-label={lang === "vi" ? "Sắp xếp" : "정렬"} value={sort} onChange={(event) => replace({ sort: event.target.value })} style={{ width: "100%", minWidth: 0, minHeight: 44, padding: "0 7px", border: "1px solid #d1d5db", borderRadius: 10, background: "#fff", color: "#4b5563", fontSize: 12, fontWeight: 700 }}>
          <option value="recent_activity">{nt.recentSort}</option>
          <option value="old_activity">{nt.oldSort}</option>
        </select>
      </div>

      {zone ? <div style={{ minHeight: 34, marginBottom: 8, padding: "6px 9px", borderRadius: 8, background: "#f3f4f6", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, color: "#374151", fontSize: 12, fontWeight: 700 }}><span>{zone} {lang === "vi" ? "· khu vực" : "구역 키핑"}</span><button type="button" onClick={() => replace({ zone: null })} style={{ minHeight: 28, padding: "3px 8px", border: "1px solid #d1d5db", borderRadius: 7, background: "#fff", color: "#4b5563", fontSize: 11 }}>{lang === "vi" ? "Bỏ" : "해제"}</button></div> : null}

      {manage ? <Link href="/bar/keeping/new" style={{ ...primaryButtonStyle, display: "block", textAlign: "center", textDecoration: "none", marginBottom: 10, fontSize: 14, fontWeight: 700, letterSpacing: "-0.2px" }}>{t.newKeeping}</Link> : null}
      <div className="bar-keeping-scroll">
      {error ? <State message={error} action={<button onClick={() => void load(undefined)} style={secondaryButtonStyle}>{t.retry}</button>} /> : (
        <div aria-busy={loading} style={{ display: "grid", gap: 8 }}>
          {initialLoading ? [0, 1, 2, 3].map((index) => <KeepingSkeleton key={index} />) : initialized && loading ? <div role="status" aria-live="polite" style={{ minHeight: 150, display: "grid", placeItems: "center", color: "#6b7280", fontSize: 12, fontWeight: 700 }}><span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}><span aria-hidden="true" style={{ width: 16, height: 16, border: "2px solid #d1d5db", borderTopColor: "#374151", borderRadius: "50%", animation: "bar-keeping-spin .8s linear infinite" }} />{t.loading}</span><style>{`@keyframes bar-keeping-spin{to{transform:rotate(360deg)}}`}</style></div> : items.map((item) => <KeepingListCard key={item.id} item={item} lang={lang} href={`/bar/keeping/${item.id}${detailSuffix}`} />)}
        </div>
      )}
      {empty ? <State message={hasSearchOrZone ? t.noResults : status === "active" ? t.noActive : t.noClosed} action={hasSearchOrZone ? <button onClick={() => { setSearch(""); replace({ q: null, zone: null }); }} style={secondaryButtonStyle}>{t.reset}</button> : undefined} /> : null}
      {next ? <button disabled={more} onClick={() => void load(next)} style={{ ...secondaryButtonStyle, width: "100%", marginTop: 10 }}>{more ? t.loading : t.loadMore}</button> : null}
      </div>
    </div>
  );
}

function State({ message, action }: { message: string; action?: React.ReactNode }) {
  return <section style={{ padding: 20, border: "1px solid #e5e7eb", borderRadius: 16, textAlign: "center", color: "#6b7280", fontSize: 13 }}><p style={{ margin: action ? "0 0 10px" : 0 }}>{message}</p>{action}</section>;
}

function statusButton(active: boolean): React.CSSProperties {
  return { minWidth: 0, border: active ? "1px solid #93c5fd" : "1px solid transparent", borderRadius: 8, background: active ? "#eff6ff" : "transparent", color: active ? "#1d4ed8" : "#6b7280", padding: "8px 6px", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, fontSize: 13, fontWeight: 900, cursor: "pointer", boxShadow: active ? "0 1px 2px rgba(15, 23, 42, 0.08)" : "none", whiteSpace: "nowrap", overflow: "hidden" };
}

function CountBadge({ count, active }: { count: number; active: boolean }) {
  return <span aria-hidden="true" style={{ minWidth: 22, maxWidth: 48, height: 20, padding: "0 6px", borderRadius: 999, background: active ? "#dbeafe" : "#e5e7eb", color: active ? "#1d4ed8" : "#4b5563", display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0, fontSize: 10, fontWeight: 900, lineHeight: 1 }}>{count}</span>;
}
