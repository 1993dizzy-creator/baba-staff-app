"use client";
import { useEffect, useState } from "react";
import { secondaryButtonStyle } from "@/components/bar/keeping/KeepingUi";
import { pendingPayablePayment, sendPayablePayment, subscribePayablePayment, type PendingPayablePayment } from "@/lib/ledger/payable-payment-client";
import { payablePaymentErrorMessage } from "@/lib/ledger/payable-payment-messages";

export function PayablePaymentRefreshButton({ vi }: { vi: boolean }) {
  return <button type="button" onClick={() => window.location.reload()} style={secondaryButtonStyle}>{vi ? "Tải lại trang" : "화면 새로고침"}</button>;
}

export default function PayablePaymentRecovery({ partyId, vi, accounts, onConfirmed }: {
  partyId: number; vi: boolean; accounts: { id: number; display_name: string }[]; onConfirmed: () => Promise<void>;
}) {
  const [pending, setPending] = useState<PendingPayablePayment | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const refresh = () => { try { setPending(pendingPayablePayment(partyId)); } catch { setError("PAYMENT_STORAGE_FAILED"); } };
    refresh();
    return subscribePayablePayment(refresh);
  }, [partyId]);
  if (!pending) return null;
  async function retry() {
    if (!pending || busy) return;
    setBusy(true); setError("");
    try { await sendPayablePayment(pending.body, onConfirmed); } catch (cause) { setError((cause as Error).message || "PAYMENT_FAILED"); } finally { setBusy(false); }
  }
  return <aside role="status" style={{ padding: 12, border: secondaryButtonStyle.border, borderRadius: 12, overflowWrap: "anywhere" }}>
    <p>{vi ? "Có yêu cầu thanh toán cần xác nhận. Hãy kiểm tra yêu cầu cũ trước khi ghi khoản mới." : "결과 확인이 필요한 지급 요청이 있습니다. 새 지급 전에 기존 요청의 결과를 확인해 주세요."}</p>
    <p>{new Intl.NumberFormat("vi-VN").format(pending.body.amount)}₫ · {pending.body.occurredAt.slice(0, 10)} · {accounts.find(account => account.id === pending.body.fundAccountId)?.display_name || (vi ? "Tài khoản đã chọn" : "선택한 계좌")}</p>
    <button type="button" disabled={busy} onClick={() => void retry()} style={secondaryButtonStyle}>{busy ? (vi ? "Đang kiểm tra…" : "확인 중…") : (vi ? "Kiểm tra yêu cầu cũ" : "기존 요청 결과 확인")}</button>
    {error ? <p role="alert">{payablePaymentErrorMessage(error, vi)}</p> : null}
    {error === "IDEMPOTENCY_KEY_REQUIRED" ? <PayablePaymentRefreshButton vi={vi} /> : null}
  </aside>;
}
