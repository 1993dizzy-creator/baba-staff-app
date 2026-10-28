"use client";

import { useState } from "react";
import styles from "./entries.module.css";

type CancelledRow = {
  id: number; type: string; business_date: string; amount: number | string; memo: string | null;
  display_snapshot?: { titleOverride?: string } | null; category?: { name?: string } | null;
  cancellation: { reason: string | null; at: string; actorUserId: number | null } | null;
};

const money = (value: number) => `${new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 }).format(Math.round(value))} ₫`;

// 삭제된 수동 거래: excluded from the list and every total, still readable here with why
// and when. Loaded only when opened, once per month and version.
export default function CancelledManualTransactions({ lang, month, version }: { lang: "ko" | "vi"; month: string; version: number }) {
  const vi = lang === "vi";
  const [state, setState] = useState<{ key: string; rows: CancelledRow[] | null; error: boolean } | null>(null);
  const key = `${month}:${version}`;
  async function load() {
    setState({ key, rows: null, error: false });
    try {
      const response = await fetch(`/api/admin/ledger/transactions/cancelled?month=${month}`, { cache: "no-store" });
      const body = await response.json();
      if (!response.ok || body.month !== month) throw new Error(body.code);
      setState({ key, rows: body.transactions as CancelledRow[], error: false });
    } catch {
      setState({ key, rows: null, error: true });
    }
  }
  const current = state?.key === key ? state : null;
  return <details className={styles.cancelledSection} data-cancelled-manual onToggle={event => { if ((event.currentTarget as HTMLDetailsElement).open && !current) void load(); }}>
    <summary>🗑️ {vi ? "Giao dịch thủ công đã xóa" : "삭제된 수동 거래"}{current?.rows ? ` ${current.rows.length}` : ""}</summary>
    {current?.error ? <p className={styles.error} role="alert">{vi ? "Không tải được danh sách đã xóa." : "삭제 내역을 불러오지 못했습니다."}</p>
      : !current?.rows ? <p className={styles.cancelledEmpty}>{vi ? "Đang tải…" : "불러오는 중…"}</p>
      : !current.rows.length ? <p className={styles.cancelledEmpty}>{vi ? "Không có giao dịch đã xóa trong tháng này." : "이번 달에 삭제된 수동 거래가 없습니다."}</p>
      : <ul className={styles.cancelledList}>{current.rows.map(row => <li key={row.id} data-cancelled-transaction-id={row.id}>
        <div><strong>{row.display_snapshot?.titleOverride || row.memo || row.category?.name || `#${row.id}`}</strong>
          <span>{row.business_date} · {row.type === "income" ? (vi ? "Thu" : "수입") : row.type === "expense" ? (vi ? "Chi" : "지출") : row.type === "transfer" ? (vi ? "Chuyển tiền" : "이체") : row.type} · #{row.id}</span>
          {row.cancellation ? <span>{vi ? "Lý do xóa" : "삭제 사유"}: {row.cancellation.reason ?? "—"} · {new Date(row.cancellation.at).toLocaleString(vi ? "vi-VN" : "ko-KR", { timeZone: "Asia/Ho_Chi_Minh", hour12: false })}</span>
            : <span>{vi ? "Đã hủy trước đây (quy trình khác)" : "이전 절차로 취소된 거래"}</span>}
        </div>
        <s>{money(Number(row.amount))}</s>
      </li>)}</ul>}
  </details>;
}
