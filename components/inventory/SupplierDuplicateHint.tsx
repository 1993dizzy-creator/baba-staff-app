import { matchExistingSupplier } from "@/lib/partners/duplicate-partner";
import type { PartnerSelectOption } from "@/lib/partners/select-options";

type SupplierAlias = { id: number; supplierName: string; status: string; businessPartnerId?: number | null };
export type ExistingSupplierMatch = NonNullable<ReturnType<typeof matchExistingSupplier>>;

// 직접 입력 under a name similar to a registered one (accent/tone/case/space-insensitive):
// suggest the existing partner/등록대기. Only the staff's choice links it (supplierPartnerId);
// the server never links an accent-only match on its own (Cho ≠ Chợ until someone decides),
// so saving the typed text keeps it as a 등록대기 candidate instead.
export default function SupplierDuplicateHint({ partners, aliases, value, lang, onUse }: {
  partners: readonly PartnerSelectOption[]; aliases: readonly SupplierAlias[]; value: string; lang: "ko" | "vi";
  onUse: (match: ExistingSupplierMatch) => void;
}) {
  const match = matchExistingSupplier(partners, aliases, value);
  if (!match) return null;
  const vi = lang === "vi";
  return <div role="status" data-testid="supplier-duplicate-hint" style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6, padding: "7px 9px", border: "1px solid #f5d9a8", borderRadius: 9, background: "#fffaf0", color: "#9a5b10", fontSize: 12, lineHeight: 1.4 }}>
    <span style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>
      {match.kind === "partner"
        ? (vi ? `Đã có đối tác với tên tương tự: ${match.name}` : `유사한 이름의 거래처가 이미 등록되어 있습니다: ${match.name}`)
        : (vi ? `Đang chờ duyệt: "${match.name}"` : `등록대기 중인 거래처: "${match.name}"`)}
    </span>
    <button type="button" onClick={() => onUse(match)} style={{ flex: "0 0 auto", minHeight: 32, padding: "4px 10px", border: "1px solid #9a5b10", borderRadius: 8, background: "#fff", color: "#9a5b10", fontSize: 12, fontWeight: 800, cursor: "pointer" }}>
      {vi ? "Dùng đối tác này" : "기존 거래처 사용"}
    </button>
  </div>;
}
