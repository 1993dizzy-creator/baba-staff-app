"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { BarSheet, primaryButtonStyle, secondaryButtonStyle } from "@/components/bar/keeping/KeepingUi";
import { canReviewPurchaseCorrection, canConfirmPurchaseSupplierChange, canSubmitPurchaseRepair, purchaseRepairState, purchaseRepairError, type PurchaseRepairPreview } from "@/lib/inventory/purchase-repair-contract";

import styles from "./InventoryProjectionResolution.module.css";

export type InventoryProjectionIssue = {
  inventoryLogId: number; code: string; itemName: string; itemNameVi?: string | null; supplier?: string | null; businessDate: string;
  quantityDelta: number; amountDelta: number; originalQuantity: number | null;
  resolution?: PurchaseRepairPreview;
};

export default function InventoryProjectionResolution({ issue, vi, onResolved }: {
  issue: InventoryProjectionIssue; vi: boolean; onResolved: () => Promise<void>;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState(issue.resolution);
  const [selected, setSelected] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [supplierConfirmed, setSupplierConfirmed] = useState(false);
  const requestLockRef = useRef(false);
  useEffect(() => {
    if (window.location.hash !== `#inventory-projection-${issue.inventoryLogId}`) return;
    triggerRef.current?.closest("details")?.setAttribute("open", "");
    triggerRef.current?.scrollIntoView({ block: "center" });
    triggerRef.current?.focus({ preventScroll: true });
  }, [issue.inventoryLogId]);
  const candidate = preview?.candidates.find(row => row.inventoryLogId === selected);
  const supplierConfirmationRequired = candidate?.code === "SUPPLIER_CHANGE_CONFIRMATION_REQUIRED";
  const itemName = vi ? issue.itemNameVi || issue.itemName : issue.itemName;
  const money = (amount: number | null) => amount == null ? "—" : `${Number(amount).toLocaleString("en-US")}₫`;
  const originalSupplier = candidate?.supplier?.trim();
  const newSupplier = candidate?.newSupplier?.trim();
  const supplier = originalSupplier && newSupplier && originalSupplier !== newSupplier
    ? `${originalSupplier} → ${newSupplier}`
    : newSupplier || originalSupplier || issue.supplier || (vi ? "Chưa xác định" : "거래처 미확정");
  const quantity = (value: number | null | undefined) => value == null ? "—" : Number(value).toLocaleString("en-US", { maximumFractionDigits: 6 }) + (candidate?.unit ?? "");
  const correctionDelta = candidate?.quantityDelta ?? issue.quantityDelta;
  const result = !busy && candidate && [candidate.effectiveQuantity, candidate.oldAmount, candidate.newAmount, candidate.delta, correctionDelta]
    .every(value => typeof value === "number" && Number.isFinite(value)) ? candidate : null;
  const canSubmit = !!result && canSubmitPurchaseRepair(candidate, supplierConfirmed);
  const beforeQuantity = result?.effectiveQuantity;
  const afterQuantity = beforeQuantity == null ? null : Number((Number(beforeQuantity) + Number(correctionDelta)).toFixed(6));
  const history = <Link href="/inventory/logs">{vi ? "Xem lịch sử kho" : "재고 이력 보기"}</Link>;
  async function show() {
    if (requestLockRef.current) return;
    requestLockRef.current = true;
    setSupplierConfirmed(false);
    setOpen(true); setBusy(true); setError(""); setSelected(null); setPreview(undefined);
    try {
      const response = await fetch(`/api/admin/ledger/inventory-projection/${issue.inventoryLogId}/resolve`, { cache: "no-store" });
      const body = await response.json();
      if (!response.ok || !body.ok) { setPreview(undefined); setError(purchaseRepairError(body.code, vi)); return; }
      setPreview(body);
      if (body.recommended) setSelected(body.candidates[0].inventoryLogId);
    } catch { setPreview(undefined); setError(vi ? "Không thể tải thông tin liên kết. Hãy thử lại." : "연결 정보를 불러오지 못했습니다. 다시 시도해 주세요."); }
    finally { requestLockRef.current = false; setBusy(false); }
  }
  async function resolve() {
    if (!canSubmit || busy || requestLockRef.current) return;
    requestLockRef.current = true;
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/admin/ledger/inventory-projection/${issue.inventoryLogId}/resolve`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ purchaseLogId: selected, ...(supplierConfirmationRequired ? {
          supplierConfirmation: { confirmed: true, fingerprint: candidate!.supplierChange!.confirmationFingerprint },
        } : {}) }),
      });
      const body = await response.json();
      if (!response.ok || !body.ok) {
        setError(purchaseRepairError(body.code, vi)); setSupplierConfirmed(false);
        if (preview && candidate) setPreview({ ...preview, candidates: preview.candidates.map(row =>
          row.inventoryLogId === selected ? { ...row, safe: false, code: body.code || "REPAIR_FAILED" } : row) });
        return;
      }
      await onResolved(); setOpen(false);
    } catch { setError(vi ? "Không thể xác nhận kết quả. Hãy tải lại sổ trước khi thử lại." : "처리 결과를 확인하지 못했습니다. 장부를 새로고침한 뒤 다시 확인해 주세요."); }
    finally { requestLockRef.current = false; setBusy(false); }
  }
  return <>
    <span className={styles.state}>{purchaseRepairState(issue.code, vi, issue.resolution?.candidates.length === 1 && issue.resolution.candidates[0].newAmount === 0)}</span>
    {canReviewPurchaseCorrection(issue.code)
      ? <button id={`inventory-projection-${issue.inventoryLogId}`} ref={triggerRef} type="button" className={styles.action} style={secondaryButtonStyle} onClick={show}>{vi ? "Giải quyết" : "해결하기"}</button> : <span className={styles.action}>{history}</span>}
    {open ? <BarSheet kind="full" compact mobileCentered returnFocusRef={triggerRef} title={vi ? "Liên kết lô nhập gốc" : "원입고 연결 및 장부 수정"}
      closeLabel={vi ? "Đóng" : "닫기"} saving={busy} onClose={() => setOpen(false)}
      footer={<button type="button" className={styles.submit} style={primaryButtonStyle} disabled={busy || !canSubmit} onClick={resolve}>
        {busy ? vi ? "Đang kiểm tra…" : "확인 중…" : vi ? "Liên kết lô nhập gốc và sửa sổ" : "원입고에 연결하고 장부 수정"}
      </button>}>
      <dl className={styles.basics}>
        <div><dt>{vi ? "Ngày sửa" : "수정일"}</dt><dd><time dateTime={issue.businessDate}>{issue.businessDate ? issue.businessDate.slice(5).replace("-", "/") : "—"}</time></dd></div>
        <div><dt>{vi ? "Nhà cung cấp" : "거래처명"}</dt><dd title={supplier}>{supplier}</dd></div>
        <div><dt>{vi ? "Mặt hàng" : "품목명"}</dt><dd title={itemName}>{itemName}</dd></div>
      </dl>
      <label className={styles.selection}>{preview?.recommended ? vi ? "Lô nhập đề xuất" : "추천 원입고" : vi ? "Chọn lô nhập gốc" : "원입고 선택"}
        <select aria-label={vi ? "Chọn lô nhập gốc" : "원입고 선택"} value={selected ?? ""} disabled={busy || !preview?.candidates.length} onChange={event => { setSelected(Number(event.target.value) || null); setSupplierConfirmed(false); setError(""); }}>
          <option value="">{vi ? "Chọn lô nhập" : "원입고를 선택해 주세요"}</option>
          {preview?.candidates.map(row => <option key={row.inventoryLogId} value={row.inventoryLogId}>
            {row.businessDate.slice(5).replace("-", "/")} · +{row.quantity}{row.unit ?? ""} · {row.supplier} · {money(row.price)}
          </option>)}
        </select>
      </label>
      {!preview?.candidates.length && !busy && !error ? <p>{vi ? "Không tìm thấy lô nhập gốc có thể liên kết. Vui lòng kiểm tra lịch sử kho." : "연결 가능한 원입고를 찾지 못했습니다. 재고 이력을 확인해주세요."}</p> : null}
      {result ? <section className={styles.result} aria-label={vi ? "Kết quả điều chỉnh" : "수정 결과"} aria-live="polite">
        <h3>{vi ? "Kết quả điều chỉnh" : "수정 결과"}</h3>
        <p>{supplierConfirmationRequired
          ? purchaseRepairState("SUPPLIER_CHANGE_CONFIRMATION_REQUIRED", vi)
          : result.delta !== 0 ? purchaseRepairState("PURCHASE_AMOUNT_CONFIRMATION_REQUIRED", vi, result.newAmount === 0)
          : vi ? "Xác nhận thông tin phiếu nhập" : "입고정보 확인"}</p>
        <dl className={styles.resultGrid}>
          {correctionDelta !== 0 && <div><dt>{vi ? "Số lượng điều chỉnh" : "수정 수량"}</dt><dd>{quantity(correctionDelta)}</dd></div>}
          {(!supplierConfirmationRequired || correctionDelta !== 0) && <div><dt>{vi ? "Số lượng trước → sau" : "기존 수량 → 수정 후"}</dt><dd>{quantity(beforeQuantity)} → <span className={styles.decrease}>{quantity(afterQuantity)}</span></dd></div>}
          {supplierConfirmationRequired && <>
            <div><dt>{vi ? "Nhà cung cấp trước" : "변경 전 거래처"}</dt><dd>{result.supplierChange?.beforeSupplier || result.supplier || "—"}</dd></div>
            <div><dt>{vi ? "Nhà cung cấp sau" : "변경 후 실제 지급 거래처"}</dt><dd>{result.supplierChange?.afterSupplier || result.newSupplier || "—"}</dd></div>
          </>}
          <div><dt>{vi ? "Số tiền sổ trước" : "기존 장부금액"}</dt><dd>{money(result.oldAmount)}</dd></div>
          <div><dt>{vi ? "Số tiền sổ sau" : "수정 후 장부금액"}</dt><dd className={result.delta !== 0 ? styles.decrease : undefined}>{money(result.newAmount)}</dd></div>
          <div className={styles.difference}><dt>{vi ? "Chênh lệch tiền" : "차액"}</dt><dd className={result.delta !== 0 ? styles.decrease : undefined}>{money(result.delta)}</dd></div>
        </dl>
      </section> : null}
      {candidate ? <>
        {canConfirmPurchaseSupplierChange(candidate) ? <label className={styles.confirmation}>
          <input type="checkbox" checked={supplierConfirmed} disabled={busy} onChange={event => setSupplierConfirmed(event.target.checked)} />
          <span>{vi ? "Tôi xác nhận nhà cung cấp thực tế sau thay đổi:" : "변경 후 실제 지급 거래처를 확인했습니다:"} <strong>{candidate.supplierChange?.afterSupplier || candidate.newSupplier}</strong></span>
        </label> : !candidate.safe ? <p role="alert">{purchaseRepairError(candidate.code, vi)}</p> : null}
      </> : null}
      {error ? <><p role="alert">{error}</p><button type="button" style={secondaryButtonStyle} disabled={busy} onClick={show}>{vi ? "Tải lại thông tin" : "최신 정보 다시 조회"}</button></> : null}
    </BarSheet> : null}
  </>;
}
