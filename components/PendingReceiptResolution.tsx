"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useLanguage } from "@/lib/language-context";
import { fetchSalesApi } from "@/lib/sales/client-auth";
import { validResolutionPayments } from "@/lib/sales/pending-resolution-policy";
const ResolvedReceiptWork = dynamic(() => import("./ResolvedReceiptWork"));

type Review = {
  workAvailable?: boolean;
  enabled?: boolean; eligible?: boolean; fingerprint: string; revision: number;
  rawDuplicateGroups?: number;
  daySourceDrift?: boolean;
  monthClosed?: boolean; hasInventoryHistory?: boolean; canReclose?: boolean;
  closure?: { fingerprint: string } | null;
  timing?: { eligibleAt: string; fallbackReason?: string | null };
  resolution?: { decision: string; confirmed_at: string; reason: string; evidence: string; result?: { actorUsername?: string } } | null;
  lastObservation?: { reconciliation: string; observed_at: string; detail_payment_status: number } | null;
};
const copy = {
  ko: {
    title: "관리자 수금 확인 필요", wait: "결제예정 30분 경과 후 실제 수금 또는 취소 증빙을 확인해 주세요.",
    disabled: "확정 기능은 현재 비활성화되어 있습니다.", fallback: "POS 시각이 없거나 미래여서 최초 BABA 수집 시각을 기준으로 합니다.",
    duplicate: "중복 의심 품목이 있습니다. 품목은 자동 삭제되지 않습니다. 실제 수량을 별도로 확인하세요.",
    mismatch: "입력 금액이 원본 금액과 다릅니다. 수금 증빙과 차이를 다시 확인하세요.",
    amount: "실제 확인한 수금액 (정수 VND)", reason: "필수 처리 사유", evidence: "필수 증빙 참조 (수금/취소/환불 기록)",
    paid: "결제완료 확정", cancel: "취소 확정", recheck: "POS 상태 재검증", cash: "현금", transfer: "이체", card: "카드", other: "기타",
    adjustment: "기입된 수금의 환불/수금 조정 증빙을 확인했습니다.", reclose: "Owner/Master로 기존 마감 변경과 재마감을 승인합니다.",
    closed: "월마감 상태입니다. Owner/Master의 정정 승인 및 재마감 절차가 필요합니다.",
    inventory: "기존 재고 이력이 있어 안전한 복구 검토 전에는 확정할 수 없습니다.",
    needsReclose: "이미 일마감되었습니다. Owner/Master 재마감 승인이 필요합니다.",
    sum: "수단별 금액 합계가 실제 수금액과 정확히 같아야 합니다.", failed: "처리에 실패했습니다. 상태를 다시 확인한 후 재시도하세요.",
    protected: "관리자 판정이 보호 중입니다. 품목/결제 정정은 별도 감사 연동 절차가 필요합니다. 재고 자동차감은 보류됩니다.",
    conflict: "POS와 관리자 판정이 충돌합니다. 자동으로 변경하지 않습니다. Owner/Master 검토가 필요합니다.",
    matched: "POS와 관리자 판정의 상태·금액 대조가 완료되었습니다. 품목과 재고 검토는 별도입니다.",
    checked: "POS 재검증 완료", saving: "처리 중…", at: "처리 가능 시각 (베트남)",
    posFinal: "POS가 이미 최종 상태를 반환했습니다. 관리자 확정 전에 기존 POS 동기화와 마감 대조가 필요합니다.",
    confirmedBy: "확정 담당자 / 베트남 확인 시각",
    dayDrift: "기존 마감 후 다른 매출 변경이 있습니다. Owner/Master가 기존 재마감 화면에서 먼저 대조·처리해야 합니다.",
  },
  vi: {
    title: "Cần quản lý xác minh thu tiền", wait: "Sau 30 phút chờ thanh toán, kiểm tra chứng từ thu tiền hoặc hủy.",
    disabled: "Chức năng xác nhận hiện chưa được bật.", fallback: "Giờ POS thiếu hoặc ở tương lai; dùng giờ BABA nhận lần đầu.",
    duplicate: "Có món nghi trùng. Không tự xóa món. Cần kiểm tra số lượng thực tế riêng.",
    mismatch: "Số tiền nhập khác số tiền gốc. Kiểm tra lại chứng từ và chênh lệch.",
    amount: "Số tiền thực thu đã xác minh (VND nguyên)", reason: "Lý do bắt buộc", evidence: "Tham chiếu chứng từ bắt buộc (thu/hủy/hoàn tiền)",
    paid: "Xác nhận đã thanh toán", cancel: "Xác nhận hủy", recheck: "Kiểm tra lại POS", cash: "Tiền mặt", transfer: "Chuyển khoản", card: "Thẻ", other: "Khác",
    adjustment: "Đã kiểm tra chứng từ hoàn tiền/điều chỉnh khoản đã thu.", reclose: "Với vai trò Owner/Master, tôi duyệt thay đổi và chốt lại ngày.",
    closed: "Tháng đã khóa. Cần quy trình phê duyệt điều chỉnh và chốt lại của Owner/Master.",
    inventory: "Đã có lịch sử kho. Phải xem xét khôi phục an toàn trước khi xác nhận.",
    needsReclose: "Ngày đã chốt. Cần Owner/Master duyệt chốt lại.",
    sum: "Tổng từng phương thức phải bằng đúng số tiền thực thu.", failed: "Xử lý thất bại. Kiểm tra trạng thái trước khi thử lại.",
    protected: "Quyết định quản lý được bảo vệ. Sửa món/thanh toán cần quy trình kiểm toán riêng. Tạm dừng tự trừ kho.",
    conflict: "POS và quyết định quản lý mâu thuẫn. Không tự đổi trạng thái. Cần Owner/Master xem xét.",
    matched: "Đã đối chiếu trạng thái và số tiền POS. Món và kho cần kiểm tra riêng.",
    checked: "Đã kiểm tra lại POS", saving: "Đang xử lý…", at: "Thời điểm được xử lý (Việt Nam)",
    posFinal: "POS đã có trạng thái cuối. Cần đồng bộ POS và đối chiếu ngày chốt trước khi quyết định thủ công.",
    confirmedBy: "Người xác nhận / giờ Việt Nam",
    dayDrift: "Nguồn doanh thu đã đổi sau chốt. Owner/Master phải đối chiếu và xử lý tại quy trình chốt lại hiện có trước.",
  },
};
const methods = ["cash", "transfer", "card", "other"] as const;

