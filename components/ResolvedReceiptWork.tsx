"use client";
import { useEffect, useRef, useState } from "react";
import { useLanguage } from "@/lib/language-context";
import { fetchSalesApi } from "@/lib/sales/client-auth";
import { validResolutionPayments } from "@/lib/sales/pending-resolution-policy";

type Line = { id: number; productId?: number; item_name: string; item_code: string; quantity: number; unit_price: number;
  discount_amount: number; tax_rate: number; is_excluded?: boolean; parent_ref_detail_id?: string };
type Work = { enabled: boolean; canExecuteInventory: boolean; actorUsername: string; version: number; fingerprint: string;
  resolution: { request_id: string }; state: { receipt: { revision: number; is_canceled: boolean; final_amount: number;
  inventory_deduction_processing_paused: boolean; admin_resolution_financial_review_required?: boolean; tax_override_mode?: string }; lines: Line[];
  payments: { id: number; payment_name: string; amount: number; admin_resolution_retired?: boolean }[] };
  policy: { monthClosed: boolean; canReclose: boolean; daySourceDrift: boolean; closure?: { fingerprint: string }; lastObservation?: { reconciliation: string } };
  history: { id: number; event: string; actor_user_id: number; created_at: string; snapshot?: { reason?: string; result?: { status?: string; workflow?: string } } }[] };
type StockReview = { reviewId: string; blockers: string[]; plan: { workflow: string; activeCount: number;
  expectedRevision: number; resolutionVersion: number; sourceFingerprint: string; amount: number;
  payments: { paymentName: string; amount: number }[];
  lines: { receiptLineId: number; itemName: string; quantitySold: number; deductions: { inventoryItemId: number; deductQuantity: number }[] }[];
  previousDeductions?: { id: number; inventoryItemId: number; quantity: number }[] } };
