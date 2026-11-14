"use client";
import { useEffect, useId, useRef } from "react";
import styles from "./reservations.module.css";

export default function ReservationDialog({ title, closeLabel, onClose, busy = false, children }: {
  title: string; closeLabel: string; onClose: () => void; busy?: boolean; children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const el = ref.current; const previous = document.activeElement as HTMLElement | null;
    el?.showModal(); const overflow = document.body.style.overflow; document.body.style.overflow = "hidden";
    return () => { el?.close(); document.body.style.overflow = overflow; previous?.focus(); };
  }, []);
  return <dialog ref={ref} className={styles.dialog} aria-labelledby={titleId} onCancel={event => {
    event.preventDefault(); if (!busy) onClose();
  }}><header className={styles.dialogHeader}><h2 id={titleId}>{title}</h2>
    <button type="button" disabled={busy} onClick={onClose}>{closeLabel}</button></header>{children}</dialog>;
}
