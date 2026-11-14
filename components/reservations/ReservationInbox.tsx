"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { InboxItem, InboxDetail } from "@/lib/reservations/types";
import { inboxStatuses } from "@/lib/reservations/types";
import type { ReservationCopy } from "@/lib/text/reservations";
import ReservationDialog from "./ReservationDialog";
import { errorText, reservationRequest, ReservationRequestError, stamp } from "./client";
import styles from "./reservations.module.css";

export default function ReservationInbox({ t, lang, today, allowed, refreshKey, onCreate, onReservation, onUnauthorized }: {
  t: ReservationCopy; lang: "ko" | "vi"; today: string; allowed: boolean; onCreate: (source: number) => void;
  refreshKey: number; onReservation: (id: number) => void; onUnauthorized: () => void;
}) {
  const [from, setFrom] = useState(today), [to, setTo] = useState(today), [status, setStatus] = useState("received");
  const [items, setItems] = useState<InboxItem[]>([]), [detail, setDetail] = useState<InboxDetail | null>(null);
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [note, setNote] = useState(""), [truncated, setTruncated] = useState(false);
  const request = useRef<AbortController | null>(null), detailRequest = useRef<AbortController | null>(null), lock = useRef(false);
  const load = useCallback(async () => {
    if (!allowed) return;
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    setLoading(true); setError(""); setItems([]);
    try {
      const result = await reservationRequest<{ items: InboxItem[]; truncated: boolean }>(`/inbox?from=${from}&to=${to}&status=${status}`, { signal: controller.signal });
      if (!controller.signal.aborted) { setItems(result.items); setTruncated(result.truncated); }
    } catch (e) {
      if (controller.signal.aborted) return;
      if (e instanceof ReservationRequestError && e.status === 401) onUnauthorized(); else setError(errorText(e, t));
    } finally { if (!controller.signal.aborted) setLoading(false); }
  }, [allowed, from, to, status, t, onUnauthorized]);
  useEffect(() => { void load(); return () => request.current?.abort(); }, [load, refreshKey]);
  useEffect(() => () => detailRequest.current?.abort(), []);
  async function open(id: number) {
    detailRequest.current?.abort(); const controller = new AbortController(); detailRequest.current = controller;
    setBusy(true); setError("");
    try {
      const result = await reservationRequest<InboxDetail>(`/inbox/${id}`, { signal: controller.signal });
      if (!controller.signal.aborted) { setDetail(result); setNote(""); }
    } catch (e) { if (!controller.signal.aborted) {
      if (e instanceof ReservationRequestError && e.status === 401) onUnauthorized(); else setError(errorText(e, t));
    } } finally { if (!controller.signal.aborted) setBusy(false); }
  }
  async function act(action: "dismiss" | "reprocess") {
    if (!detail || lock.current) return; lock.current = true; setBusy(true); setError("");
    try {
      await reservationRequest(`/inbox/${detail.item.id}/${action}`, { method: "POST", body: JSON.stringify({ note }) });
      await load(); await open(detail.item.id);
    } catch (e) {
      if (e instanceof ReservationRequestError && e.status === 401) onUnauthorized(); else setError(errorText(e, t));
    } finally { lock.current = false; setBusy(false); }
  }
  if (!allowed) return <p className={styles.notice} role="status">{t.denied}</p>;
  const item = detail?.item;
  return <section>
    <div className={styles.filters}><label>{t.businessDay}<input type="date" value={from} onChange={e => setFrom(e.target.value)} /></label>
      <label>{t.date}<input type="date" value={to} onChange={e => setTo(e.target.value)} /></label><label>{t.status}<select value={status} onChange={e => setStatus(e.target.value)}>
        <option value="">{t.allStatuses}</option>{inboxStatuses.map(s => <option key={s} value={s}>{t.inboxStates[s]}</option>)}</select></label>
      <button disabled={loading || busy} onClick={() => void load()}>{t.refresh}</button></div>
    {error && !detail ? <p role="alert" className={styles.error}>{error}</p> : null}
    {loading ? <p role="status">{t.loading}</p> : null}
    {truncated ? <p role="status">{t.limited}</p> : null}
    {!loading && !items.length && !error ? <p className={styles.empty}>{t.inboxEmpty}</p> : null}
    <div className={styles.cards}>{items.map(i => <button className={styles.inboxCard} key={i.id} disabled={busy} onClick={() => void open(i.id)}>
      <strong>{t.inboxId} #{i.id}</strong><span className={styles.badge}>{t.inboxStates[i.status]}</span><span>{stamp(i.receivedAt, lang)}</span>
      {i.deliveryCount > 1 ? <small>{t.duplicate} × {i.deliveryCount}</small> : null}{i.payloadMismatchCount > 0 ? <small>{t.mismatch}</small> : null}</button>)}</div>
    {item && detail ? <ReservationDialog title={`${t.inboxId} #${item.id}`} closeLabel={t.close} busy={busy} onClose={() => { setDetail(null); setError(""); }}>
      {error ? <p role="alert" className={styles.error}>{error}</p> : null}
      <span className={styles.badge}>{t.inboxStates[item.status]}</span>
      <dl className={styles.facts}><div><dt>{t.received}</dt><dd>{stamp(item.receivedAt, lang)}</dd></div>
        <div><dt>{t.messageAt}</dt><dd>{stamp(item.messageAt, lang)}</dd></div><div><dt>{t.sender}</dt><dd>{item.senderName ?? "—"}</dd></div>
        <div><dt>{t.deliveries}</dt><dd>{item.deliveryCount}</dd></div><div><dt>{t.reprocessCount}</dt><dd>{item.reprocessCount}</dd></div></dl>
      {item.quarantineReason ? <p>{t.quarantine}: {t.quarantineReasons[item.quarantineReason as keyof typeof t.quarantineReasons] ?? item.quarantineReason}</p> : null}
      <h3>{t.original}</h3><pre className={styles.message}>{item.piiPurged ? t.purged : item.originalText ?? "—"}</pre>
      {item.payloadMismatchCount ? <p className={styles.notice}>{t.mismatch} × {item.payloadMismatchCount}</p> : null}
      {item.reviewNote ? <p className={styles.pre}>{t.reviewNote}: {item.reviewNote}</p> : null}
      <p className={styles.notice}>{t.inboxHistoryLimit}</p>
      {detail.linkedReservations.map(link => <section key={link.reservation.id} className={styles.section}>
        <button onClick={() => { setDetail(null); onReservation(link.reservation.id); }}>{t.linked} #{link.reservation.id}</button>
        <ol className={styles.history}>{link.events.map(e => <li key={e.id}>{t.events[e.type as keyof typeof t.events] ?? t.history} · {t.staff} #{e.actorUserId ?? "—"} · {stamp(e.createdAt, lang)}</li>)}</ol>
      </section>)}
      {!item.piiPurged && ["received", "quarantined"].includes(item.status) ? <>
        <label>{t.reviewNote}<textarea value={note} onChange={e => setNote(e.target.value)} maxLength={500} rows={2} disabled={busy} /></label>
        <div className={styles.actions}>{item.status === "received" && !item.reservationIds.length ? <button className={styles.primary} disabled={busy} onClick={() => { setDetail(null); onCreate(item.id); }}>{t.candidate}</button> : null}
          {item.status === "quarantined" ? <button disabled={busy} onClick={() => void act("reprocess")}>{t.reprocess}</button> : null}
          <button disabled={busy} onClick={() => void act("dismiss")}>{t.dismiss}</button></div></> : null}
    </ReservationDialog> : null}
  </section>;
}
