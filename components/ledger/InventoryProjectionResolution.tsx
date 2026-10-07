"use client";

import { useState } from "react";
import Link from "next/link";
import { BarSheet, primaryButtonStyle } from "@/components/bar/keeping/KeepingUi";
import { purchaseRepairError, type PurchaseRepairPreview } from "@/lib/inventory/purchase-repair-contract";

export type InventoryProjectionIssue = {
  inventoryLogId: number; code: string; itemName: string; itemNameVi?: string | null; businessDate: string;
  quantityDelta: number; amountDelta: number; originalQuantity: number | null;
  resolution?: PurchaseRepairPreview;
};

export default function InventoryProjectionResolution({ issue, vi, onResolved }: {
  issue: InventoryProjectionIssue; vi: boolean; onResolved: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState(issue.resolution);
  const [selected, setSelected] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const candidate = preview?.candidates.find(row => row.inventoryLogId === selected);
  const itemName = vi ? issue.itemNameVi || issue.itemName : issue.itemName;
  const money = (amount: number | null) => amount == null ? "—" : `${Number(amount).toLocaleString("en-US")}₫`;
  const recommendation = issue.resolution?.recommended ? issue.resolution.candidates[0] : null;
  const history = <Link href="/inventory/logs">{vi ? "Xem lịch sử kho" : "재고 이력 보기"}</Link>;
  async function show() {
    setOpen(true); setBusy(true); setError(""); setSelected(null);
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
    {recommendation ? <small>{vi
      ? `Lô nhập ${recommendation.businessDate}: ${recommendation.quantity}${recommendation.unit ?? ""} được đề xuất. Liên kết sẽ sửa sổ ${money(recommendation.oldAmount)} → ${money(recommendation.newAmount)}.`
      : `${recommendation.businessDate} ${itemName} 입고 ${recommendation.quantity}${recommendation.unit ?? ""}이 원입고로 추정됩니다. 연결하면 장부가 ${money(recommendation.oldAmount)} → ${money(recommendation.newAmount)}으로 수정됩니다.`}</small> : null}
    {issue.code === "PURCHASE_CORRECTION_REFERENCE_REQUIRED"
      ? <button type="button" onClick={show}>{vi ? "Giải quyết" : "해결하기"}</button> : history}
    {open ? <BarSheet kind="bottom" title={vi ? "Liên kết lô nhập gốc" : "원입고 연결 및 장부 수정"}
      closeLabel={vi ? "Đóng" : "닫기"} saving={busy} onClose={() => setOpen(false)}
      footer={<button type="button" style={primaryButtonStyle} disabled={busy || !candidate?.safe} onClick={resolve}>
        {busy ? vi ? "Đang kiểm tra…" : "확인 중…" : vi ? "Liên kết lô nhập gốc và sửa sổ" : "원입고에 연결하고 장부 수정"}
      </button>}>
      <strong>{itemName}</strong>
      <p>{vi ? "Thay đổi" : "수정"}: {issue.businessDate} · {issue.quantityDelta}{candidate?.unit ?? ""} · {money(issue.amountDelta)}</p>
      {preview?.candidates.length ? <label>{preview.recommended ? vi ? "Lô nhập đề xuất" : "추천 원입고" : vi ? "Chọn lô nhập gốc" : "원입고 선택"}
        <select aria-label={vi ? "Chọn lô nhập gốc" : "원입고 선택"} value={selected ?? ""} disabled={busy} onChange={event => setSelected(Number(event.target.value) || null)}>
          <option value="">{vi ? "Chọn lô nhập" : "원입고를 선택해 주세요"}</option>
          {preview.candidates.map(row => <option key={row.inventoryLogId} value={row.inventoryLogId}>
            {row.businessDate} · +{row.quantity}{row.unit ?? ""} · {row.supplier} · {money(row.price)}
          </option>)}
        </select>
      </label> : !busy && !error ? <p>{vi ? "Không tìm thấy lô nhập gốc có thể liên kết. Vui lòng kiểm tra lịch sử kho." : "연결 가능한 원입고를 찾지 못했습니다. 재고 이력을 확인해주세요."}</p> : null}
      {candidate ? <>
        <p>{candidate.supplier} · {money(candidate.price)}/{candidate.unit ?? ""}</p>
        <p>{vi ? "Sổ kế toán" : "장부"}: {money(candidate.oldAmount)} → {money(candidate.newAmount)}</p>
        <p>{vi ? "Chênh lệch" : "차이"}: {money(candidate.delta)}</p>
        {!candidate.safe ? <p role="alert">{purchaseRepairError(candidate.code, vi)}</p> : null}
      </> : null}
      {error ? <p role="alert">{error}</p> : null}
      {history}
    </BarSheet> : null}
  </>;
}
