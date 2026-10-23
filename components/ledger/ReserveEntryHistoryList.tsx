"use client";

import { useEffect, useRef } from "react";
import { reserveEntryDisplaySign, reserveEntryTypeText } from "@/lib/ledger/reserve-text";
import { ledgerSettingsText } from "@/lib/ledger/settings-text";
import styles from "./ReserveEntryHistoryList.module.css";

export type ReserveHistoryEntry = { id: number; entry_type: string; amount: number | string; occurred_at: string; memo: string | null };

const money = (value: number) => `${new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 }).format(Math.round(value))} ₫`;
// YYYY.MM.DD in business time (Asia/Ho_Chi_Minh), the same for KO and VI.
const formatDate = (value: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value)).replaceAll("-", ".");

// Read-only '준비금 기록' list shared by the settings reserve history and the
// ledger reserve detail sheet. Newest first; amounts carry a display-only sign
// and colour (outflows red, allocations and positive adjustments green).
export default function ReserveEntryHistoryList({ entries, lang, title, selectedId = null }: {
  entries: readonly ReserveHistoryEntry[];
  lang: "ko" | "vi";
  title: string;
  selectedId?: number | null;
}) {
  const copy = ledgerSettingsText[lang];
  const sorted = [...entries].sort((a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at) || b.id - a.id);
  const selectedRef = useRef<HTMLDivElement>(null);
  useEffect(() => { selectedRef.current?.scrollIntoView({ block: "nearest" }); }, [selectedId]);
  return (
    <div className={styles.group}>
      <strong>{title}</strong>
      <div className={styles.list}>
        {sorted.map((entry) => {
          const amount = Number(entry.amount);
          const sign = reserveEntryDisplaySign(entry.entry_type, amount);
          const selected = entry.id === selectedId;
          const memo = entry.memo?.trim() ? entry.memo : null;
          return (
            <div
              key={entry.id}
              ref={selected ? selectedRef : undefined}
              className={selected ? `${styles.row} ${styles.selected}` : styles.row}
              aria-current={selected ? "true" : undefined}
              data-reserve-entry-id={entry.id}
            >
              <div className={styles.head}>
                <span className={styles.label}>
                  <strong>{reserveEntryTypeText(entry.entry_type, lang)}</strong>
                  <time dateTime={entry.occurred_at}>{formatDate(entry.occurred_at)}</time>
                </span>
                <b className={sign ? styles.outflow : styles.inflow}>{sign}{money(Math.abs(amount))}</b>
              </div>
              <p className={memo ? styles.memo : `${styles.memo} ${styles.noMemo}`}>{memo ?? copy.noMemo}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
