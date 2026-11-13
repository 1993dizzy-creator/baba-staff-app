"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useLanguage } from "@/lib/language-context";
import { tablesText } from "@/lib/text/tables";
import type { TableOrder, TableOverview, TableState } from "@/lib/sales/table-overview";
import styles from "./tables.module.css";

const colors: Partial<Record<TableState, string>> = { occupied: "#22C55E", paid: "#3B82F6", reserved: "#A855F7" };
const money = (n: number) => new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 }).format(n);
const timestamp = (value: string | null | undefined, lang: string) => value && Number.isFinite(Date.parse(value))
  ? new Intl.DateTimeFormat(lang === "ko" ? "ko-KR" : "vi-VN", { timeZone: "Asia/Ho_Chi_Minh", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(value)) : "—";
const clock = (value: string | null | undefined) => value && Number.isFinite(Date.parse(value))
  ? new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(value)) : "—";

export default function TablesPage() {
  const { lang } = useLanguage();
  const t = tablesText[lang];
  const router = useRouter();
  const [data, setData] = useState<TableOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<{ kind: "table" | "order"; id: string } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const request = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    try {
      const response = await fetch("/api/tables", { cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]) });
      if (response.status === 401 || response.status === 403) {
        setData(null); setSelected(null); router.replace("/login"); return;
      }
      const result = await response.json();
      if (!response.ok || !result.ok || !result.overview) throw Error("unavailable");
      if (!controller.signal.aborted) { setData(result.overview); setFailed(false); }
    } catch {
      if (!controller.signal.aborted) { setData(null); setSelected(null); setFailed(true); }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [router]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 60_000);
    const visible = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", visible);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", visible); request.current?.abort(); };
  }, [load]);
  useEffect(() => {
    const el = dialog.current;
    if (!selected || !el) return;
    el.showModal();
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { el.close(); document.body.style.overflow = previous; };
  }, [selected]);

  const tile = selected?.kind === "table" ? data?.tables.find(item => item.id === selected.id) : null;
  const unlinked = selected?.kind === "order" ? data?.unlinked.find(item => item.id === selected.id) : null;
  const detailOrders = tile?.orders ?? (unlinked ? [unlinked] : []);
  const areaName = (key: string) => key === "bar" ? t.bar : key === "floor1" ? t.floor1 : key === "floor2" ? t.floor2 : key.replace(/^other:/, "");
  const areas = ["bar", "floor1", "floor2", ...new Set(data?.tables.filter(item => item.area.startsWith("other:")).map(item => item.area) ?? [])];
  const warningSummary = data && data.summary.unknown > 0 ? t.reviewCount.replace("{count}", String(data.summary.unknown))
    : data?.catalogStatus !== "ok" ? t.catalogCheck : data?.snapshotStatus !== "ok" ? t.ordersCheck : t.statusInfo;
  const orderView = (order: TableOrder) => <article key={order.id} className={styles.order}>
    <h3>{t.order} {order.number ?? "—"}</h3>
    <small className={styles.orderId}>OrderId: {order.id}</small>
    <p className={styles.muted}>{order.verifiedOpen ? t.occupied : t.historical}</p>
    <dl className={styles.facts}>
      <div><dt>{t.started}</dt><dd>{timestamp(order.startedAt, lang)}</dd></div>
      <div><dt>{t.collected}</dt><dd>{timestamp(order.collectedAt, lang)}</dd></div>
    </dl>
    {order.detailsNeedReview ? <p className={styles.notice}>{t.detailsReview}</p> : null}
    {order.lines ? <table className={styles.lines}><thead><tr><th>{t.menu}</th><th>{t.quantity}</th><th>{t.price}</th><th>{t.amount}</th></tr></thead>
      <tbody>{order.lines.map(line => <tr key={line.id}><td>{line.name || "—"}{line.option ? ` · ${t.option}` : ""}{line.canceled ? ` · ${t.canceled}` : ""}</td>
        <td>{line.quantity}</td><td>{money(line.price)}</td><td>{money(line.amount)}</td></tr>)}</tbody></table> : <p>{t.noLines}</p>}
    <p className={styles.estimate}>{t.estimate} <strong>{money(order.amount)}</strong></p>
  </article>;

  return <main className={styles.page}>
    <h1 className={styles.srOnly}>{t.title}</h1>
    <header className={styles.overviewBar}>
      <dl className={styles.summary} aria-label={t.title}>{(["total", "occupied", "unknown"] as const).map(key =>
        <div key={key}><dt>{t.summaryLabels[key]}</dt><dd>{data?.summary[key] ?? "—"}</dd></div>)}</dl>
      <button className={styles.refresh} onClick={() => void load()} disabled={loading} aria-label={t.refresh} title={t.refresh}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M20 7v5h-5M4 17v-5h5" /><path d="M6.1 6.1A8 8 0 0 1 20 12M4 12a8 8 0 0 0 13.9 5.9" />
        </svg>
      </button>
    </header>
    <p className={styles.timing}>
      <span>{t.shortDate} <time dateTime={data?.businessDate} title={data?.businessDate}>{data?.businessDate.slice(5).replace("-", "/") ?? "—"}</time></span>
      <span>{t.shortOrders} <time dateTime={data?.snapshotAt ?? undefined} title={timestamp(data?.snapshotAt, lang)}>{clock(data?.snapshotAt)}</time></span>
      <span>{t.shortTables} <time dateTime={data?.catalogAt ?? undefined} title={timestamp(data?.catalogAt, lang)}>{clock(data?.catalogAt)}</time></span>
    </p>
    {loading && !data ? <p role="status" className={styles.notice}>{t.loading}</p> : null}
    {failed ? <p role="alert" className={styles.notice}>{t.failed}</p> : null}
    {data ? <div role="status"><details className={styles.statusNotice}>
      <summary>{warningSummary}</summary>
      <div className={styles.statusDetails}>
        {data.catalogStatus !== "ok" ? <p>{t.noCatalog}</p> : null}
        {data.snapshotStatus !== "ok" ? <p>{t.delayed}</p> : null}
        <p>{t.unknownHelp}</p><p>{t.pendingVerification}</p>
        <p>{t.businessDate}: {data.businessDate}<br />{t.updated}: {timestamp(data.snapshotAt, lang)}<br />{t.catalogUpdated}: {timestamp(data.catalogAt, lang)}</p>
      </div>
    </details></div> : null}
    <div className={styles.legend}>{(["occupied", "paid", "reserved"] as const).map(state => <span key={state}>
      <i style={{ background: colors[state] }} aria-hidden="true" />{t[state]}</span>)}</div>
    <div className={styles.areas}>{areas.map(area => {
      const areaTables = data?.tables.filter(item => item.area === area) ?? [];
      return <section key={area} className={styles.area}>
      <div className={styles.areaHeader}><h2>{areaName(area)}</h2><span>{areaTables.length}{t.tableCountSuffix}</span></div>
      <div className={`${styles.tiles} ${area === "bar" ? styles.barTiles : ""}`}>{areaTables.map(item => <button key={item.id}
        className={`${styles.tile} ${item.state === "unknown" ? styles.unknown : ""}`}
        aria-label={`${item.name} · ${areaName(item.area)} · ${t[item.state]}`} onClick={() => setSelected({ kind: "table", id: item.id })}>
        {colors[item.state] ? <i className={styles.dot} style={{ background: colors[item.state] }} aria-hidden="true" /> : null}
        <strong>{item.name}</strong>
      </button>)}</div>
      {!areaTables.length ? <p className={styles.muted}>{t.noArea}</p> : null}
    </section>; })}</div>
    {data && data.unlinked.length > 0 ? <details className={styles.unlinked}><summary>{t.unlinked} ({data.unlinked.length})</summary>
      {data.unlinked.map(order => <button key={order.id} onClick={() => setSelected({ kind: "order", id: order.id })}>
        {order.tableName?.trim().toUpperCase() === "BAR" ? t.barUnlinked : order.tableName || t.unknown} · {t.order} {order.number ?? "—"}</button>)}
    </details> : null}
    <dialog ref={dialog} className={styles.sheet} aria-labelledby="table-detail-title" onCancel={() => setSelected(null)}>
      <header className={`${styles.header} ${styles.sheetHeader}`}><div className={styles.sheetTitle}><h2 id="table-detail-title">{tile?.name ?? unlinked?.tableName ?? t.details}</h2>
        {tile ? <span className={`${styles.stateBadge} ${tile.state === "unknown" ? styles.unknown : ""}`}>
          {colors[tile.state] ? <i style={{ background: colors[tile.state] }} aria-hidden="true" /> : null}{t[tile.state]}</span> : null}
      </div><button onClick={() => setSelected(null)}>{t.close}</button></header>
      {tile ? <><p>{areaName(tile.area)} · {t.orders}: {tile.orders.filter(order => order.verifiedOpen).length}</p>
        <p className={styles.muted}>{t.sourceArea}: {tile.areaName}</p></> : null}
      {!detailOrders.length ? <p className={styles.notice}>{t.noOrders}</p> : detailOrders.map(orderView)}
    </dialog>
  </main>;
}
