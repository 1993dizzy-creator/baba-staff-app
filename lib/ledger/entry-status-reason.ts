import type { LedgerEntry } from "./entries";

// Display explanations only; this does not change accounting or status decisions.
export function entryStatusReason(entry: Pick<LedgerEntry, "status" | "systemDisplay" | "accountName" | "requiresCorrection" | "sourceAmount" | "effectiveAmount"> & Partial<Pick<LedgerEntry, "title">>, lang: "ko" | "vi"): string | null {
  const vi = lang === "vi";
  const reasons: string[] = [];
  if (entry.status === "pending") {
    if (entry.systemDisplay?.kind === "inventory" && entry.systemDisplay.partyMissing) {
      const supplier = entry.title?.trim();
      reasons.push(vi
        ? `Cần xác nhận nhà cung cấp · ${supplier ? `Nhà cung cấp nhập hàng '${supplier}'` : "Nhà cung cấp nhập hàng"} chưa được liên kết với đối tác. Vui lòng xác nhận nhà cung cấp thực tế và phương thức thanh toán.`
        : `거래처 확인 필요 · ${supplier ? `입고 거래처 '${supplier}'이(가)` : "입고 거래처가"} 거래처와 연결되지 않았습니다. 실제 거래처와 결제방식을 확인해주세요.`);
    } else {
      reasons.push(vi
        ? "Cần xác nhận thanh toán · Cần xác nhận đã thực sự thanh toán hay chưa và tài khoản thanh toán."
        : "결제 확인 필요 · 실제 지급 여부와 결제계정을 확인해야 합니다.");
    }
  }
  if (entry.requiresCorrection) {
    let reason = vi
      ? "Cần điều chỉnh số tiền · Số tiền nguồn mới nhất khác với số tiền hiện ghi trong sổ."
      : "금액 정정 필요 · 최신 원천 금액과 현재 장부 반영 금액이 다릅니다.";
    if (entry.sourceAmount != null && entry.effectiveAmount != null) {
      const amount = (value: number) => `${value.toLocaleString("en-US")}₫`;
      reason += vi
        ? ` · Nguồn mới nhất ${amount(entry.sourceAmount)} · Hiện ghi ${amount(entry.effectiveAmount)}`
        : ` · 최신 원천 ${amount(entry.sourceAmount)} · 현재 반영 ${amount(entry.effectiveAmount)}`;
    }
    reasons.push(reason);
  }
  return reasons.length ? reasons.join(" · ") : null;
}
