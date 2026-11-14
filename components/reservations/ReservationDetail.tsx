"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Reservation, ReservationDetail as Detail, ReservationPermissions, ReservationTable } from "@/lib/reservations/types";
import type { ReservationCopy } from "@/lib/text/reservations";
import ReservationDialog from "./ReservationDialog";
import { reservationRequest, ReservationRequestError, errorText, stamp } from "./client";
import styles from "./reservations.module.css";

export default function ReservationDetail({ id, t, lang, permissions: p, tables, partial, onClose, onEdit, onChanged, onUnauthorized }: {
  id: number; t: ReservationCopy; lang: "ko" | "vi"; permissions: ReservationPermissions; tables: ReservationTable[]; partial: boolean;
  onClose: () => void; onEdit: (r: Reservation) => void; onChanged: () => void; onUnauthorized: () => void;
}) {
  const [data, setData] = useState<Detail | null>(null), [error, setError] = useState("");
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [showPartial, setShowPartial] = useState(partial);
  const [reason, setReason] = useState(""), [table, setTable] = useState("");
  const lock = useRef(false), request = useRef<AbortController | null>(null);
  const reload = useCallback(async (reveal = false) => {
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    setLoading(true);
    try {
      const result = await reservationRequest<Detail>(`/${id}${reveal ? "?reveal=1" : ""}`, { signal: controller.signal });
      if (!controller.signal.aborted) { setData(result); if (result.reservation.tables.length) setShowPartial(false); }
    } catch (e) {
      if (controller.signal.aborted) return;
      if (e instanceof ReservationRequestError && e.status === 401) onUnauthorized();
      else { setData(null); setError(errorText(e, t)); }
    } finally { if (!controller.signal.aborted) setLoading(false); }
  }, [id, onUnauthorized, t]);
  useEffect(() => { void reload(); return () => request.current?.abort(); }, [reload]);
  async function mutate(path: string, body: Record<string, unknown>, method = "POST") {
    if (!data || lock.current) return;
    lock.current = true; setBusy(true); setError("");
    try {
      await reservationRequest(`/${id}${path}`, { method, body: JSON.stringify({ expectedVersion: data.reservation.version, ...body }) });
      setReason(""); setTable(""); onChanged(); await reload();
    } catch (e) {
      if (e instanceof ReservationRequestError && e.status === 401) onUnauthorized();
      else { setError(errorText(e, t)); if (e instanceof ReservationRequestError && e.status === 409) { onChanged(); await reload(); } }
    } finally { lock.current = false; setBusy(false); }
  }
  const r = data?.reservation;
  const tableName = (tableId: string) => tables.find(v => v.id === tableId)?.name ?? "—";
  const actor = (n: number | null | undefined) => n ? `${t.staff} #${n}` : "—";
  const created = data?.events.find(e => e.type === "reservation_created");
  const editable = p.manage && r && ["pending", "confirmed"].includes(r.status) && !r.piiPurged;
  return <ReservationDialog title={`${t.detail} #${id}`} closeLabel={t.close} onClose={onClose} busy={busy}>
    {showPartial ? <p role="alert" className={styles.error}>{t.partial}</p> : null}
    {error ? <p role="alert" className={styles.error}>{error}</p> : null}
    {loading ? <p role="status">{t.loading}</p> : null}
    <button type="button" disabled={loading || busy} onClick={() => { setError(""); void reload(); }}>{t.refresh}</button>
    {r ? <>
      <div className={styles.detailHeading}><span className={styles.badge} data-state={r.status}>{t.states[r.status]}</span>
        <strong>{r.customerName ?? `#${r.id}`}</strong><span>{r.partySize} · {t.party}</span></div>
      <dl className={styles.facts}>
        <div><dt>{t.time}</dt><dd>{stamp(r.reservedAt, lang)}</dd></div><div><dt>{t.businessDay}</dt><dd>{r.businessDate}</dd></div>
        <div><dt>{t.createdBy}</dt><dd>{actor(created?.actorUserId)}</dd></div><div><dt>{t.confirmedBy}</dt><dd>{actor(r.confirmedBy)}</dd></div>
        <div><dt>{t.confirmedAt}</dt><dd>{stamp(r.confirmedAt, lang)}</dd></div><div><dt>{t.duration}</dt><dd>{r.durationMinutes}</dd></div>
      </dl>
      {p.manage ? <section className={styles.section}><h3>{t.contact}</h3><p>{r.customerContact ?? "—"}</p>
        {p.reveal && r.contactMasked && !r.piiPurged ? <button disabled={busy || loading} onClick={() => void reload(true)}>{t.reveal}</button> : null}
        <h3>{t.note}</h3><p className={styles.pre}>{r.note || "—"}</p>
        {r.cancelReason ? <><h3>{t.reason}</h3><p className={styles.pre}>{r.cancelReason}</p></> : null}</section> : <p className={styles.muted}>{t.privateHint}</p>}
      {r.piiPurged ? <p className={styles.notice}>{t.purged}</p> : null}
      <section className={styles.section}><h3>{t.table}</h3><p className={styles.muted}>{t.planHint}</p>
        <div className={styles.chips}>{r.tables.length ? r.tables.map(l => <span key={l.linkId} className={styles.chip}>{tableName(l.tableId)}
          {p.manage ? <button disabled={busy || loading} aria-label={`${t.release} ${tableName(l.tableId)}`} onClick={() => void mutate("/tables", { linkId: l.linkId, reason }, "DELETE")}>{t.release}</button> : null}</span>) : t.noTable}</div>
        {p.manage && ["pending", "confirmed", "arrived"].includes(r.status) ? <div className={styles.assignRow}>
          <label>{t.table}<select aria-label={t.table} value={table} onChange={e => setTable(e.target.value)} disabled={busy || loading}>
            <option value="">{t.noTable}</option>{tables.filter(v => !r.tables.some(l => l.tableId === v.id)).map(v => <option key={v.id} value={v.id}>{v.area === "bar" ? t.bar : v.area === "floor1" ? t.floor1 : t.floor2} · {v.name}</option>)}</select></label>
          <button disabled={!table || busy || loading} onClick={() => void mutate("/tables", { tableId: table })}>{t.assign}</button></div> : null}
      </section>
      <section className={styles.section}><h3>{t.status}</h3>
        {p.manage && ["pending", "confirmed", "arrived"].includes(r.status) ? <label>{t.reason}<textarea maxLength={500} rows={2} value={reason} onChange={e => setReason(e.target.value)} disabled={busy || loading} /></label> : null}
        <div className={styles.actions}>
          {r.status === "pending" && p.confirm ? <button className={styles.primary} disabled={busy || loading} onClick={() => void mutate("/confirm", {})}>{busy ? t.saving : t.confirm}</button> : null}
          {editable ? <button disabled={busy || loading} onClick={() => onEdit(r)}>{t.edit}</button> : null}
          {p.manage && r.status === "confirmed" ? <>
            <button disabled={busy || loading} onClick={() => void mutate("/transition", { toStatus: "arrived", reason })}>{t.arrival}</button>
            <button disabled={busy || loading} onClick={() => void mutate("/transition", { toStatus: "no_show", reason })}>{t.noShow}</button>
            <button disabled={busy || loading} onClick={() => void mutate("/transition", { toStatus: "pending", reason })}>{t.undo}</button></> : null}
          {p.manage && r.status === "arrived" ? <button disabled={busy || loading} onClick={() => void mutate("/transition", { toStatus: "completed", reason })}>{t.complete}</button> : null}
          {editable ? <button className={styles.danger} disabled={busy || loading} onClick={() => {
            if (!reason.trim()) { setError(t.reasonRequired); return; } void mutate("/transition", { toStatus: "cancelled", reason });
          }}>{t.cancelReservation}</button> : null}
        </div>
      </section>
      <section className={styles.section}><h3>{t.history}</h3><ol className={styles.history}>
        {data.events.map(e => <li key={e.id}><strong>{t.events[e.type as keyof typeof t.events] ?? t.history}</strong>
          {e.toStatus && e.toStatus in t.states ? <span> · {t.states[e.toStatus as keyof typeof t.states]}</span> : null}
          <p>{actor(e.actorUserId)} · {stamp(e.createdAt, lang)}</p></li>)}
      </ol>{!data.events.length ? <p>{t.noHistory}</p> : null}</section>
      {data.tableHistory.length ? <section className={styles.section}><h3>{t.tableHistory}</h3>{data.tableHistory.map(l => <p key={l.linkId}>
        {tableName(l.tableId)} · {stamp(l.plannedFrom, lang)} → {stamp(l.plannedTo, lang)} {l.releasedAt ? `· ${t.released}` : ""}</p>)}</section> : null}
    </> : null}
  </ReservationDialog>;
}