const words = {
  ko: { title: "관리자 확정 후 정정 · 재고 검증", held: "재고 보류 중", approved: "재고 승인 완료", current: "현재 유효 수금액",
    amount: "다시 확인한 실제 수금액 (VND)", qty: "실수량", price: "단가", discount: "할인", tax: "세율 (%)", include: "유효 품목에 포함", paidState: "결제완료 확정", canceledState: "취소 확정",
    reason: "정정 또는 재고 승인 사유", save: "금액·품목 재정정", cancel: "환불 증빙 후 취소", refund: "환불/수금 조정 증빙 참조",
    refundCheck: "환불·수금 조정 증빙을 확인했습니다", preview: "재고 검증 미리보기", confirm: "검증한 재고 처리 승인 (Owner/Master)",
    warning: "품목은 자동 삭제하지 않습니다. 실제 주문 증빙을 확인하여 포함 여부와 수량을 명시하십시오. 저장 후에도 재고는 보류됩니다.",
    disabled: "기능이 비활성화되어 있습니다.", closed: "마감 보호: 월마감 해제 또는 공식 일마감 재마감 승인이 필요합니다.",
    reclose: "Owner/Master로 공식 재마감까지 함께 승인합니다", conflict: "POS 상태 충돌: 원본과 관리자 판정을 대조하십시오.",
    failed: "처리하지 못했습니다. 최신 상태를 확인하십시오.", refresh: "최신 상태 다시 읽기", history: "감사 이력", empty: "실제 수금액과 결제수단 합계를 직접 입력하십시오.",
    before: "기존 활성 차감", after: "검증 후 차감", blocked: "재고 보류 사유", ready: "검증 완료: 표시된 재고 처리를 별도로 승인하십시오.", dirty: "미저장 정정을 먼저 저장해야 재고 검증을 진행할 수 있습니다.", actor: "실행 담당자",
    cash: "현금", transfer: "이체", card: "카드", other: "기타", noTax: "세금 제외", financial: "품목·세금 합계", busy: "처리 중", search: "상품 코드 검색", add: "증빙 확인한 상품 추가", financialHold: "금액·품목 정정 필요: 정상 매출 집계에서 보류 중이며 마감·장부 반영은 차단됩니다.",
  },
  vi: { title: "Điều chỉnh sau xác nhận · Kiểm tra kho", held: "Đang giữ xử lý kho", approved: "Đã duyệt kho", current: "Thực thu đang có hiệu lực",
    amount: "Thực thu đã kiểm tra lại (VND)", qty: "Số lượng thực", price: "Đơn giá", discount: "Giảm giá", tax: "Thuế suất (%)", include: "Tính vào món có hiệu lực", paidState: "Đã xác nhận thanh toán", canceledState: "Đã xác nhận hủy",
    reason: "Lý do điều chỉnh hoặc duyệt kho", save: "Điều chỉnh tiền và món", cancel: "Hủy sau xác minh hoàn tiền", refund: "Tham chiếu chứng từ hoàn/điều chỉnh tiền",
    refundCheck: "Đã kiểm tra chứng từ hoàn/điều chỉnh tiền", preview: "Xem trước kiểm tra kho", confirm: "Duyệt xử lý kho đã kiểm tra (Owner/Master)",
    warning: "Không tự xóa món. Kiểm tra chứng từ đơn thực tế rồi chọn món và số lượng. Lưu điều chỉnh vẫn giữ xử lý kho.",
    disabled: "Chức năng chưa bật.", closed: "Bảo vệ chốt sổ: cần mở tháng hoặc duyệt chốt lại ngày chính thức.",
    reclose: "Với vai trò Owner/Master, duyệt cả chốt lại ngày chính thức", conflict: "POS mâu thuẫn: đối chiếu dữ liệu gốc và quyết định quản lý.",
    failed: "Chưa xử lý được. Hãy kiểm tra trạng thái mới nhất.", refresh: "Đọc lại trạng thái mới nhất", history: "Lịch sử kiểm toán", empty: "Nhập rõ thực thu và tổng từng phương thức.",
    before: "Lần trừ kho đang có hiệu lực", after: "Trừ kho sau kiểm tra", blocked: "Lý do giữ xử lý kho", ready: "Đã kiểm tra: cần duyệt riêng xử lý kho bên dưới.", dirty: "Lưu điều chỉnh trước khi kiểm tra kho.", actor: "Người thực hiện",
    cash: "Tiền mặt", transfer: "Chuyển khoản", card: "Thẻ", other: "Khác", noTax: "Không tính thuế", financial: "Tổng món và thuế", busy: "Đang xử lý", search: "Tìm mã món", add: "Thêm món đã kiểm tra chứng từ", financialHold: "Cần điều chỉnh tiền và món: chưa tính vào doanh thu chính thức; chặn chốt sổ và ghi sổ.",
  },
};
const methods = ["cash", "transfer", "card", "other"] as const;
const inputStyle = { width: "100%", minWidth: 0, boxSizing: "border-box" as const };
const stockCopy = {
  ko: { initial_apply: "최초 재고 차감", reprocess_modified: "기존 차감 원복 후 재차감", rollback_canceled: "취소 영수증 재고 원복", no_stock_change: "차감 이력 없음: 재고 변동 없이 확인",
    ambiguous_duplicate_order: "같은 실주문 식별자를 가진 품목 중복", duplicate_ref_detail: "중복 POS 품목 식별자", financial_correction_required: "품목·세금·수금액 불일치",
    missing_effective_parent: "유효한 상위 상품이 없는 옵션", duplicate_active_deductions: "활성 원차감 중복", legacy_inventory_link_requires_review: "영수증 연결이 없는 과거 차감 이력", cross_receipt_inventory_history: "다른 영수증과 연결된 차감 이력",
    inventory_already_approved: "이미 승인한 재고 처리: 재정정 후에만 다시 검증 가능", special_mapping_requires_review: "케그·수동·콤보 매핑은 별도 검증 필요", fallback: "검증하지 못한 품목 또는 매핑이 있어 보류합니다" },
  vi: { initial_apply: "Trừ kho lần đầu", reprocess_modified: "Hoàn lần trừ cũ rồi trừ lại", rollback_canceled: "Hoàn kho hóa đơn hủy", no_stock_change: "Không có lần trừ: xác nhận không đổi kho",
    ambiguous_duplicate_order: "Món trùng mã đơn thực tế", duplicate_ref_detail: "Trùng mã chi tiết POS", financial_correction_required: "Món, thuế và thực thu không khớp",
    missing_effective_parent: "Tùy chọn thiếu món cha có hiệu lực", duplicate_active_deductions: "Trùng lần trừ kho đang có hiệu lực", legacy_inventory_link_requires_review: "Lịch sử trừ cũ chưa liên kết hóa đơn", cross_receipt_inventory_history: "Lịch sử kho liên kết hóa đơn khác",
    inventory_already_approved: "Kho đã duyệt: chỉ kiểm tra lại sau điều chỉnh", special_mapping_requires_review: "Cần kiểm tra riêng ánh xạ keg, thủ công hoặc combo", fallback: "Giữ xử lý do món hoặc ánh xạ chưa xác minh" },
};