export default function PendingReceiptResolution({ receiptId, pending, originalAmount, duplicateCount = 0, eligibleAt, fallbackReason, protectedResolution = false }: {
  receiptId: number; pending: boolean; originalAmount: number; duplicateCount?: number;
  eligibleAt?: string | null; fallbackReason?: string | null;
  protectedResolution?: boolean;
}) {
  const { lang } = useLanguage(); const t = copy[lang];
  const [review, setReview] = useState<Review | null>(null);
  const [amount, setAmount] = useState("");
  const [parts, setParts] = useState<Record<string, string>>({});
  const [reason, setReason] = useState(""); const [evidence, setEvidence] = useState("");
  const [adjustment, setAdjustment] = useState(false); const [reclose, setReclose] = useState(false);
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState("");
  const [ageRefresh, setAgeRefresh] = useState(0);
  const inFlight = useRef(false);
  // Retain the exact payload/requestId after a network error so retry is safe.
  const previous = useRef<{ signature: string; id: string } | null>(null);
  useEffect(() => {
    if (!pending && !protectedResolution) return;
    const remaining = Date.parse(eligibleAt || "") - Date.now();
    if (pending && remaining > 0) {
      const timer = setTimeout(() => setAgeRefresh(value => value + 1), Math.min(remaining + 50, 2_147_483_647));
      return () => clearTimeout(timer);
    }
    const controller = new AbortController();
    fetchSalesApi(`/api/admin/sales/receipts/${receiptId}/resolution`, { cache: "no-store", signal: controller.signal })
      .then(async response => { if (response.ok) setReview(await response.json()); else throw new Error(); })
      .catch(() => { if (!controller.signal.aborted) setMessage(t.failed); });
    return () => controller.abort();
  }, [receiptId, t.failed, pending, protectedResolution, eligibleAt, ageRefresh]);
  if (!pending && !protectedResolution && !review?.resolution) return null;
  const locked = !review?.enabled || !review.eligible || review.monthClosed || review.daySourceDrift || (review.hasInventoryHistory && !review.workAvailable) || Boolean(review.closure && (!review.canReclose || !reclose));
  const payments = methods.filter(method => parts[method]?.trim()).map(method => ({ method, amount: Number(parts[method]) }));
  const validPaid = validResolutionPayments(Number(amount), payments);

  async function submit(decision: "paid" | "canceled") {
    if (locked || inFlight.current || !review || !reason.trim() || !evidence.trim() || (decision === "paid" && !validPaid)) return;
    inFlight.current = true; setBusy(true); setMessage("");
    const payload = { expectedRevision: review.revision, fingerprint: review.fingerprint, decision,
      amount: decision === "paid" ? Number(amount) : 0, payments: decision === "paid" ? payments : [],
      reason, evidence, collectionAdjustmentConfirmed: adjustment, allowReclose: reclose, closureFingerprint: review.closure?.fingerprint ?? null };
    const signature = JSON.stringify(payload);
    if (previous.current?.signature !== signature) previous.current = { signature, id: crypto.randomUUID() };
    try {
      const response = await fetchSalesApi(`/api/admin/sales/receipts/${receiptId}/resolution`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...payload, requestId: previous.current.id }) });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(t.failed);
      // Refresh all list/detail/tax/stock views only after server confirmation.
      window.location.reload();
    } catch { setMessage(t.failed); }
    finally { inFlight.current = false; setBusy(false); }
  }
  async function recheck() {
    if (inFlight.current) return; inFlight.current = true; setBusy(true); setMessage("");
    try {
      const response = await fetchSalesApi(`/api/admin/sales/receipts/${receiptId}/resolution/recheck`, { method: "POST" });
      const result = await response.json(); if (!response.ok || !result.ok) throw new Error();
      const refreshed = await fetchSalesApi(`/api/admin/sales/receipts/${receiptId}/resolution`, { cache: "no-store" });
      if (!refreshed.ok) throw new Error(); setReview(await refreshed.json()); setMessage(t.checked);
    } catch { setMessage(t.failed); } finally { inFlight.current = false; setBusy(false); }
  }
  return <section aria-label={t.title} style={{ padding: 16, border: "1px solid #d69e2e", borderRadius: 10, display: "grid", gap: 12, minWidth: 0 }}>
    <strong>{review?.resolution ? t.protected : t.title}</strong>
    {review?.resolution && <>
      <p>{t.confirmedBy}: {review.resolution.result?.actorUsername} / {new Date(review.resolution.confirmed_at).toLocaleString(lang === "ko" ? "ko-KR" : "vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}</p>
      <p>{t.reason}: {review.resolution.reason}</p><p>{t.evidence}: {review.resolution.evidence}</p>
    </>}
    <p>{t.wait}</p>
    {!review?.enabled && <p>{t.disabled}</p>}
    {(review?.timing?.fallbackReason || fallbackReason) && <p>{t.fallback}</p>}
    {(review?.timing?.eligibleAt || eligibleAt) && <p>{t.at}: {new Date(review?.timing?.eligibleAt || eligibleAt || "").toLocaleString(lang === "ko" ? "ko-KR" : "vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}</p>}
    {(duplicateCount > 0 || (review?.rawDuplicateGroups ?? 0) > 0) && <p role="alert">{t.duplicate}</p>}
    {review?.monthClosed && <p role="alert">{t.closed}</p>}
    {review?.hasInventoryHistory && !review.workAvailable && <p role="alert">{t.inventory}</p>}
    {review?.closure && <p>{t.needsReclose}</p>}
    {review?.daySourceDrift && <p role="alert">{t.dayDrift}</p>}
    {review?.lastObservation && <p role="status">{review.lastObservation.reconciliation === "conflict" ? t.conflict : review.lastObservation.reconciliation === "matched" ? t.matched : t.wait}</p>}
    {!review?.resolution && [3, 4, 5].includes(review?.lastObservation?.detail_payment_status ?? 0) && <p role="alert">{t.posFinal}</p>}
    <button type="button" onClick={recheck} disabled={busy || !review?.enabled}>{busy ? t.saving : t.recheck}</button>
    {!review?.resolution && <fieldset disabled={busy || !review?.enabled} style={{ border: 0, padding: 0, display: "grid", gap: 12, minWidth: 0 }}>
      <label>{t.amount}<input aria-label={t.amount} inputMode="numeric" value={amount} onChange={e => setAmount(e.target.value.replace(/[^0-9]/g, ""))} style={{ width: "100%", boxSizing: "border-box" }} /></label>
      {amount && Number(amount) !== originalAmount && <p role="alert">{t.mismatch}</p>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(130px,1fr))", gap: 10 }}>
        {methods.map(method => <label key={method}>{t[method]}<input aria-label={t[method]} inputMode="numeric" value={parts[method] || ""} onChange={e => setParts({ ...parts, [method]: e.target.value.replace(/[^0-9]/g, "") })} style={{ width: "100%", boxSizing: "border-box" }} /></label>)}
      </div>
      <p>{t.sum}</p>
      <label>{t.reason}<textarea required maxLength={2000} value={reason} onChange={e => setReason(e.target.value)} style={{ width: "100%", boxSizing: "border-box" }} /></label>
      <label>{t.evidence}<textarea required maxLength={2000} value={evidence} onChange={e => setEvidence(e.target.value)} style={{ width: "100%", boxSizing: "border-box" }} /></label>
      <label><input type="checkbox" checked={adjustment} onChange={e => setAdjustment(e.target.checked)} />{t.adjustment}</label>
      {review?.closure && review.canReclose && <label><input type="checkbox" checked={reclose} onChange={e => setReclose(e.target.checked)} />{t.reclose}</label>}
      <button type="button" disabled={busy || locked || !validPaid || !reason.trim() || !evidence.trim()} onClick={() => submit("paid")}>{t.paid}</button>
      <button type="button" disabled={busy || locked || !reason.trim() || !evidence.trim()} onClick={() => submit("canceled")}>{t.cancel}</button>
    </fieldset>}
    {review?.resolution && review.workAvailable && <ResolvedReceiptWork receiptId={receiptId} />}
    {message && <p role="status">{message}</p>}
  </section>;
}
