"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { BarField, BarSheet, keepingInputStyle, primaryButtonStyle, secondaryButtonStyle } from "@/components/bar/keeping/KeepingUi";
import { getBusinessDate } from "@/lib/common/business-time";
import { groupVerificationItemsByParty } from "@/lib/ledger/payable-display-groups";
import styles from "./entries.module.css";

// Same contract as buildPaymentVerificationItems() in lib/ledger/payment-verification.ts.
export type VerificationItem = {
  payableId: number; partyId: number; businessDate: string; itemName: string; itemNameVi: string | null;
  supplierName: string; quantity: number | null; unitPrice: number | null;
  amount: number; paidAmount: number; remainingAmount: number;
  appPaymentStatus: "unconfirmed" | "confirmed"; paymentDate: string | null;
};
export type Verification = { items: VerificationItem[]; totalPending: number; pendingCount: number };
export type VerificationGroup = { items: VerificationItem[]; count: number; amount: number };
type Account = { id: number; display_name: string };

const money = (amount: number) => `${new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 3 }).format(amount)} ₫`;
const shortDate = (date: string) => date.slice(5).replace("-", "/");

// "기타 · 결제 미확인": a display-only row at the end of the 미납금 party list plus its
// detail sheet. Items keep their real supplier/party. Payments are recorded one item at a
// time (never a group-wide or oldest-first payment, since items belong to different
// parties) through /api/admin/ledger/payables/pay with an explicit single allocation.
export default function PaymentVerificationSection({ group, accounts, vi, canPay, onPaid }: {
  group: VerificationGroup; accounts: Account[]; vi: boolean; canPay: boolean; onPaid: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<VerificationItem | null>(null);
  const [amount, setAmount] = useState("");
  const [accountId, setAccountId] = useState("");
  const [date, setDate] = useState(getBusinessDate);
  const [memo, setMemo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const amountValue = Number(amount);
  const amountValid = selected !== null && Number.isFinite(amountValue) && amountValue > 0 && amountValue <= selected.remainingAmount && Math.round(amountValue * 1000) / 1000 === amountValue;
  // Same real party together; derived from props, so a paid item/group disappears on reload.
  const partyGroups = groupVerificationItemsByParty(group.items);
  const itemName = (item: VerificationItem) => vi ? item.itemNameVi || item.itemName : item.itemName;

  function start(item: VerificationItem) {
    setSelected(item); setAmount(String(item.remainingAmount)); setAccountId(""); setDate(getBusinessDate()); setMemo(""); setError("");
  }

  async function submit() {
    if (!selected || busy || !amountValid || !accountId) return;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/admin/ledger/payables/pay", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ partyId: selected.partyId, fundAccountId: Number(accountId), occurredAt: `${date}T12:00:00+07:00`, amount: amountValue, allocations: [{ payableId: selected.payableId, allocatedAmount: amountValue }], memo: memo || null }),
      });
      if (!response.ok) throw new Error("PAYMENT_FAILED");
      setSelected(null);
      await onPaid();
    } catch {
      setError(vi ? "Không thể ghi nhận thanh toán. Vui lòng kiểm tra lại." : "결제를 기록하지 못했습니다. 입력 내용을 확인해주세요.");
    } finally { setBusy(false); }
  }

  const title = vi ? "Khác · Chưa xác minh thanh toán" : "기타 · 결제 미확인";
  return <>
    {/* Same markup/classes as a party row in .payableParties */}
    <button type="button" onClick={() => setOpen(true)}>
      <span className={styles.payablePartyMain}>
        <span className={styles.partnerTypeBadge}>{vi ? "Khác" : "기타"}</span>
        <span className={styles.payablePartyName}>{vi ? "Khác" : "기타"} <em className={styles.verificationBadge}>{vi ? "Chưa xác minh" : "결제 미확인"}</em></span>
        <small className={styles.payablePartyPeriod}>{vi ? "Không tính vào công nợ cuối tháng · Cần xác nhận thanh toán" : "월말 미납 제외 · 실제 지급 확인 필요"}</small>
      </span>
      {/* Warning tone: this is not confirmed outstanding and is excluded from 월말 미납. */}
      <strong className={styles.verificationAmount} aria-label={vi ? "Cần kiểm tra" : "확인 필요"}><span className={styles.verificationAmountLabel}>{vi ? "Cần kiểm tra" : "확인 필요"}</span> {money(group.amount)}</strong><small>{group.count}{vi ? " khoản" : "건"}</small><i aria-hidden>›</i>
    </button>
    {/* Portaled so the .payableParties row styles never reach the sheet buttons. */}
    {open ? createPortal(<BarSheet kind="full" compact topAligned comfortableTop fillAvailable containedBody title={title} closeLabel={vi ? "Đóng" : "닫기"} saving={busy} onClose={() => { setSelected(null); setOpen(false); }}
      footer={<div className={styles.detailFooter}>{selected ? <>
        <button type="button" disabled={busy || !amountValid || !accountId} onClick={() => void submit()} style={{ ...primaryButtonStyle, width: "100%" }}>{busy ? (vi ? "Đang ghi…" : "기록 중…") : (vi ? "Xác nhận thanh toán" : "결제 확정")}</button>
        <button type="button" disabled={busy} onClick={() => setSelected(null)} style={{ ...secondaryButtonStyle, width: "100%" }}>{vi ? "Quay lại" : "목록으로"}</button>
      </> : <button type="button" onClick={() => setOpen(false)} style={{ ...secondaryButtonStyle, width: "100%" }}>{vi ? "Đóng" : "닫기"}</button>}</div>}>
      <div className={styles.payableSheetBody}>
        <p className={styles.verificationNotice} role="note">{vi ? "Số tiền này không được tính vào công nợ cuối tháng. Hãy ghi nhận sau khi đã xác nhận thanh toán thực tế." : "이 금액은 월말 미납에 포함되지 않습니다. 실제 지급 여부를 확인한 뒤 기록하세요."}</p>
        <div className={styles.payableDetailHeader}><strong>🧾 {title}</strong><span>{vi ? "Còn lại" : "남은 금액"} <b>{money(group.amount)}</b></span></div>
        <p className={styles.payableReadOnlyHint} role="note">{canPay
          ? (vi ? "Chỉ ghi khi đã xác nhận thanh toán thực tế, từng khoản một." : "실제 지급을 확인한 건만 한 건씩 기록하세요.")
          : (vi ? "Chỉ xem. Không thể ghi thanh toán cho tháng trước." : "조회만 가능합니다. 과거월은 결제를 기록할 수 없습니다.")}</p>
        {error ? <p className={styles.error} role="alert">{error}</p> : null}
        {selected ? <div className={styles.verificationForm}>
          <div className={styles.detailSummary}>
            <div className={styles.detailTop}><strong>{itemName(selected)}</strong><span className={styles.detailStatus}>{vi ? "Chưa xác minh" : "결제 미확인"}</span></div>
            <span className={styles.detailMeta}>{shortDate(selected.businessDate)} · {selected.supplierName} · {vi ? "Còn lại" : "남은 금액"} {money(selected.remainingAmount)}</span>
          </div>
          <BarField label={`💰 ${vi ? "Số tiền" : "지급액"}`} required compact>{({ id }) => <input id={id} inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} style={keepingInputStyle} />}</BarField>
          <BarField label={`🏦 ${vi ? "Tài khoản chi" : "지급 계정"}`} required compact>{({ id }) => <select id={id} required value={accountId} onChange={(event) => setAccountId(event.target.value)} style={keepingInputStyle}>
            <option value="">{vi ? "Chọn" : "선택"}</option>
            {accounts.map((account) => <option key={account.id} value={account.id}>{account.display_name}</option>)}
          </select>}</BarField>
          <BarField label={`📅 ${vi ? "Ngày thanh toán" : "지급일"}`} required compact>{({ id }) => <input id={id} type="date" min={selected.businessDate} value={date} onChange={(event) => setDate(event.target.value)} style={keepingInputStyle} />}</BarField>
          <BarField label={`📝 ${vi ? "Ghi chú" : "메모"}`} compact>{({ id }) => <input id={id} value={memo} onChange={(event) => setMemo(event.target.value)} style={keepingInputStyle} />}</BarField>
        </div> : <div className={styles.verificationList}>
          {partyGroups.map((partyGroup) => <section key={partyGroup.partyId} className={styles.verificationGroup} aria-label={partyGroup.name}>
            <div className={styles.verificationGroupHeader}><strong>{partyGroup.name}</strong><span>{partyGroup.count}{vi ? " khoản" : "건"} · {money(partyGroup.amount)}</span></div>
            {partyGroup.items.map((item) => <article key={item.payableId} className={styles.verificationItem}>
            <div className={styles.verificationTop}><span>{shortDate(item.businessDate)} · <b>{item.supplierName}</b></span><strong aria-label={vi ? "Còn lại" : "남은 금액"}>{money(item.remainingAmount)}</strong></div>
            <strong className={styles.verificationName}>{itemName(item)}</strong>
            {item.quantity != null || item.unitPrice != null ? <small>{vi ? "Số lượng" : "수량"} {item.quantity ?? "-"} · {vi ? "Đơn giá" : "단가"} {item.unitPrice == null ? "-" : money(item.unitPrice)}</small> : null}
            <small>{vi ? "Giá trị nhập" : "입고금액"} {money(item.amount)} · {vi ? "Đã ghi nhận" : "기록된 지급"} {money(item.paidAmount)} · <em className={styles.verificationStatus}>{vi ? "Chưa xác minh thanh toán" : "결제 미확인"}</em></small>
            {canPay ? <button type="button" className={styles.itemAction} onClick={() => start(item)}>{vi ? "Ghi nhận thanh toán thực tế" : "실제 결제 기록"}</button> : null}
          </article>)}
          </section>)}
        </div>}
      </div>
    </BarSheet>, document.body) : null}
  </>;
}