export default function ResolvedReceiptWork({ receiptId }: { receiptId: number }) {
  const { lang } = useLanguage(); const t = words[lang];
  const [work, setWork] = useState<Work | null>(null); const [lines, setLines] = useState<Line[]>([]);
  const [amount, setAmount] = useState(""); const [parts, setParts] = useState<Record<string, string>>({});
  const [reason, setReason] = useState(""); const [refund, setRefund] = useState(""); const [refundChecked, setRefundChecked] = useState(false);
  const [reclose, setReclose] = useState(false); const [noTax, setNoTax] = useState(false);
  const [stock, setStock] = useState<StockReview | null>(null); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState(""); const [products, setProducts] = useState<Array<{ id: number; item_name: string; item_code: string; unit_price: number; tax_rate: number }>>([]);
  const nextLineId = useRef(-1);
  const flight = useRef(false); const previous = useRef<{ signature: string; requestId: string } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetchSalesApi(`/api/admin/sales/receipts/${receiptId}/resolution/work`, { cache: "no-store", signal: controller.signal })
      .then(async response => { if (!response.ok) throw new Error(); const data = await response.json(); setWork(data);
        if (data.state) { setLines(data.state.lines); setNoTax(data.state.receipt.tax_override_mode === "exclude_all"); } })
      .catch(() => { if (!controller.signal.aborted) setError(t.failed); });
    return () => controller.abort();
  }, [receiptId, t.failed]);
  const payments = methods.filter(m => parts[m]?.trim()).map(method => ({ method, amount: Number(parts[method]) }));
  const total = lines.filter(l => !l.is_excluded).reduce((sum, l) => {
    const net = Math.round(Number(l.quantity) * Number(l.unit_price)) - Number(l.discount_amount || 0);
    return sum + net + (noTax ? 0 : Math.round(net * Number(l.tax_rate || 0) / 100));
  }, 0);
  const locked = !work?.enabled || work.policy?.monthClosed || work.policy?.daySourceDrift || Boolean(work.policy?.closure && (!work.policy.canReclose || !reclose));
  const values = (rows: Line[]) => rows.map(l => [l.id, Number(l.quantity), Number(l.unit_price), Number(l.discount_amount || 0), Number(l.tax_rate || 0), Boolean(l.is_excluded)]);
  const dirty = Boolean(work?.state && (JSON.stringify(values(lines)) !== JSON.stringify(values(work.state.lines)) ||
    noTax !== (work.state.receipt.tax_override_mode === "exclude_all") || amount || Object.values(parts).some(Boolean)));
  const canSave = !locked && !busy && !work?.state?.receipt.is_canceled && Boolean(reason.trim()) && validResolutionPayments(Number(amount), payments) && total === Number(amount);
  async function submit(action: "correct" | "preview" | "confirm", canceled = false) {
    if (flight.current || !work?.state || (action !== "correct" && dirty) || (action !== "preview" && (!reason.trim() || locked))) return;
    flight.current = true; setBusy(true); setError("");
    const payload = { action, reason, resolutionId: work.resolution.request_id, resolutionVersion: work.version,
      expectedRevision: work.state.receipt.revision, fingerprint: work.fingerprint, decision: canceled ? "canceled" : "paid",
      amount: Number(amount), payments, lines: lines.filter(l => !l.is_excluded).map(l => ({ id: l.id > 0 ? l.id : null, productId: l.productId, quantity: Number(l.quantity), unit_price: Number(l.unit_price), discount_amount: Number(l.discount_amount || 0), tax_rate: Number(l.tax_rate || 0) })),
      taxMode: noTax ? "exclude_all" : "apply", refundConfirmed: refundChecked, refundEvidence: refund,
      reviewId: stock?.reviewId, approveReclose: reclose, closureFingerprint: work.policy.closure?.fingerprint ?? null };
    const signature = JSON.stringify(payload);
    if (previous.current?.signature !== signature) previous.current = { signature, requestId: crypto.randomUUID() };
    try {
      const response = await fetchSalesApi(`/api/admin/sales/receipts/${receiptId}/resolution/work`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...payload, requestId: previous.current.requestId }) });
      const data = await response.json(); if (!response.ok || !data.ok) throw new Error(data.error || t.failed);
      if (action === "preview") setStock(data); else window.location.reload();
    } catch (e) { const code = e instanceof Error ? e.message : "";
      setError(code.includes("MONTH_CLOSED") || code.includes("RECLOSE") ? t.closed : code.includes("FINANCIAL_CORRECTION") ? t.financialHold : t.failed); }
    finally { flight.current = false; setBusy(false); }
  }
  function updateLine(index: number, patch: Partial<Line>) { setLines(current => current.map((l, i) => i === index ? { ...l, ...patch } : l)); setStock(null); }
  async function searchProducts() {
    if (flight.current || !query.trim()) return;
    flight.current = true; setBusy(true); setError("");
    try {
      const response = await fetchSalesApi(`/api/admin/sales/receipts/${receiptId}/resolution/work?products=${encodeURIComponent(query)}`, { cache: "no-store" });
      const data = await response.json(); if (!response.ok || !data.ok) throw new Error(); setProducts(data.products);
    } catch { setError(t.failed); } finally { flight.current = false; setBusy(false); }
  }
  if (!work?.enabled) return <p role="status">{error || t.disabled}</p>;
  return <section aria-label={t.title} style={{ display: "grid", gap: 12, minWidth: 0, paddingTop: 16 }}>
    <strong>{t.title} · v{work.version}</strong>
    <p>{work.state.receipt.is_canceled ? t.canceledState : t.paidState}</p>
    <p>{work.state.receipt.inventory_deduction_processing_paused ? t.held : t.approved}</p>
    {work.state.receipt.admin_resolution_financial_review_required && <p role="alert">{t.financialHold}</p>}
    <p>{t.current}: {Number(work.state.receipt.is_canceled ? 0 : work.state.receipt.final_amount).toLocaleString()} ₫</p><p>{t.warning}</p>
    {work.state.payments.filter(p => !p.admin_resolution_retired).map(p => <p key={p.id}>{p.payment_name}: {Number(p.amount).toLocaleString()} ₫</p>)}
    <p>{t.actor}: {work.actorUsername}</p>
    {work.policy.lastObservation?.reconciliation === "conflict" && <p role="alert">{t.conflict}</p>}
    {(work.policy.monthClosed || work.policy.closure) && <p role="alert">{t.closed}</p>}
    {work.policy.closure && work.policy.canReclose && <label><input type="checkbox" checked={reclose} onChange={e => setReclose(e.target.checked)} />{t.reclose}</label>}
    <fieldset disabled={busy || locked || work.state.receipt.is_canceled} style={{ minWidth: 0, margin: 0, border: 0, padding: 0, display: "grid", gap: 12 }}>
      {lines.map((line, index) => <div key={line.id} style={{ border: "1px solid #bbb", padding: 10, minWidth: 0, display: "grid", gap: 8 }}>
        <label><input type="checkbox" checked={!line.is_excluded} onChange={e => updateLine(index, { is_excluded: !e.target.checked })} />{t.include}: {line.item_code} {line.item_name}</label>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(110px,1fr))", gap: 8 }}>
          {(["quantity", "unit_price", "discount_amount", "tax_rate"] as const).map((key, i) => <label key={key}>{[t.qty, t.price, t.discount, t.tax][i]}
            <input aria-label={`${line.id} ${[t.qty, t.price, t.discount, t.tax][i]}`} type="number" min="0" step={key === "quantity" ? "any" : "1"} value={line[key] ?? 0} onChange={e => updateLine(index, { [key]: Number(e.target.value) })} style={inputStyle} /></label>)}
        </div>
      </div>)}
      <label>{t.search}<input aria-label={t.search} value={query} maxLength={80} onChange={e => setQuery(e.target.value)} style={inputStyle} /></label>
      <button type="button" onClick={searchProducts} disabled={!query.trim()}>{t.search}</button>
      {products.map(p => <button key={p.id} type="button" onClick={() => {
        const id = nextLineId.current--; setLines(current => [...current, { id, productId: p.id, item_name: p.item_name, item_code: p.item_code,
          quantity: 1, unit_price: Number(p.unit_price || 0), discount_amount: 0, tax_rate: Number(p.tax_rate || 0) }]); setProducts([]); setStock(null);
      }}>{t.add}: {p.item_code} {p.item_name}</button>)}
      <label><input type="checkbox" checked={noTax} onChange={e => { setNoTax(e.target.checked); setStock(null); }} />{t.noTax}</label>
      <p>{t.financial}: {total.toLocaleString()} ₫</p><p>{t.empty}</p>
      <label>{t.amount}<input aria-label={t.amount} inputMode="numeric" value={amount} onChange={e => setAmount(e.target.value.replace(/[^0-9]/g, ""))} style={inputStyle} /></label>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(110px,1fr))", gap: 8 }}>{methods.map(m => <label key={m}>{t[m]}<input aria-label={t[m]} inputMode="numeric" value={parts[m] || ""} onChange={e => setParts({ ...parts, [m]: e.target.value.replace(/[^0-9]/g, "") })} style={inputStyle} /></label>)}</div>
      <button type="button" disabled={!canSave} onClick={() => submit("correct")}>{t.save}</button>
      <label>{t.refund}<input aria-label={t.refund} value={refund} onChange={e => setRefund(e.target.value)} maxLength={2000} style={inputStyle} /></label>
      <label><input type="checkbox" checked={refundChecked} onChange={e => setRefundChecked(e.target.checked)} />{t.refundCheck}</label>
      <button type="button" disabled={locked || busy || !refundChecked || !refund.trim() || !reason.trim()} onClick={() => submit("correct", true)}>{t.cancel}</button>
    </fieldset>
    <label>{t.reason}<textarea aria-label={t.reason} value={reason} onChange={e => setReason(e.target.value)} maxLength={2000} disabled={busy} style={inputStyle} /></label>
    {dirty && <p role="status">{t.dirty}</p>}
    <button type="button" disabled={busy || locked || dirty} onClick={() => submit("preview")}>{t.preview}</button>
    {stock && <div style={{ minWidth: 0, overflowWrap: "anywhere" }}>
      <p>{stockCopy[lang][stock.plan.workflow as keyof typeof stockCopy.ko] || stockCopy[lang].fallback} · {t.before}: {stock.plan.activeCount}</p>
      <p>v{stock.plan.resolutionVersion} · r{stock.plan.expectedRevision} · {t.current}: {Number(stock.plan.amount).toLocaleString()} ₫</p>
      {stock.plan.payments.map((p, i) => <p key={i}>{p.paymentName}: {Number(p.amount).toLocaleString()} ₫</p>)}
      <details><summary>Fingerprint</summary><p style={{ wordBreak: "break-all" }}>{stock.plan.sourceFingerprint}</p></details>
      {stock.plan.previousDeductions?.map(d => <p key={d.id}>{t.before}: #{d.inventoryItemId} × {d.quantity}</p>)}
      {stock.plan.lines?.map((l, index) => <p key={`${l.receiptLineId}-${index}`}>{l.itemName} × {l.quantitySold}: {t.after} {l.deductions.map(d => `#${d.inventoryItemId} × ${d.deductQuantity}`).join(", ")}</p>)}
      {stock.blockers.length ? <p role="alert">{t.blocked}: {stock.blockers.map(b => stockCopy[lang][b as keyof typeof stockCopy.ko] || stockCopy[lang].fallback).join(", ")}</p> : <p>{t.ready}</p>}
      <button type="button" disabled={!work.canExecuteInventory || busy || locked || dirty || Boolean(stock.blockers.length) || !reason.trim()} onClick={() => submit("confirm")}>{t.confirm}</button>
    </div>}
    <details><summary>{t.history}</summary>{work.history.map(h => <p key={h.id}>{h.event} · #{h.actor_user_id} · {new Date(h.created_at).toLocaleString(lang === "ko" ? "ko-KR" : "vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })} · {h.snapshot?.reason} · {h.snapshot?.result?.status} {h.snapshot?.result?.workflow}</p>)}</details>
    {busy && <p role="status">{t.busy}</p>}{error && <p role="alert">{error} <button onClick={() => window.location.reload()}>{t.refresh}</button></p>}
  </section>;
}
