"use client";

import { useEffect, useState } from "react";
import { BarField, BarSheet, keepingInputStyle, primaryButtonStyle } from "@/components/bar/keeping/KeepingUi";
import { planSelectedAdHocPayment } from "@/lib/ledger/ad-hoc-payable";
import { sumPayableAmounts } from "@/lib/ledger/payables";
import styles from "./entries.module.css";

type Row = { id: number; outstandingAmount: number; original_amount: number | string; expense: { business_date: string; memo?: string | null; source_snapshot?: Record<string, unknown> | null; display_snapshot?: Record<string, unknown> | null } | null };
type Detail = { payables: Row[]; totalOutstanding: number };
type Account = { id: number; display_name: string; is_active: boolean };
const money = (amount: number) => `${amount.toLocaleString("vi-VN", { maximumFractionDigits: 3 })} ₫`;

export default function AdHocPayableSheet({ lang, party, accounts, onClose, onPaid }: {
  lang: "ko" | "vi"; party: { partyId: number; partyName: string }; accounts: Account[]; onClose: () => void; onPaid: () => Promise<void>;
}) {
  const vi = lang === "vi";
  const [detail, setDetail] = useState<Detail | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [amount, setAmount] = useState("");
  const [accountId, setAccountId] = useState("");
  const [occurredAt, setOccurredAt] = useState(() => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 16));
  const [memo, setMemo] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setDetail(null); setSelectedIds(new Set()); setAmount(""); setError("");
    void (async () => {
      try {
        const response = await fetch(`/api/admin/ledger/payables/${party.partyId}`, { signal: controller.signal });
        const body = await response.json();
        if (!response.ok) throw new Error("load");
        if (!controller.signal.aborted) setDetail(body);
      } catch {
        if (!controller.signal.aborted) setError(vi ? "Không thể tải công nợ." : "미납금을 불러오지 못했습니다.");
      }
    })();
    return () => controller.abort();
  }, [party.partyId, vi]);
  const open = (detail?.payables ?? []).filter(row => row.outstandingAmount > 0);
  const selectedTotal = sumPayableAmounts(open.filter(row => selectedIds.has(row.id)).map(row => row.outstandingAmount));
  const plan = planSelectedAdHocPayment(open.map(row => ({ id: row.id, businessDate: row.expense?.business_date ?? "", outstandingAmount: row.outstandingAmount })), selectedIds, amount.trim() ? Number(amount) : selectedTotal);
  async function pay() {
    if (saving || plan.error || !accounts.some(account => account.is_active && String(account.id) === accountId) || !occurredAt) return;
    setSaving(true); setError("");
    try {
      const response = await fetch("/api/admin/ledger/payables/pay", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ partyId: party.partyId, fundAccountId: Number(accountId), occurredAt: `${occurredAt}:00+07:00`, amount: plan.amount, allocations: plan.allocations, memo: memo.trim() || null }) });
      if (!response.ok) throw new Error("pay");
      setSaving(false);
      await onPaid();
    } catch { setError(vi ? "Không thể thanh toán. Vui lòng kiểm tra và thử lại." : "결제하지 못했습니다. 확인 후 다시 시도해주세요."); }
    finally { setSaving(false); }
  }
  return <BarSheet kind="full" compact topAligned comfortableTop fillAvailable containedBody closeLabel={vi ? "??ng" : "??"} saving={saving} title={party.partyName} onClose={onClose} footer={<button type="button" disabled={saving || !!plan.error || !accountId || !occurredAt} onClick={() => void pay()} style={primaryButtonStyle}>{saving ? (vi ? "Đang thanh toán…" : "결제 중…") : (vi ? "Thanh toán khoản đã chọn" : "선택 미납건 결제")}</button>}>
    <div className={styles.payableSheetBody}>
      <p>{vi ? "Chọn từng khoản công nợ. Chỉ phân bổ vào các khoản đã chọn." : "개별 미납건을 선택해주세요. 선택한 건에만 지급액을 배분합니다."}</p>
      {error ? <p role="alert" className={styles.error}>{error}</p> : null}
      {!detail && !error ? <p>{vi ? "Đang tải…" : "불러오는 중…"}</p> : null}
      {(detail?.payables ?? []).map(row => {
        const source = { ...row.expense?.source_snapshot, ...row.expense?.display_snapshot };
        const label = String((vi ? source?.item_name_vi : source?.item_name) ?? source?.item_name ?? source?.title ?? "-");
        return <label key={row.id} className={styles.paymentHistoryRow}>
          <input type="checkbox" checked={selectedIds.has(row.id)} disabled={saving || row.outstandingAmount <= 0} onChange={() => { setSelectedIds(current => { const next = new Set(current); if (next.has(row.id)) next.delete(row.id); else next.add(row.id); return next; }); setAmount(""); }} />
          <span>{row.expense?.business_date} · {label}<br />{row.expense?.memo ?? "-"}</span>
          <span>{vi ? "Gốc" : "원금"} {money(Number(row.original_amount))}<br /><strong>{vi ? "Còn lại" : "미납"} {money(row.outstandingAmount)}</strong></span>
        </label>;
      })}
      {detail && !open.length ? <p>{vi ? "Không có công nợ chưa thanh toán." : "미납금이 없습니다."}</p> : null}
      <p>{vi ? "Công nợ đã chọn" : "선택 미납금"}: {money(selectedTotal)}</p>
      <BarField label={vi ? "Số tiền thanh toán" : "지급액"} required>{({ id }) => <input id={id} inputMode="decimal" value={amount || String(selectedTotal)} disabled={saving} onChange={event => setAmount(event.target.value)} style={keepingInputStyle} />}</BarField>
      {plan.error === "exceeds_outstanding" || plan.error === "invalid_amount" ? <p role="alert">{vi ? "Nhập số tiền hợp lệ trong phạm vi công nợ đã chọn." : "선택한 미납금 이내의 올바른 지급액을 입력해주세요."}</p> : null}
      <BarField label={vi ? "Tài khoản chi" : "출금 계정"} required>{({ id }) => <select id={id} value={accountId} disabled={saving} onChange={event => setAccountId(event.target.value)} style={keepingInputStyle}><option value="">{vi ? "Chọn tài khoản" : "계정 선택"}</option>{accounts.filter(account => account.is_active).map(account => <option key={account.id} value={account.id}>{account.display_name}</option>)}</select>}</BarField>
      <BarField label={vi ? "Thời gian thanh toán" : "결제 일시"} required>{({ id }) => <input id={id} type="datetime-local" value={occurredAt} disabled={saving} onChange={event => setOccurredAt(event.target.value)} style={keepingInputStyle} />}</BarField>
      <BarField label={vi ? "Ghi chú" : "메모"}>{({ id }) => <input id={id} value={memo} disabled={saving} onChange={event => setMemo(event.target.value)} style={keepingInputStyle} />}</BarField>
    </div>
  </BarSheet>;
}
