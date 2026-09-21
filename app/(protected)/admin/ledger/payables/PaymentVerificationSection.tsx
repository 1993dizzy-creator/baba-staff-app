"use client";

import { useState, type CSSProperties, type FormEvent } from "react";
import { getBusinessDate } from "@/lib/common/business-time";
import { ui } from "@/lib/styles/ui";

export type VerificationItem = {
  payableId: number; partyId: number; businessDate: string; itemName: string; itemNameVi: string | null;
  supplierName: string; quantity: number | null; unitPrice: number | null;
  amount: number; paidAmount: number; remainingAmount: number;
  appPaymentStatus: "unconfirmed" | "confirmed"; paymentDate: string | null;
};
export type Verification = { items: VerificationItem[]; totalPending: number; pendingCount: number };
type Account = { id: number; display_name: string; is_active: boolean; is_business_fund?: boolean; type?: string };
const money = (amount: number) => `${new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 3 }).format(amount)} ₫`;

export default function PaymentVerificationSection({ verification, accounts, vi, onPaid }: {
  verification: Verification; accounts: Account[]; vi: boolean; onPaid: () => Promise<void>;
}) {
  const [selected, setSelected] = useState<VerificationItem | null>(null);
  const [amount, setAmount] = useState("");
  const [accountId, setAccountId] = useState("");
  const [date, setDate] = useState(getBusinessDate);
  const [memo, setMemo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!selected || busy) return;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/admin/ledger/payables/pay", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ partyId: selected.partyId, fundAccountId: Number(accountId), occurredAt: `${date}T12:00:00+07:00`, amount: Number(amount), allocations: [{ payableId: selected.payableId, allocatedAmount: Number(amount) }], memo: memo || null }),
      });
      if (!response.ok) throw new Error("PAYMENT_FAILED");
      setSelected(null); setAmount(""); setMemo("");
      await onPaid();
    } catch { setError(vi ? "Không thể ghi nhận thanh toán. Vui lòng kiểm tra lại." : "결제를 기록하지 못했습니다. 입력 내용을 확인해주세요."); }
    finally { setBusy(false); }
  }
  return <section aria-labelledby="verification-title" style={styles.section}>
    <h2 id="verification-title">{vi ? "Khác · Chưa xác minh thanh toán" : "기타 · 결제 미확인"}</h2>
    <strong>{money(verification.totalPending)} · {verification.pendingCount}{vi ? " mục" : "건"}</strong>
    <p>{vi ? "Đã xác nhận nhập hàng; cần kiểm tra chứng từ thanh toán." : "입고는 확인됐으며, 실제 지급 근거를 확인해야 합니다."}</p>
    <div style={styles.list}>{verification.items.length ? verification.items.map(item => <article key={item.payableId} style={styles.card}>
      <strong>{item.businessDate} · {vi ? item.itemNameVi || item.itemName : item.itemName}</strong>
      <small>{vi ? "Nhà cung cấp" : "공급처"}: {item.supplierName}</small>
      <small>{vi ? "Số lượng" : "수량"}: {item.quantity ?? "-"} · {vi ? "Đơn giá" : "단가"}: {item.unitPrice == null ? "-" : money(item.unitPrice)}</small>
      <small>{vi ? "Giá trị nhập" : "입고금액"}: {money(item.amount)}</small>
      <small>{vi ? "Trạng thái trong ứng dụng" : "APP상 결제상태"}: {item.paidAmount > 0 ? `${vi ? "Đã ghi nhận" : "기록된 결제"} ${money(item.paidAmount)}` : vi ? "Chưa ghi nhận thanh toán" : "결제 기록 없음"}</small>
      <small>{vi ? "Xác minh" : "상태"}: {item.appPaymentStatus === "confirmed" ? vi ? "Đã xác nhận" : "확인완료" : vi ? "Chưa xác minh thanh toán" : "결제 미확인"}{item.paymentDate ? ` · ${vi ? "Thanh toán" : "결제일"} ${item.paymentDate}` : ""}</small>
      {item.remainingAmount > 0 ? <button type="button" style={styles.action} onClick={() => { setSelected(item); setAmount(String(item.remainingAmount)); }}>{vi ? "Ghi nhận thanh toán" : "실제 결제 기록"}</button> : null}
    </article>) : <p style={styles.card}>{vi ? "Không có mục cần xác minh." : "결제 확인이 필요한 입고가 없습니다."}</p>}</div>
    {selected ? <form onSubmit={submit} style={styles.card}>
      <h3>{vi ? "Ghi nhận thanh toán thực tế" : "실제 결제 기록"}</h3>
      <p>{selected.businessDate} · {vi ? selected.itemNameVi || selected.itemName : selected.itemName}<br />{vi ? "Chỉ ghi khi đã xác nhận thanh toán thực tế." : "실제 지급을 확인한 경우에만 기록하세요."}</p>
      <label>{vi ? "Số tiền" : "지급액"}<input required type="number" min="0.001" step="0.001" max={selected.remainingAmount} value={amount} onChange={event => setAmount(event.target.value)} style={styles.input} /></label>
      <label>{vi ? "Tài khoản chi" : "지급 계정"}<select required value={accountId} onChange={event => setAccountId(event.target.value)} style={styles.input}><option value="">{vi ? "Chọn" : "선택"}</option>{accounts.filter(account => account.is_active && account.is_business_fund !== false && account.type !== "card_clearing").map(account => <option key={account.id} value={account.id}>{account.display_name}</option>)}</select></label>
      <label>{vi ? "Ngày thanh toán" : "지급일"}<input required type="date" min={selected.businessDate} value={date} onChange={event => setDate(event.target.value)} style={styles.input} /></label>
      <label>{vi ? "Ghi chú" : "메모"}<input value={memo} onChange={event => setMemo(event.target.value)} style={styles.input} /></label>
      {error ? <p role="alert">{error}</p> : null}
      <button disabled={busy || !Number(amount) || Number(amount) > selected.remainingAmount || !accountId} style={styles.action}>{vi ? "Xác nhận thanh toán" : "결제 확정"}</button>
      <button type="button" disabled={busy} onClick={() => setSelected(null)}>{vi ? "Hủy" : "취소"}</button>
    </form> : null}
  </section>;
}
const styles = { section: { display: "grid", gap: 8 }, list: { display: "grid", gap: 7 }, card: { ...ui.card, padding: 12, display: "grid", gap: 8 }, input: { ...ui.input, width: "100%" }, action: { ...ui.button, width: "fit-content", padding: "8px 12px" } } satisfies Record<string, CSSProperties>;
