"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { BarSheet, primaryButtonStyle, secondaryButtonStyle } from "@/components/bar/keeping/KeepingUi";
import { purchaseRepairError, type PurchaseRepairPreview } from "@/lib/inventory/purchase-repair-contract";

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
  const candidate = preview?.candidates.find(row => row.inventoryLogId === selected);
  const itemName = vi ? issue.itemNameVi || issue.itemName : issue.itemName;
  const money = (amount: number | null) => amount == null ? "—" : `${Number(amount).toLocaleString("en-US")}₫`;
  const supplier = candidate?.supplier?.trim() || issue.supplier || (vi ? "Chưa xác định" : "거래처 미확정");
  const quantity = (value: number | null | undefined) => value == null ? "—" : Number(value).toLocaleString("en-US", { maximumFractionDigits: 6 }) + (candidate?.unit ?? "");
  const result = !busy && candidate && [candidate.effectiveQuantity, candidate.oldAmount, candidate.newAmount, candidate.delta, issue.quantityDelta]
    .every(value => typeof value === "number" && Number.isFinite(value)) ? candidate : null;
  const beforeQuantity = result?.effectiveQuantity;
  const afterQuantity = beforeQuantity == null ? null : Number((Number(beforeQuantity) + Number(issue.quantityDelta)).toFixed(6));
  const history = <Link href="/inventory/logs">{vi ? "Xem lịch sử kho" : "재고 이력 보기"}</Link>;
  async function show() {
    setOpen(true); setBusy(true); setError(""); setSelected(null); setPreview(undefined);
    try {
      const response = await fetch(`/api/admin/ledger/inventory-projection/${issue.inventoryLogId}/resolve`, { cache: "no-store" });
      const body = await response.json();
      if (!response.ok || !body.ok) throw Error(body.code);
      setPreview(body);
      if (body.recommended) setSelected(body.candidates[0].inventoryLogId);
    } catch { setPreview(undefined); setError(vi ? "Không thể tải thông tin liên kết. Hãy thử lại." : "연결 정보를 불러오지 못했습니다. 다시 시도해 주세요."); }
    finally { setBusy(false); }
  }
  async function resolve() {
    if (!candidate?.safe || busy) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/admin/ledger/inventory-projection/${issue.inventoryLogId}/resolve`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ purchaseLogId: selected }),
      });
      const body = await response.json();
      if (!response.ok || !body.ok) { setError(purchaseRepairError(body.code, vi)); return; }
      await onResolved(); setOpen(false);
    } catch { setError(vi ? "Không thể xác nhận kết quả. Hãy tải lại sổ trước khi thử lại." : "처리 결과를 확인하지 못했습니다. 장부를 새로고침한 뒤 다시 확인해 주세요."); }
    finally { setBusy(false); }
  }
  return <>
    {issue.code === "PURCHASE_CORRECTION_REFERENCE_REQUIRED"
      ? <button ref={triggerRef} type="button" className={styles.action} style={secondaryButtonStyle} onClick={show}>{vi ? "Giải quyết" : "해결하기"}</button> : <span className={styles.action}>{history}</span>}
    {open ? <BarSheet kind="bottom" mobileCentered returnFocusRef={triggerRef} title={vi ? "Liên kết lô nhập gốc" : "원입고 연결 및 장부 수정"}
      closeLabel={vi ? "Đóng" : "닫기"} saving={busy} onClose={() => setOpen(false)}
      footer={<button type="button" className={styles.submit} style={primaryButtonStyle} disabled={busy || !candidate?.safe} onClick={resolve}>
        {busy ? vi ? "Đang kiểm tra…" : "확인 중…" : vi ? "Liên kết lô nhập gốc và sửa sổ" : "원입고에 연결하고 장부 수정"}
      </button>}>
      <dl className={styles.basics}>
        <div><dt>{vi ? "Ngày sửa" : "수정일"}</dt><dd><time dateTime={issue.businessDate}>{issue.businessDate ? issue.businessDate.slice(5).replace("-", "/") : "—"}</time></dd></div>
        <div><dt>{vi ? "Nhà cung cấp" : "거래처명"}</dt><dd title={supplier}>{supplier}</dd></div>
        <div><dt>{vi ? "Mặt hàng" : "품목명"}</dt><dd title={itemName}>{itemName}</dd></div>
      </dl>
      <label className={styles.selection}>{preview?.recommended ? vi ? "Lô nhập đề xuất" : "추천 원입고" : vi ? "Chọn lô nhập gốc" : "원입고 선택"}
        <select aria-label={vi ? "Chọn lô nhập gốc" : "원입고 선택"} value={selected ?? ""} disabled={busy || !preview?.candidates.length} onChange={event => setSelected(Number(event.target.value) || null)}>
          <option value="">{vi ? "Chọn lô nhập" : "원입고를 선택해 주세요"}</option>
          {preview?.candidates.map(row => <option key={row.inventoryLogId} value={row.inventoryLogId}>
            {row.businessDate.slice(5).replace("-", "/")} · +{row.quantity}{row.unit ?? ""} · {row.supplier} · {money(row.price)}
          </option>)}
        </select>
      </label>
      {!preview?.candidates.length && !busy && !error ? <p>{vi ? "Không tìm thấy lô nhập gốc có thể liên kết. Vui lòng kiểm tra lịch sử kho." : "연결 가능한 원입고를 찾지 못했습니다. 재고 이력을 확인해주세요."}</p> : null}
      {result ? <section className={styles.result} aria-label={vi ? "Kết quả điều chỉnh" : "수정 결과"} aria-live="polite">
        <h3>{vi ? "Kết quả điều chỉnh" : "수정 결과"}</h3>
        <dl className={styles.resultGrid}>
          <div><dt>{vi ? "Số lượng điều chỉnh" : "수정 수량"}</dt><dd>{quantity(issue.quantityDelta)}</dd></div>
          <div><dt>{vi ? "Số lượng trước → sau" : "기존 수량 → 수정 후"}</dt><dd>{quantity(beforeQuantity)} → <span className={styles.decrease}>{quantity(afterQuantity)}</span></dd></div>
          <div><dt>{vi ? "Số tiền sổ trước" : "기존 장부금액"}</dt><dd>{money(result.oldAmount)}</dd></div>
          <div><dt>{vi ? "Số tiền sổ sau" : "수정 후 장부금액"}</dt><dd className={styles.decrease}>{money(result.newAmount)}</dd></div>
          <div className={styles.difference}><dt>{vi ? "Chênh lệch tiền" : "차액"}</dt><dd className={styles.decrease}>{money(result.delta)}</dd></div>
        </dl>
      </section> : null}
      {candidate ? <>
        {!candidate.safe ? <p role="alert">{purchaseRepairError(candidate.code, vi)}</p> : null}
      </> : null}
      {error ? <p role="alert">{error}</p> : null}
    </BarSheet> : null}
  </>;
}
