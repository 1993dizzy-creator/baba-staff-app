"use client";
import { useRef, useState } from "react";
import type { Reservation, ReservationTable } from "@/lib/reservations/types";
import { localVisit, visitParts } from "@/lib/reservations/policy";
import type { ReservationCopy } from "@/lib/text/reservations";
import { reservationRequest, errorText, ReservationRequestError } from "./client";
import ReservationDialog from "./ReservationDialog";
import styles from "./reservations.module.css";

export default function ReservationForm({ t, tables, today, existing, sourceInboxId, onClose, onSaved, onUnauthorized }: {
  t: ReservationCopy; tables: ReservationTable[]; today: string; existing?: Reservation; sourceInboxId?: number;
  onClose: () => void; onSaved: (id: number, partial: boolean) => void; onUnauthorized: () => void;
}) {
  const initial = existing ? visitParts(existing.reservedAt) : { date: today, time: "19:00" };
  const [date, setDate] = useState(initial.date), [time, setTime] = useState(initial.time);
  const [name, setName] = useState(existing?.customerName ?? ""), [contact, setContact] = useState("");
  const [clearContact, setClearContact] = useState(false), [party, setParty] = useState(existing?.partySize ?? 2);
  const [duration, setDuration] = useState(existing?.durationMinutes ?? 120), [note, setNote] = useState(existing?.note ?? "");
  const [area, setArea] = useState(""), [table, setTable] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const lock = useRef(false), requestKey = useRef<string | null>(null);
  return <ReservationDialog title={existing ? t.edit : t.create} closeLabel={t.close} onClose={onClose} busy={busy}>
    <form className={styles.form} onSubmit={async event => {
      event.preventDefault(); if (lock.current) return;
      const reservedAt = localVisit(date, time); if (!reservedAt) { setError(t.invalid); return; }
      lock.current = true; setBusy(true); setError("");
      try {
        requestKey.current ??= crypto.randomUUID();
        const payload = { customerName: name, reservedAt, partySize: party, durationMinutes: duration, note,
          ...(!existing || contact || clearContact ? { customerContact: clearContact ? "" : contact } : {}),
          ...(existing ? { expectedVersion: existing.version } : { requestKey: requestKey.current, sourceInboxId }) };
        const result = await reservationRequest<{ reservation: Reservation }>(existing ? `/${existing.id}` : "", {
          method: existing ? "PATCH" : "POST", body: JSON.stringify(payload),
        });
        let partial = false;
        if (!existing && table) {
          try { await reservationRequest(`/${result.reservation.id}/tables`, { method: "POST",
            body: JSON.stringify({ expectedVersion: result.reservation.version, tableId: table }) }); }
          catch (e) { if (e instanceof ReservationRequestError && e.status === 401) onUnauthorized(); partial = true; }
        }
        onSaved(result.reservation.id, partial);
      } catch (e) {
        if (e instanceof ReservationRequestError && e.status === 401) onUnauthorized();
        else setError(errorText(e, t));
      } finally { lock.current = false; setBusy(false); }
    }}>
      <fieldset disabled={busy} className={styles.fields}>
        <label>{t.name}<input value={name} onChange={e => setName(e.target.value)} required maxLength={120} autoComplete="off" /></label>
        <label>{t.contact}<input value={contact} onChange={e => setContact(e.target.value)} maxLength={120} disabled={clearContact} autoComplete="off" />
          {existing ? <small>{t.contactUnchanged}</small> : null}</label>
        {existing ? <label className={styles.inline}><input type="checkbox" checked={clearContact} onChange={e => setClearContact(e.target.checked)} />{t.clearContact}</label> : null}
        <div className={styles.formRow}><label>{t.visitDay}<input type="date" value={date} onChange={e => setDate(e.target.value)} required /></label>
          <label>{t.time}<input type="time" value={time} onChange={e => setTime(e.target.value)} required /></label></div>
        <p className={styles.muted}>{t.zoneHint}</p>
        <div className={styles.formRow}><label>{t.party}<input type="number" min={1} max={200} value={party} onChange={e => setParty(Number(e.target.value))} required /></label>
          <label>{t.duration}<input type="number" min={15} max={720} value={duration} onChange={e => setDuration(Number(e.target.value))} required /></label></div>
        {!existing ? <div className={styles.formRow}><label>{t.area}<select aria-label={t.area} value={area} onChange={e => { setArea(e.target.value); setTable(""); }}>
          <option value="">{t.allAreas}</option><option value="bar">{t.bar}</option><option value="floor1">{t.floor1}</option><option value="floor2">{t.floor2}</option></select></label>
          <label>{t.table}<select aria-label={t.table} value={table} onChange={e => setTable(e.target.value)}><option value="">{t.noTable}</option>
            {tables.filter(v => !area || v.area === area).map(v => <option key={v.id} value={v.id}>{v.name}</option>)}</select></label></div> : null}
        <label>{t.note}<textarea value={note} onChange={e => setNote(e.target.value)} maxLength={1000} rows={3} /></label>
      </fieldset>
      {error ? <p role="alert" className={styles.error}>{error}</p> : null}
      <footer className={styles.actions}><button type="button" onClick={onClose} disabled={busy}>{t.cancel}</button>
        <button className={styles.primary} disabled={busy}>{busy ? t.saving : t.save}</button></footer>
    </form>
  </ReservationDialog>;
}
