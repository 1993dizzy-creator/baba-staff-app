"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useLanguage } from "@/lib/language-context";
import { tablesText } from "@/lib/text/tables";
import type { TableOrder, TableOverview, TableState } from "@/lib/sales/table-overview";
import type { DetailReceipt, TableDetail } from "@/lib/sales/table-detail";
import { detailTableName, orderElapsedMinutes, paidOrderElapsedMinutes, preferLatestOverview, verifiedOrderStart, verifiedPaidReferenceTime } from "@/lib/sales/table-detail-display";
import { localizedTableMenuName } from "@/lib/sales/table-menu-display";
import styles from "./tables.module.css";

// One class per state colors the whole tile, the legend swatch and the sheet badge alike.
// Idle (and any never-produced state) stays white: color is not a vacancy claim.
const stateClass: Partial<Record<TableState, string>> = {
  occupied: styles.occupied, paid: styles.paid, reserved: styles.reserved, unknown: styles.unknown,
};
const cx = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(" ");
const money = (n: number) => new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 }).format(n);
const timestamp = (value: string | null | undefined, lang: string, full = false) => value && Number.isFinite(Date.parse(value))
  ? new Intl.DateTimeFormat(lang === "ko" ? "ko-KR" : "vi-VN", { timeZone: "Asia/Ho_Chi_Minh", ...(full ? { year: "numeric" as const } : {}), month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(value)) : "—";
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
  const [saveState, setSaveState] = useState<{ id: string; busy: boolean; error: boolean } | null>(null);
  const saving = useRef(false);
  const cleaningRequest = useRef<{ key: string; requestId: string } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const backdropPress = useRef(false);
  const request = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setFailed(false);
    try {
      const response = await fetch("/api/tables", { cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]) });
      if (response.status === 401 || response.status === 403) {
        setData(null); setSelected(null); router.replace("/login"); return;
      }
      const result = await response.json();
      if (!response.ok || !result.ok || !result.overview) throw Error("unavailable");
      if (!controller.signal.aborted) { setData(previous => preferLatestOverview(previous, result.overview)); setFailed(false); }
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
  const snapshotStatus = detail?.snapshotStatus ?? data?.snapshotStatus;
  const snapshotAt = detail?.snapshotAt ?? data?.snapshotAt ?? null;
  const elapsed = tile && data ? tile.state === "paid" ? paidOrderElapsedMinutes(detail)
    : orderElapsedMinutes(tile, snapshotAt, data.serverNow, snapshotStatus ?? "") : null;
  const usage = detail?.usage;
  const usageCurrent = !!usage && snapshotStatus === "ok" && usage.snapshotAt === detail?.snapshotAt;
  const usageCount = usageCurrent && usage?.status === "confirmed_order_basis" ? usage.count : null;
  const compactWarning = saveState?.id === tile?.id && saveState?.error ? t.cleanFailed
    : detailFailed && tile?.state !== "idle" ? t.historyUnavailableShort
    : snapshotStatus !== "ok" ? t.collectionCheck : tile?.state === "unknown" ? t.orderCheck : null;
  const cleanTable = async () => {
    if (saving.current || !tile || tile.state !== "paid" || !detail?.cleaning.enabled || !detail.cleaning.token) return;
    const id = tile.id, token = detail.cleaning.token, key = `${id}:${token.evidenceKey}`;
    if (cleaningRequest.current?.key !== key) cleaningRequest.current = { key, requestId: crypto.randomUUID() };
    saving.current = true;
    setSaveState({ id, busy: true, error: false });
    try {
      const response = await fetch(`/api/tables/${encodeURIComponent(id)}/clean`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...token, requestId: cleaningRequest.current.requestId }), signal: AbortSignal.timeout(20_000) });
      if (response.status === 401 || response.status === 403) { setSelected(null); router.replace("/login"); return; }
      const result = await response.json();
      if (!response.ok || !result.ok || !result.overview) throw Error("cleaning_failed");
      setData(previous => preferLatestOverview(previous, result.overview));
      setSaveState({ id, busy: false, error: false });
    } catch {
      setSaveState({ id, busy: false, error: true });
    } finally { saving.current = false; }
  };
  const areaName = (key: string) => key === "bar" ? t.bar : key === "floor1" ? t.floor1 : key === "floor2" ? t.floor2 : key.replace(/^other:/, "");
  const areas = ["bar", "floor1", "floor2", ...new Set(data?.tables.filter(item => item.area.startsWith("other:")).map(item => item.area) ?? [])];
  const diagnostic = data ? data.catalogStatus !== "ok" ? t.unavailable
    : data.snapshotStatus === "waiting" ? t.waiting
    : data.snapshotStatus !== "ok" ? t.unavailable
    : data.summary.unknown > 0 || data.unlinkedReceiptCount > 0 ? t.partial : null : null;
  // The basis is the last successful order collection that decided the states, never the browser clock.
  const basisWarning = failed || !!data && (data.catalogStatus !== "ok" || !["ok", "waiting"].includes(data.snapshotStatus));
  const orderView = (order: TableOrder, index: number, current = false) => <article key={order.id} className={styles.order}>
    <h3>{current ? `🍽️ ${t.currentOrders} [${order.number?.trim() || t.orderNumberMissing}]` : `${t.order} ${order.number?.trim() || t.orderNumberMissing}`}
      {current && currentOrders.length > 1 ? <span className={styles.orderOrdinal}> · {index + 1}/{currentOrders.length}</span> : null}</h3>
    {order.detailsNeedReview ? <p className={styles.notice}>{t.detailsReview}</p> : null}
    <div className={styles.orderMenu}>
      {order.lines ? <ul className={styles.menuItems}>{order.lines.map(line => <li key={line.id} className={styles.menuItem}>
        <details className={styles.menuDisclosure}>
          <summary className={styles.menuRow} title={t.menuDetails}>
            <span className={styles.menuName}><span className={styles.menuLabel}>
              <strong>{localizedTableMenuName(line.name, lang) || "—"}</strong><span className={styles.menuToggle} aria-hidden="true">⌄</span>
            </span>{line.option || line.canceled ? <span className={styles.menuFlags}>
              {line.option ? <span className={styles.menuFlag}>{t.option}</span> : null}
              {line.canceled ? <span className={cx(styles.menuFlag, styles.canceledFlag)}>{t.canceled}</span> : null}
            </span> : null}</span>
            <span className={styles.menuQuantity}><span className={styles.srOnly}>{t.quantity} </span>×{line.quantity}</span>
            <strong className={styles.menuLineAmount}><span className={styles.srOnly}>{t.amount} </span>{money(line.amount)}</strong>
          </summary>
          <div className={styles.menuDetails}>
            {localizedTableMenuName(line.name, lang) !== line.name ? <p className={styles.originalMenuName}>{line.name}</p> : null}
            <dl className={styles.menuAmounts}>
              <div><dt>{t.quantity}</dt><dd>{line.quantity}</dd></div><div><dt>{t.price}</dt><dd>{money(line.price)}</dd></div>
              <div><dt>{t.amount}</dt><dd>{money(line.amount)}</dd></div>
            </dl>
          </div>
        </details>
      </li>)}</ul> : <p>{t.noLines}</p>}
      <p className={cx(styles.estimate, styles.orderEstimate)}>{t.estimate} <strong>{money(order.amount)}</strong></p>
    </div>
  </article>;
  const receiptView = (receipt: DetailReceipt) => <article key={receipt.id} className={styles.receipt}>
    <div className={styles.receiptHeading}>
      <details className={styles.receiptInfo}><summary title={t.receiptInfo}>
        <strong>{t.receiptNumber} #{receipt.number ?? receipt.id}</strong><span aria-hidden="true">⌄</span>
      </summary><dl className={styles.receiptFacts}>
        <div><dt>{t.businessDate}</dt><dd>{receipt.businessDate}</dd></div>
        <div><dt>{t.receiptBasis} · Asia/Ho_Chi_Minh</dt><dd><time dateTime={receipt.referenceAt ?? undefined}>{timestamp(receipt.referenceAt, lang, true)}</time></dd></div>
      </dl></details>
      <div className={styles.receiptBadges}>
        <span className={cx(styles.receiptBadge, receipt.canceled ? styles.receiptCanceled : receipt.validPaid ? styles.receiptValid : styles.receiptReview)}>
          {receipt.canceled ? t.canceledPayment : receipt.validPaid ? t.validPayment : t.reviewPayment}</span>
        {(receipt.canceled || receipt.validPaid) && receipt.uncertain ? <span className={cx(styles.receiptBadge, styles.receiptReview)}>{t.reviewPayment}</span> : null}
        {receipt.reissued ? <span className={styles.receiptBadge}>{t.reissuedPayment}</span> : null}
        {receipt.link !== "direct" ? <span className={styles.receiptBadge}>{t.mergedPayment}</span> : null}
      </div>
    </div>
    <div className={styles.receiptTotal}>
      <strong><span className={styles.srOnly}>{t.finalPaid} </span>{receipt.amount === null ? "—" : money(receipt.amount)}</strong>
      <time dateTime={receipt.referenceAt ?? undefined} title={`${t.receiptBasis} · Asia/Ho_Chi_Minh`}>
        <span className={styles.srOnly}>{t.receiptBasis} </span>{timestamp(receipt.referenceAt, lang)}</time>
    </div>
    {receipt.businessDate !== (detail?.businessDate ?? data?.businessDate) ? <p className={styles.receiptBusinessDate}>{t.businessDate}: {receipt.businessDate}</p> : null}
    {receipt.lines.length ? <details className={styles.receiptMenu}><summary>{t.receiptMenu} ({receipt.lines.length})</summary>
      <table className={styles.lines}><thead><tr><th>{t.menu}</th><th>{t.quantity}</th><th>{t.amount}</th></tr></thead><tbody>
        {receipt.lines.map(line => <tr key={line.id}><td title={line.name}>{localizedTableMenuName(line.name, lang)}{line.canceled ? ` · ${t.canceled}` : ""}</td>
          <td>{line.quantity ?? "—"}</td><td>{line.amount === null ? "—" : money(line.amount)}</td></tr>)}
      </tbody></table></details> : <p className={styles.muted}>{t.noLines}</p>}
  </article>;

  return <main className={styles.page}>
    <h1 className={styles.srOnly}>{t.title}</h1>
    <header className={styles.overviewBar}>
      <dl className={styles.summary} aria-label={t.title}>{(["total", "occupied", "paidCumulative"] as const).map(key =>
        <div key={key} title={key === "paidCumulative" ? t.paidCumulativeHelp : undefined}><dt>{t.summaryLabels[key]}</dt><dd>{data?.summary[key] ?? "—"}
          {key === "paidCumulative" && data?.summary.paidCumulative == null ? <span className={styles.srOnly}>{t.paidCumulativeReview}</span> : null}
        </dd></div>)}</dl>
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
    {loading && !data ? <div role="status" className={styles.loadingCard}>
      <span className={styles.spinner} aria-hidden="true" /><span>{t.loading}</span>
    </div> : null}
    {failed ? <p role="alert" className={styles.notice}>{t.failed}</p> : null}
    {data && data.summary.paidCumulative == null ? <p className={styles.cumulativeReview}>{t.paidCumulativeReview}</p> : null}
    <div className={styles.statusRow}>
      <div className={styles.legend}>{(["occupied", "paid", "reserved"] as const).map(state => <span key={state}
        title={state === "paid" ? t.completionEvidence : t[state]}>
        <i className={cx(styles.swatch, stateClass[state])} aria-hidden="true" />
        <span aria-hidden="true">{t.legendLabels[state]}</span>
        <span className={styles.srOnly}>{t[state]}{state === "paid" ? ` · ${t.completionEvidence}` : ""}</span>
      </span>)}</div>
      {diagnostic ? <p role="status" className={styles.diagnostic}>{diagnostic}</p> : null}
    </div>
    {data ? <div className={styles.areas}>{areas.map(area => {
      const areaTables = data?.tables.filter(item => item.area === area) ?? [];
      return <section key={area} className={styles.area}>
      <div className={styles.areaHeader}><h2>{areaName(area)}</h2><span>· {areaTables.length}{t.tableCountSuffix}</span></div>
      <div className={cx(styles.tiles, area === "bar" && styles.barTiles)}>{areaTables.map(item => {
        const start = data ? verifiedOrderStart(item, data.snapshotAt, data.serverNow, data.snapshotStatus, data.businessDate) : null;
        const paidAt = data ? verifiedPaidReferenceTime(item, data.snapshotAt, data.serverNow, data.snapshotStatus, data.businessDate) : null;
        return <button key={item.id}
        className={cx(styles.tile, stateClass[item.state], selected?.kind === "table" && selected.id === item.id && styles.selected)}
        aria-label={`${item.name} · ${areaName(item.area)} · ${t[item.state]}${start ? ` · ${t.started} ${clock(start)}` : ""}${paidAt ? ` · ${t.receiptBasis} ${clock(paidAt)}` : ""}`} aria-haspopup="dialog"
        onClick={() => { setDetailResult(null); setSelected({ kind: "table", id: item.id }); }}>
        <strong>{item.name}</strong>
        {start ? <time className={styles.tileStart} dateTime={start} title={t.orderStartedHint}><span aria-hidden="true">🕒</span> {clock(start)}</time> : null}
        {paidAt ? <time className={cx(styles.tileStart, styles.tilePaidTime)} dateTime={paidAt} title={t.receiptBasis}><span aria-hidden="true">🕒</span> {clock(paidAt)}</time> : null}
      </button>; })}</div>
      {!areaTables.length ? <p className={styles.muted}>{t.noArea}</p> : null}
    </section>; })}</div> : null}
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
      <header className={`${styles.header} ${styles.sheetHeader}`}><div className={styles.sheetTitle}><h2 id="table-detail-title">{tile ? detailTableName(tile, lang) : unlinked?.tableName ?? t.details}</h2>
        {tile ? <div className={styles.sheetMeta}><span className={styles.detailState} title={tile.state === "occupied" ? t.orderElapsedHint : tile.state === "paid" && elapsed !== null ? t.paidOrderElapsedHint : tile.state === "idle" && snapshotStatus === "ok" ? t.noOrders : undefined}>
          <span className={styles.stateDot} data-state={snapshotStatus === "ok" ? tile.state : "unknown"} aria-hidden="true" />
          {t.detailStates[snapshotStatus === "ok" ? tile.state : "unknown"]}{elapsed !== null ? ` · ${elapsed}${t.minuteShort}` : ""}
        </span>{snapshotStatus === "ok" && tile.state !== "unknown" && snapshotAt && Date.parse(snapshotAt) <= Date.parse(data?.serverNow ?? "")
          ? <time className={styles.detailClock} dateTime={snapshotAt} title={`${t.collectedLabel}: ${timestamp(snapshotAt, lang)}`}>🕒 {clock(snapshotAt)}</time> : null}</div> : null}
      </div><div className={styles.sheetActions}>
        {tile?.state === "paid" && snapshotStatus === "ok" ? <button disabled={!detail?.cleaning.enabled || saveState?.busy} className={styles.cleanButton}
          aria-label={t.cleanAction} title={detail?.cleaning.enabled ? t.cleanAction : cleaningReason} aria-describedby="table-cleaning-reason"
          aria-busy={saveState?.id === tile.id && saveState.busy} onClick={() => void cleanTable()}>🧹</button> : null}
        <button className={styles.closeButton} aria-label={t.close} title={t.close} onClick={() => setSelected(null)}>×</button>
      </div></header>
      {tile?.state === "paid" ? <span id="table-cleaning-reason" className={styles.srOnly}>{cleaningReason}</span> : null}
      {compactWarning ? <p role="alert" className={styles.compactWarning}>{compactWarning}</p> : null}
      {tile?.paymentObservation && snapshotStatus === "ok" ? <p className={styles.paymentSafety}>
        {tile.paymentObservation.expired ? t.automaticallyRetired : <>{t.paymentObserved} {clock(tile.paymentObservation.firstVerifiedAt)}
          {" · "}{t.automaticUntil} {clock(tile.paymentObservation.expiresAt)}</>}
      </p> : null}
      {tile?.state === "idle" && snapshotStatus === "ok" ? <p className={cx(styles.emptyOrder, styles.idleEmpty)} title={t.noOrders}>
        <span aria-hidden="true">🍽️</span><span>{t.noCurrentOrders}</span></p>
        : currentOrders.length ? <section className={styles.detailSection} aria-label={t.currentOrders}>{currentOrders.map((order, index) => orderView(order, index, true))}</section>
        : !tile || tile.state === "unknown" || snapshotStatus !== "ok" ? <>{!compactWarning ? <p className={styles.emptyOrder}>{t.orderCheck}</p> : null}
          {retainedOrders.length ? <details className={styles.detailSection}><summary>{t.retainedOrders}</summary>{retainedOrders.map((order, index) => orderView(order, index))}</details> : null}</> : null}
      {tile ? <>
        {tile.state === "paid" && !detail && !detailFailed ? <p role="status" className={styles.muted}>{t.historyLoading}</p> : null}
        {detail?.latest ? <section className={styles.detailSection}><h3>🧾 {tile.state === "occupied" ? t.pastPayment : t.latestPayment}
          {usageCount !== null && Number.isSafeInteger(usageCount) && usageCount >= 2
            ? <span className={styles.usageCount}> · {t.todayUsage.replace("{count}", String(usageCount))}</span> : null}</h3>
          {receiptView(detail.latest)}
          {tile.state === "paid" && !detail.merges.length ? <p className={styles.paymentSafety}>{t.completionEvidence}</p> : null}
        </section> : null}
        {detail && (detail.current.length > 1 || !detail.latest && detail.current.length > 0) ? <details className={styles.detailSection}>
          <summary>{t.paymentHistory} · {detail.businessDate} ({detail.current.length})</summary>{detail.current.map(receiptView)}</details> : null}
        {detail?.merges.length ? <section className={styles.detailSection}><h3>🔗 {t.mergedPayment}</h3>
          {detail.merges.map(merge => <article key={merge.receiptId} className={styles.receipt}>
            <strong>{t.receiptNumber} #{detail.current.find(r => r.id === merge.receiptId)?.number ?? merge.receiptId}</strong>
            <p>{merge.verified ? t.mergeVerified : t.mergeReview}</p>
            <p>{t.sourceTables}: {merge.tables.join(" · ")}</p><p>{t.receiptTable}: {merge.receiptTable ?? "—"}</p>
          </article>)}<p className={styles.paymentSafety}>{t.mergeSafety}</p>
        </section> : null}
      </> : null}
    </dialog>
  </main>;
}
