"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useLanguage } from "@/lib/language-context";
import { getBusinessDate } from "@/lib/common/business-time";
import { monthWindow } from "@/lib/reservations/policy";
import { reservationStatuses, type Reservation, type ReservationList } from "@/lib/reservations/types";
import { reservationText } from "@/lib/text/reservations";
import ReservationRows from "@/components/reservations/ReservationRows";
import ReservationForm from "@/components/reservations/ReservationForm";
import ReservationDetail from "@/components/reservations/ReservationDetail";
import ReservationInbox from "@/components/reservations/ReservationInbox";
import { reservationRequest, ReservationRequestError, errorText } from "@/components/reservations/client";
import styles from "@/components/reservations/reservations.module.css";

type Modal = { kind: "detail"; id: number; partial?: boolean } | { kind: "form"; existing?: Reservation; sourceInboxId?: number };
export default function ReservationsPage() {
  const { lang } = useLanguage(); const t = reservationText[lang]; const router = useRouter();
  const [tab, setTab] = useState<"today" | "inbox" | "schedule">("today");
  const [today, setToday] = useState(() => getBusinessDate());
  const [month, setMonth] = useState(() => getBusinessDate().slice(0, 7));
  const [view, setView] = useState<"calendar" | "list">("calendar"), [day, setDay] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [data, setData] = useState<ReservationList | null>(null), [modal, setModal] = useState<Modal | null>(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const request = useRef<AbortController | null>(null), lock = useRef(false);
  const calendarWindow = monthWindow(month);
  const unauthorized = useCallback(() => { setData(null); setModal(null); router.replace("/login"); }, [router]);
  const load = useCallback(async () => {
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    setLoading(true); setError("");
    try {
      const range = tab === "schedule" ? monthWindow(month) : null;
      const query = range ? `?from=${range.from}&to=${range.to}&status=${status}` : "";
      const result = await reservationRequest<ReservationList>(query, { signal: controller.signal });
      if (!controller.signal.aborted) { setData(result); setToday(result.today); }
    } catch (e) {
      if (controller.signal.aborted) return;
      if (e instanceof ReservationRequestError && e.status === 401) unauthorized();
      else { setData(null); setModal(null); setError(errorText(e, t)); }
    } finally { if (!controller.signal.aborted) setLoading(false); }
  }, [tab, month, status, t, unauthorized]);
  useEffect(() => {
    void load(); const timer = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 60000);
    return () => { request.current?.abort(); clearInterval(timer); };
  }, [load]);
  const select = (id: number) => setModal({ kind: "detail", id });
  async function confirm(r: Reservation) {
    if (lock.current) return; lock.current = true; setBusy(true); setError("");
    try {
      await reservationRequest(`/${r.id}/confirm`, { method: "POST", body: JSON.stringify({ expectedVersion: r.version }) });
      await load();
    } catch (e) {
      if (e instanceof ReservationRequestError && e.status === 401) unauthorized();
      else { if (e instanceof ReservationRequestError && e.status === 409) await load(); setError(errorText(e, t)); }
    } finally { lock.current = false; setBusy(false); }
  }
  const allItems = data?.items ?? [];
  const shown = allItems.filter(r => tab !== "schedule" || (day ? r.businessDate === day : r.businessDate.startsWith(month)));
  return <main className={styles.page} lang={lang}>
    <header className={styles.pageHeader}><div><p className={styles.eyebrow}>{today} · {t.businessDay}</p><h1>{t.title}</h1></div>
      <button className={styles.primary} disabled={!data?.permissions.manage || loading || busy} onClick={() => setModal({ kind: "form" })}>{t.create}</button></header>
    <div className={styles.summary} aria-label={t.title}>{(["total", "pending", "guests"] as const).map(key => <div key={key}><span>{t[key]}</span><strong>{data?.summary[key] ?? "—"}</strong></div>)}</div>
    <p className={styles.muted}>{t.zoneHint}<br />{t.activeGuests}</p>
    <nav className={styles.tabs} aria-label={t.title}>{(["today", "inbox", "schedule"] as const).map(key => <button key={key} aria-current={tab === key ? "page" : undefined}
      disabled={busy} onClick={() => { setTab(key); setDay(null); }}>{t[key]}</button>)}</nav>
    {error ? <p role="alert" className={styles.error}>{error} <button disabled={loading} onClick={() => void load()}>{t.retry}</button></p> : null}
    {loading ? <p role="status">{t.loading}</p> : null}
    {data?.truncated ? <p className={styles.notice}>{t.limited}</p> : null}
    {tab === "inbox" && data ? <ReservationInbox key={lang} t={t} lang={lang} today={today} allowed={data.permissions.inbox} refreshKey={refreshKey}
      onCreate={sourceInboxId => setModal({ kind: "form", sourceInboxId })} onReservation={select} onUnauthorized={unauthorized} /> : <>
      {tab === "schedule" ? <section className={styles.schedule}>
        <div className={styles.filters}><label>{t.date}<input type="month" value={month} onChange={e => { if (/^\d{4}-\d{2}$/.test(e.target.value)) { setMonth(e.target.value); setDay(null); } }} /></label>
          <label>{t.status}<select value={status} onChange={e => setStatus(e.target.value)}><option value="">{t.allStatuses}</option>
            {reservationStatuses.map(s => <option key={s} value={s}>{t.states[s]}</option>)}</select></label>
          <div className={styles.segment}><button aria-pressed={view === "calendar"} onClick={() => setView("calendar")}>{t.calendar}</button>
            <button aria-pressed={view === "list"} onClick={() => setView("list")}>{t.list}</button></div></div>
        {view === "calendar" ? <><p className={styles.muted}>{t.selectDay}</p><div className={styles.calendar}>
          {t.weekdays.map(s => <span key={s} className={styles.weekday}>{s}</span>)}
          {calendarWindow.days.map(date => {
            const items = allItems.filter(r => r.businessDate === date);
            return <button key={date} className={styles.day} data-outside={!date.startsWith(month)} aria-pressed={day === date}
              aria-label={`${date} · ${items.length} ${t.total}`} onClick={() => setDay(date)}><span>{Number(date.slice(8))}</span>
              {items.length ? <strong>{items.length}</strong> : <small>·</small>}</button>;
          })}</div>{day ? <div className={styles.daySelection}><strong>{day} · {t.businessDay}</strong><button onClick={() => setDay(null)}>{t.clearDay}</button></div> : null}</> : null}
      </section> : <div className={styles.toolbar}><h2>{t.today}</h2><button disabled={loading || busy} onClick={() => void load()}>{t.refresh}</button></div>}
      {!loading && !shown.length && !error ? <p className={styles.empty}>{t.empty}</p> : null}
      {!loading && data ? <ReservationRows items={shown} tables={data.tables} t={t} busy={busy} canConfirm={data.permissions.confirm} onSelect={select} onConfirm={r => void confirm(r)} /> : null}
    </>}
    <p className={styles.planNote}>{t.planHint}</p>
    {modal?.kind === "form" && data?.permissions.manage ? <ReservationForm key={modal.existing?.id ?? modal.sourceInboxId ?? "manual"} t={t} tables={data.tables} today={today}
      existing={modal.existing} sourceInboxId={modal.sourceInboxId} onClose={() => { setModal(null); void load(); }} onUnauthorized={unauthorized}
      onSaved={(id, partial) => { setModal({ kind: "detail", id, partial }); setRefreshKey(v => v + 1); void load(); }} /> : null}
    {modal?.kind === "detail" && data ? <ReservationDetail key={modal.id} id={modal.id} t={t} lang={lang} tables={data.tables} permissions={data.permissions}
      partial={modal.partial === true} onClose={() => setModal(null)} onEdit={existing => setModal({ kind: "form", existing })}
      onChanged={() => void load()} onUnauthorized={unauthorized} /> : null}
  </main>;
}
