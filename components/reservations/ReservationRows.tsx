import type { Reservation, ReservationTable } from "@/lib/reservations/types";
import type { ReservationCopy } from "@/lib/text/reservations";
import { clock } from "./client";
import styles from "./reservations.module.css";

export default function ReservationRows({ items, tables, t, busy, canConfirm, onSelect, onConfirm }: {
  items: Reservation[]; tables: ReservationTable[]; t: ReservationCopy; busy: boolean; canConfirm: boolean;
  onSelect: (id: number) => void; onConfirm: (r: Reservation) => void;
}) {
  return <div className={styles.cards}>{items.map(r => <article key={r.id} className={styles.card}>
    <button className={styles.cardMain} disabled={busy} onClick={() => onSelect(r.id)} aria-label={`${t.detail} #${r.id}`}>
      <div className={styles.cardTitle}><time dateTime={r.reservedAt}>{clock(r.reservedAt)}</time><strong>{r.customerName ?? `#${r.id}`}</strong>
        <span className={styles.badge} data-state={r.status}>{t.states[r.status]}</span></div>
      <div className={styles.cardMeta}><span>{r.partySize} · {t.party}</span><span>{t.table}: {r.tables.map(l => tables.find(v => v.id === l.tableId)?.name ?? "—").join(", ") || t.noTable}</span></div>
      <div className={styles.cardMeta}><span>{t.assignedStaff}: {r.confirmedBy ? `${t.staff} #${r.confirmedBy}` : t.unknownStaff}</span>
        <span>{t.visitDay}: {r.reservedAt ? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(r.reservedAt)) : "—"}</span>
        <span>{t.businessDay}: {r.businessDate}</span></div>
    </button>
    {r.status === "pending" && canConfirm ? <button className={styles.confirmButton} disabled={busy} onClick={() => onConfirm(r)}>{t.confirm}</button> : null}
  </article>)}</div>;
}
