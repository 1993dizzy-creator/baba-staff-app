import type { PurchaseCase } from "./purchase-cases";
import { purchaseRepairError, type PurchaseRepairPreview } from "./purchase-repair-contract";

type DisplayIssue = Partial<PurchaseCase> & { code: string; resolution?: PurchaseRepairPreview };
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const number = (value: number) => value.toLocaleString("en-US", { maximumFractionDigits: 6 });
const signed = (value: number) => `${value > 0 ? "+" : ""}${number(value)}`;

// Display only the same unambiguous server preview used by the resolve modal.
// Missing or ambiguous evidence must never become an estimated money change.
export function purchaseCaseDisplay(issue: DisplayIssue, vi: boolean) {
  const candidates = issue.resolution?.candidates;
  const candidate = candidates?.length === 1 ? candidates[0] : undefined;
  const changes: { kind: "amount" | "quantity" | "supplier"; text: string }[] = [];
  if (candidate) {
    const { oldAmount, newAmount, delta, effectiveQuantity, quantityDelta } = candidate;
    if ([oldAmount, newAmount, delta].every(finite) && oldAmount !== newAmount) {
      changes.push({ kind: "amount", text: `${vi ? "Số tiền" : "금액"}: ${number(oldAmount!)}₫ → ${number(newAmount!)}₫ (${signed(delta!)}₫)` });
    }
    if (finite(effectiveQuantity) && finite(quantityDelta) && quantityDelta !== 0) {
      const after = Number((effectiveQuantity + quantityDelta).toFixed(6));
      changes.push({ kind: "quantity", text: `${vi ? "Số lượng" : "수량"}: ${number(effectiveQuantity)} → ${number(after)}${candidate.unit || ""} (${signed(quantityDelta)})` });
    }
    const supplier = candidate.supplierChange;
    const before = (supplier?.beforeSupplier || candidate.supplier)?.trim();
    const after = (supplier?.afterSupplier || candidate.newSupplier)?.trim();
    const identityChanged = supplier?.beforePartnerId != null && supplier.afterPartnerId != null && supplier.beforePartnerId !== supplier.afterPartnerId;
    if (before && after && (before !== after || identityChanged)) {
      const identity = identityChanged && before === after;
      changes.push({ kind: "supplier", text: `${vi ? "Nhà cung cấp" : "거래처"}: ${before}${identity ? ` (#${supplier!.beforePartnerId})` : ""} → ${after}${identity ? ` (#${supplier!.afterPartnerId})` : ""}` });
    }
  }
  const reason = changes.length > 1 ? vi ? "Cần xác nhận các thay đổi" : "복합 변경 확인 필요"
    : changes[0]?.kind === "amount" ? vi ? "Cần xác nhận thay đổi số tiền" : "금액 변경 확인 필요"
    : changes[0]?.kind === "quantity" ? vi ? "Cần xác nhận thay đổi số lượng" : "수량 변경 확인 필요"
    : changes[0]?.kind === "supplier" ? vi ? "Cần xác nhận nhà cung cấp" : "거래처 변경 확인 필요"
    : vi ? "Cần kiểm tra lịch sử và trạng thái sổ" : "변경 이력·장부 상태 확인 필요";
  const code = candidate && candidate.code !== "READY" ? candidate.code : issue.code;
  const explanation = !candidate
    ? vi ? "Chưa đủ dữ liệu xác định chênh lệch. Hãy kiểm tra chi tiết." : "차액을 확정할 근거가 부족합니다. 상세정보를 확인해 주세요."
    : changes.length === 0
      ? vi ? "Không có thay đổi giá trị được xác nhận; vẫn cần kiểm tra trạng thái sổ." : "확인된 값의 변경은 없지만 장부 상태 확인이 필요합니다."
      : null;
  // At most two logical rows, preserving all three fields for compound changes.
  const lines = changes.length > 2 ? [changes.slice(0, 2).map(change => change.text).join(" · "), changes[2].text] : changes.map(change => change.text);
  return { changes, lines, reason, explanation, technicalReason: purchaseRepairError(code, vi), code, candidate };
}

export function purchaseCaseReasonCounts(issues: DisplayIssue[], vi: boolean) {
  const counts = { amount: 0, quantity: 0, supplier: 0 };
  for (const issue of issues) for (const change of purchaseCaseDisplay(issue, vi).changes) counts[change.kind]++;
  return (Object.keys(counts) as (keyof typeof counts)[]).filter(kind => counts[kind]).map(kind => {
    const label = vi ? { amount: "Đổi số tiền", quantity: "Đổi số lượng", supplier: "Đổi nhà cung cấp" }[kind]
      : { amount: "금액 변경", quantity: "수량 변경", supplier: "거래처 변경" }[kind];
    return `${label} ${counts[kind]}${vi ? " mục" : "건"}`;
  }).join(" · ");
}
