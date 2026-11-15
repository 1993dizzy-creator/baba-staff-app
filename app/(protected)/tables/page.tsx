"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useLanguage } from "@/lib/language-context";
import { tablesText } from "@/lib/text/tables";
import type { TableOrder, TableOverview, TableState } from "@/lib/sales/table-overview";
import type { DetailReceipt, TableDetail } from "@/lib/sales/table-detail";
import styles from "./tables.module.css";

// One class per state colors the whole tile, the legend swatch and the sheet badge alike.
// Idle (and any never-produced state) stays white: color is not a vacancy claim.
const stateClass: Partial<Record<TableState, string>> = {
  occupied: styles.occupied, paid: styles.paid, reserved: styles.reserved, unknown: styles.unknown,
};
const cx = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(" ");
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
  const [detailResult, setDetailResult] = useState<{ key: string; detail: TableDetail | null; failed: boolean } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const backdropPress = useRef(false);
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
    el.scrollTop = 0;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { el.close(); document.body.style.overflow = previous; };
  }, [selected]);

  useEffect(() => {
    if (selected?.kind !== "table" || !data) return;
    const controller = new AbortController();
    const key = `${selected.id}:${data.serverNow}`;
    void (async () => {
      try {
        const response = await fetch(`/api/tables/${encodeURIComponent(selected.id)}/detail`, {
          cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]),
        });
        if (controller.signal.aborted) return;
        if (response.status === 401 || response.status === 403) { setSelected(null); router.replace("/login"); return; }
        const result = await response.json();
        if (!response.ok || !result.ok || !result.detail || result.detail.table?.id !== selected.id) throw Error("detail_unavailable");
        if (!controller.signal.aborted) setDetailResult({ key, detail: result.detail, failed: false });
      } catch {
        if (!controller.signal.aborted) setDetailResult({ key, detail: null, failed: true });
      }
    })();
    return () => controller.abort();
  }, [selected, data, router]);

  const detail = selected?.kind === "table" && detailResult?.key === `${selected.id}:${data?.serverNow}` ? detailResult.detail : null;
  const detailFailed = selected?.kind === "table" && detailResult?.key === `${selected.id}:${data?.serverNow}` && detailResult.failed;
  const tile = detail?.table ?? (selected?.kind === "table" ? data?.tables.find(item => item.id === selected.id) : null);
  const unlinked = selected?.kind === "order" ? data?.unlinked.find(item => item.id === selected.id) : null;
  const detailOrders = tile?.orders ?? (unlinked ? [unlinked] : []);
  const currentOrders = detailOrders.filter(order => order.verifiedOpen);
  const retainedOrders = detailOrders.filter(order => !order.verifiedOpen);
  const cleaningReason = tile?.state === "occupied" || currentOrders.length ? t.cleaningReasons.active_orders
    : tile?.state === "unknown" ? t.cleaningReasons.snapshot_unhealthy
    : detail ? t.cleaningReasons[detail.cleaning.reason] : detailFailed ? t.historyFailed : t.historyLoading;
  const areaName = (key: string) => key === "bar" ? t.bar : key === "floor1" ? t.floor1 : key === "floor2" ? t.floor2 : key.replace(/^other:/, "");
  const areas = ["bar", "floor1", "floor2", ...new Set(data?.tables.filter(item => item.area.startsWith("other:")).map(item => item.area) ?? [])];
  const diagnostic = data ? data.catalogStatus !== "ok" ? t.unavailable
    : data.snapshotStatus === "waiting" ? t.waiting
    : data.snapshotStatus !== "ok" ? t.unavailable
    : data.summary.unknown > 0 || data.unlinkedReceiptCount > 0 ? t.partial : null : null;
  // The basis is the last successful order collection that decided the states, never the browser clock.
  const basisWarning = failed || !!data && (data.catalogStatus !== "ok" || !["ok", "waiting"].includes(data.snapshotStatus));
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
  const receiptView = (receipt: DetailReceipt) => <article key={receipt.id} className={styles.receipt}>
    <div className={styles.receiptHeading}><strong>{t.receiptNumber} #{receipt.number ?? receipt.id}</strong>
      <span>{receipt.canceled ? t.canceledPayment : receipt.validPaid ? t.validPayment : t.reviewPayment}
        {receipt.reissued ? ` · ${t.reissuedPayment}` : ""}{receipt.link !== "direct" ? ` · ${t.mergedPayment}` : ""}</span></div>
    <p className={styles.estimate}>{t.finalPaid} <strong>{receipt.amount === null ? "—" : money(receipt.amount)}</strong></p>
    <dl className={styles.facts}>
      <div><dt>{t.receiptBasis}</dt><dd>{timestamp(receipt.referenceAt, lang)}</dd></div>
      <div><dt>{t.businessDate}</dt><dd>{receipt.businessDate}</dd></div>
      {receipt.statusObservedAt ? <div><dt>{t.observedStatus}</dt><dd>{timestamp(receipt.statusObservedAt, lang)}</dd></div> : null}
    </dl>
    {receipt.lines.length ? <details className={styles.receiptMenu}><summary>{t.receiptMenu} ({receipt.lines.length})</summary>
      <table className={styles.lines}><thead><tr><th>{t.menu}</th><th>{t.quantity}</th><th>{t.amount}</th></tr></thead><tbody>
        {receipt.lines.map(line => <tr key={line.id}><td>{line.name}{line.canceled ? ` · ${t.canceled}` : ""}</td>
          <td>{line.quantity ?? "—"}</td><td>{line.amount === null ? "—" : money(line.amount)}</td></tr>)}
      </tbody></table></details> : <p className={styles.muted}>{t.noLines}</p>}
  </article>;

  return <main className={styles.page}>
    <h1 className={styles.srOnly}>{t.title}</h1>
    <header className={styles.overviewBar}>
      <dl className={styles.summary} aria-label={t.title}>{(["total", "occupied", "paid"] as const).map(key =>
        <div key={key}><dt>{t.summaryLabels[key]}</dt><dd>{data?.summary[key] ?? "—"}</dd></div>)}</dl>
      <p className={cx(styles.basis, basisWarning && styles.basisWarning)}>
        {basisWarning ? <span className={styles.warnMark} aria-hidden="true">!</span> : null}
        {t.basis} <time dateTime={data?.snapshotAt ?? undefined} title={timestamp(data?.snapshotAt, lang)}>{clock(data?.snapshotAt)}</time>
        {basisWarning ? <span className={styles.srOnly}>{t.basisWarning}</span> : null}
      </p>
      <button className={styles.refresh} onClick={() => void load()} disabled={loading} aria-label={t.refresh} title={t.refresh}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M20 7v5h-5M4 17v-5h5" /><path d="M6.1 6.1A8 8 0 0 1 20 12M4 12a8 8 0 0 0 13.9 5.9" />
        </svg>
      </button>
    </header>
    {loading && !data ? <p role="status" className={styles.notice}>{t.loading}</p> : null}
    {failed ? <p role="alert" className={styles.notice}>{t.failed}</p> : null}
    <div className={styles.statusRow}>
      <div className={styles.legend}>{(["occupied", "paid", "reserved"] as const).map(state => <span key={state}
        title={state === "paid" ? t.completionEvidence : t[state]}>
        <i className={cx(styles.swatch, stateClass[state])} aria-hidden="true" />
        <span aria-hidden="true">{t.legendLabels[state]}</span>
        <span className={styles.srOnly}>{t[state]}{state === "paid" ? ` · ${t.completionEvidence}` : ""}</span>
      </span>)}</div>
      {diagnostic ? <p role="status" className={styles.diagnostic}>{diagnostic}</p> : null}
    </div>
    <div className={styles.areas}>{areas.map(area => {
      const areaTables = data?.tables.filter(item => item.area === area) ?? [];
      return <section key={area} className={styles.area}>
      <div className={styles.areaHeader}><h2>{areaName(area)}</h2><span>· {areaTables.length}{t.tableCountSuffix}</span></div>
      <div className={cx(styles.tiles, area === "bar" && styles.barTiles)}>{areaTables.map(item => <button key={item.id}
        className={cx(styles.tile, stateClass[item.state], selected?.kind === "table" && selected.id === item.id && styles.selected)}
        aria-label={`${item.name} · ${areaName(item.area)} · ${t[item.state]}`} aria-haspopup="dialog"
        onClick={() => { setDetailResult(null); setSelected({ kind: "table", id: item.id }); }}>
        <strong>{item.name}</strong>
      </button>)}</div>
      {!areaTables.length ? <p className={styles.muted}>{t.noArea}</p> : null}
    </section>; })}</div>
    {data && data.unlinked.length > 0 ? <details className={styles.unlinked}><summary>{t.unlinked} ({data.unlinked.length})</summary>
      {data.unlinked.map(order => <button key={order.id} onClick={() => setSelected({ kind: "order", id: order.id })}>
        {order.tableName?.trim().toUpperCase() === "BAR" ? t.barUnlinked : order.tableName || t.unknown} · {t.order} {order.number ?? "—"}</button>)}
    </details> : null}
    <dialog ref={dialog} className={styles.sheet} aria-labelledby="table-detail-title" onCancel={() => setSelected(null)}
      onKeyDown={event => {
        if (event.key !== "Tab") return;
        const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]")]
          .filter(el => el.tabIndex >= 0 && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden");
        const first = focusable[0], last = focusable.at(-1);
        if (first && last && (event.shiftKey && document.activeElement === first || !event.shiftKey && document.activeElement === last || !focusable.includes(document.activeElement as HTMLElement))) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        }
      }}
      onPointerDown={event => {
        const r = event.currentTarget.getBoundingClientRect();
        backdropPress.current = event.target === event.currentTarget && (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom);
      }} onClick={event => {
        const r = event.currentTarget.getBoundingClientRect();
        if (backdropPress.current && event.target === event.currentTarget && (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom)) setSelected(null);
        backdropPress.current = false;
      }}>
      <header className={`${styles.header} ${styles.sheetHeader}`}><div className={styles.sheetTitle}><h2 id="table-detail-title">{tile?.name ?? unlinked?.tableName ?? t.details}</h2>
        {tile ? <span className={cx(styles.stateBadge, stateClass[tile.state])}>{t[tile.state]}</span> : null}
      </div><div className={styles.sheetActions}>
        {tile ? <button disabled className={styles.cleanButton} aria-describedby="table-cleaning-reason">{t.clean}</button> : null}
        <button className={styles.closeButton} aria-label={t.close} title={t.close} onClick={() => setSelected(null)}>×</button>
      </div></header>
      {tile ? <>
        <p id="table-cleaning-reason" className={styles.cleanReason}>{cleaningReason}</p>
        <dl className={styles.location}><div><dt>{t.details}</dt><dd>{areaName(tile.area)} · {tile.name}</dd></div>
          <div><dt>{t.sourceArea}</dt><dd>{tile.areaName}</dd></div></dl>
        <p className={styles.collectionTime}>🕒 {t.collectedLabel}: {timestamp(detail?.snapshotAt ?? data?.snapshotAt, lang)}</p>
        {(detail?.snapshotStatus ?? data?.snapshotStatus) !== "ok" ? <p className={styles.notice}>{t.delayed}</p> : null}
      </> : null}
      <section className={styles.detailSection}><h3>🍽️ {t.currentOrders}</h3>
        {currentOrders.length ? currentOrders.map(orderView) : <p className={styles.muted}>{t.noOrders}</p>}
        {retainedOrders.length ? <details><summary>{t.retainedOrders}</summary>{retainedOrders.map(orderView)}</details> : null}
      </section>
      {tile ? <>
        <section className={styles.detailSection}><h3>🧾 {t.latestPayment}</h3>
          {!detail ? <p role="status">{detailFailed ? t.historyFailed : t.historyLoading}</p>
            : detail.latest ? receiptView(detail.latest) : <p className={styles.muted}>{t.noPayment}</p>}
          <p className={styles.paymentSafety}>{t.completionEvidence}</p>
          {detail?.current.length ? <details><summary>{t.paymentHistory} · {detail.businessDate} ({detail.current.length})</summary>
            {detail.current.map(receiptView)}</details> : null}
        </section>
        {tile.state === "paid" ? <section className={styles.detailSection}><h3>⏱️ {t.timerTitle}</h3>
          <p className={styles.muted}>{t.timerUnavailable}</p></section> : null}
        {detail ? <details className={styles.detailSection}><summary>📚 {t.priorHistory} ({detail.previous.length})</summary>
          <p className={styles.muted}>{detail.historyFrom} — {detail.businessDate}</p>
          {detail.previous.length ? detail.previous.map(receiptView) : <p className={styles.muted}>{t.noPayment}</p>}
        </details> : null}
        {detail?.merges.length ? <section className={styles.detailSection}><h3>🔗 {t.mergedPayment}</h3>
          {detail.merges.map(merge => <article key={merge.receiptId} className={styles.receipt}>
            <strong>{t.receiptNumber} #{[...detail.current, ...detail.previous].find(r => r.id === merge.receiptId)?.number ?? merge.receiptId}</strong>
            <p>{merge.verified ? t.mergeVerified : t.mergeReview}</p>
            <p>{t.sourceTables}: {merge.tables.join(" · ")}</p><p>{t.receiptTable}: {merge.receiptTable ?? "—"}</p>
          </article>)}<p className={styles.paymentSafety}>{t.mergeSafety}</p>
        </section> : null}
      </> : null}
    </dialog>
  </main>;
}
