"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { BarField, BarSheet, keepingInputStyle, primaryButtonStyle, secondaryButtonStyle } from "@/components/bar/keeping/KeepingUi";
import { getBusinessDate } from "@/lib/common/business-time";
import { groupVerificationItemsByParty, planVerificationDatePayment } from "@/lib/ledger/payable-display-groups";
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
// 개별 결제 = one item (amount editable up to its remaining); 일괄 결제 = one party's date group
// (every unresolved item paid in full, amount fixed to Σ remaining).
type PaymentTarget = { bulk: boolean; partyId: number; supplierName: string; businessDate: string; items: VerificationItem[] };

const money = (amount: number) => `${new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 3 }).format(amount)} ₫`;
const shortDate = (date: string) => date.slice(5).replace("-", "/");

// "기타 · 결제 미확인": a display-only row at the end of the 미납금 party list plus its
// detail sheet. Items keep their real supplier/party. Payments go through
// /api/admin/ledger/payables/pay with explicit allocations only (never the party-wide
// oldest-first mode, since this group mixes parties): one item, or one party's date group.
export default function PaymentVerificationSection({ group, accounts, vi, canPay, onPaid }: {
  group: VerificationGroup; accounts: Account[]; vi: boolean; canPay: boolean; onPaid: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<PaymentTarget | null>(null);
  const [amount, setAmount] = useState("");
  const [accountId, setAccountId] = useState("");
  const [date, setDate] = useState(getBusinessDate);
  const [memo, setMemo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Date groups start collapsed; keyed by party + date because two parties can share a date.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const single = selected && !selected.bulk ? selected.items[0] : null;
  const bulkPlan = selected?.bulk ? planVerificationDatePayment(selected.items) : null;
  const amountValue = Number(amount);
  const amountValid = single !== null && Number.isFinite(amountValue) && amountValue > 0 && amountValue <= single.remainingAmount && Math.round(amountValue * 1000) / 1000 === amountValue;
  const canSubmit = selected !== null && (selected.bulk ? bulkPlan !== null : amountValid);
  // Same real party together; derived from props, so a paid item/group disappears on reload.
  const partyGroups = groupVerificationItemsByParty(group.items);
  const itemName = (item: VerificationItem) => vi ? item.itemNameVi || item.itemName : item.itemName;
  const count = (value: number) => `${value}${vi ? " khoản" : "건"}`;

  function toggleDate(key: string) {
    setExpanded((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  }

  function start(target: PaymentTarget) {
    setSelected(target); setAmount(target.bulk ? "" : String(target.items[0].remainingAmount)); setAccountId(""); setDate(getBusinessDate()); setMemo(""); setError("");
  }

  async function submit() {
    if (!selected || busy || !canSubmit || !accountId) return;
    const payment = selected.bulk && bulkPlan
      ? { partyId: bulkPlan.partyId, amount: bulkPlan.amount, allocations: bulkPlan.allocations }
      : { partyId: selected.partyId, amount: amountValue, allocations: [{ payableId: selected.items[0].payableId, allocatedAmount: amountValue }] };
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/admin/ledger/payables/pay", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ partyId: payment.partyId, fundAccountId: Number(accountId), occurredAt: `${date}T12:00:00+07:00`, amount: payment.amount, allocations: payment.allocations, memo: memo || null }),
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
        <button type="button" disabled={busy || !canSubmit || !accountId} onClick={() => void submit()} style={{ ...primaryButtonStyle, width: "100%" }}>{busy ? (vi ? "Đang ghi…" : "기록 중…") : (vi ? "Xác nhận thanh toán" : "결제 확정")}</button>
        <button type="button" disabled={busy} onClick={() => setSelected(null)} style={{ ...secondaryButtonStyle, width: "100%" }}>{vi ? "Quay lại" : "목록으로"}</button>
      </> : <button type="button" onClick={() => setOpen(false)} style={{ ...secondaryButtonStyle, width: "100%" }}>{vi ? "Đóng" : "닫기"}</button>}</div>}>
      <div className={styles.payableSheetBody}>
        <p className={styles.verificationNotice} role="note">{vi ? "Số tiền này không được tính vào công nợ cuối tháng. Hãy ghi nhận sau khi đã xác nhận thanh toán thực tế." : "이 금액은 월말 미납에 포함되지 않습니다. 실제 지급 여부를 확인한 뒤 기록하세요."}</p>
        <div className={styles.payableDetailHeader}><strong>🧾 {title}</strong><span>{vi ? "Còn lại" : "남은 금액"} <b>{money(group.amount)}</b></span></div>
        <p className={styles.payableReadOnlyHint} role="note">{canPay
          ? (vi ? "Chỉ ghi khi đã xác nhận thanh toán thực tế." : "실제 지급을 확인한 건만 기록하세요.")
          : (vi ? "Chỉ xem. Không thể ghi thanh toán cho tháng trước." : "조회만 가능합니다. 과거월은 결제를 기록할 수 없습니다.")}</p>
        {error ? <p className={styles.error} role="alert">{error}</p> : null}
        {selected ? <div className={styles.verificationForm}>
          {single ? <div className={styles.detailSummary}>
            <div className={styles.detailTop}><strong>{itemName(single)}</strong><span className={styles.detailStatus}>{vi ? "Thanh toán riêng" : "개별 결제"}</span></div>
            <span className={styles.detailMeta}>{shortDate(single.businessDate)} · {single.supplierName} · {vi ? "Còn lại" : "남은 금액"} {money(single.remainingAmount)}</span>
          </div> : <div className={styles.detailSummary}>
            <div className={styles.detailTop}><strong>{shortDate(selected.businessDate)} · {selected.supplierName}</strong><span className={styles.detailStatus}>{vi ? "Thanh toán gộp" : "일괄 결제"}</span></div>
            <span className={styles.detailMeta}>{count(bulkPlan?.allocations.length ?? 0)} · {vi ? "Thanh toán toàn bộ số còn lại" : "남은 금액 전액 지급"}</span>
          </div>}
          {single ? <BarField label={`💰 ${vi ? "Số tiền" : "지급액"}`} required compact>{({ id }) => <input id={id} inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} style={keepingInputStyle} />}</BarField>
            : bulkPlan ? <div className={styles.allocationPreview}>
              <strong>{vi ? "Phân bổ" : "지급 배분"}</strong>
              {selected.items.filter((item) => item.remainingAmount > 0).map((item) => <span key={item.payableId}><em>{itemName(item)}</em><b>{money(item.remainingAmount)}</b></span>)}
              <span className={styles.verificationBulkTotal}><em>{vi ? "Tổng thanh toán" : "지급 합계"}</em><b>{money(bulkPlan.amount)}</b></span>
            </div> : null}
          <BarField label={`🏦 ${vi ? "Tài khoản chi" : "지급 계정"}`} required compact>{({ id }) => <select id={id} required value={accountId} onChange={(event) => setAccountId(event.target.value)} style={keepingInputStyle}>
            <option value="">{vi ? "Chọn" : "선택"}</option>
            {accounts.map((account) => <option key={account.id} value={account.id}>{account.display_name}</option>)}
          </select>}</BarField>
          <BarField label={`📅 ${vi ? "Ngày thanh toán" : "지급일"}`} required compact>{({ id }) => <input id={id} type="date" min={selected.businessDate} value={date} onChange={(event) => setDate(event.target.value)} style={keepingInputStyle} />}</BarField>
          <BarField label={`📝 ${vi ? "Ghi chú" : "메모"}`} compact>{({ id }) => <input id={id} value={memo} onChange={(event) => setMemo(event.target.value)} style={keepingInputStyle} />}</BarField>
        </div> : <div className={styles.verificationList}>
          {partyGroups.map((partyGroup) => <section key={partyGroup.partyId} className={styles.verificationGroup} aria-label={partyGroup.name}>
            <div className={styles.verificationGroupHeader}><strong>{partyGroup.name}</strong><span>{count(partyGroup.count)} · {money(partyGroup.amount)}</span></div>
            {/* Date and supplier live in the headers only; item rows are name · remaining · 개별 결제. */}
            {partyGroup.dates.map((dateGroup) => {
              const key = `${partyGroup.partyId}:${dateGroup.businessDate}`;
              const dateOpen = expanded.has(key);
              // 일괄 결제 only when 2+ unresolved items remain on this date (and never in a past month).
              const bulkable = canPay && (planVerificationDatePayment(dateGroup.items)?.allocations.length ?? 0) >= 2;
              return <div key={key} role="group" className={styles.verificationDate} aria-label={shortDate(dateGroup.businessDate)}>
                {/* Toggle and 일괄 결제 are sibling buttons, so a bulk tap never toggles the date. */}
                <div className={styles.verificationDateHeader}>
                  <button type="button" className={styles.verificationDateToggle} aria-expanded={dateOpen} onClick={() => toggleDate(key)}>
                    <i aria-hidden className={dateOpen ? styles.dateChevronOpen : undefined}>›</i>
                    <span>{shortDate(dateGroup.businessDate)} · {count(dateGroup.count)} · <b>{money(dateGroup.amount)}</b></span>
                  </button>
                  {bulkable ? <button type="button" className={`${styles.itemAction} ${styles.verificationBulkAction}`} onClick={() => start({ bulk: true, partyId: partyGroup.partyId, supplierName: partyGroup.name, businessDate: dateGroup.businessDate, items: dateGroup.items })}>{vi ? "Thanh toán gộp" : "일괄 결제"}</button> : null}
                </div>
                {/* One row: name (ellipsis) | remaining | 개별 결제 */}
                {dateOpen ? dateGroup.items.map((item) => <article key={item.payableId} className={styles.verificationItem}>
                  <strong className={styles.verificationName}>{itemName(item)}</strong><strong className={styles.verificationItemAmount} aria-label={vi ? "Còn lại" : "남은 금액"}>{money(item.remainingAmount)}</strong>
                  {canPay ? <button type="button" className={styles.itemAction} onClick={() => start({ bulk: false, partyId: item.partyId, supplierName: item.supplierName, businessDate: item.businessDate, items: [item] })}>{vi ? "Thanh toán riêng" : "개별 결제"}</button> : null}
                </article>) : null}
              </div>;
            })}
          </section>)}
        </div>}
      </div>
    </BarSheet>, document.body) : null}
  </>;
}
