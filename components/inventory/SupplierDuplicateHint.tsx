import { matchExistingSupplier } from "@/lib/partners/duplicate-partner";
import type { PartnerSelectOption } from "@/lib/partners/select-options";

type SupplierAlias = { id: number; supplierName: string; status: string; businessPartnerId?: number | null };
export type ExistingSupplierMatch = NonNullable<ReturnType<typeof matchExistingSupplier>>;

// 직접 입력 under a name that is already registered (accent/tone/case/space-insensitive):
// name it and offer the existing partner/등록대기 instead of a new candidate. The server
// resolves the same way, so saving the typed text never opens a second candidate either.
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
        ? (vi ? `Đã đăng ký: "${match.name}"` : `이미 등록된 거래처: "${match.name}"`)
        : (vi ? `Đang chờ duyệt: "${match.name}"` : `등록대기 중인 거래처: "${match.name}"`)}
    </span>
    <button type="button" onClick={() => onUse(match)} style={{ flex: "0 0 auto", minHeight: 32, padding: "4px 10px", border: "1px solid #9a5b10", borderRadius: 8, background: "#fff", color: "#9a5b10", fontSize: 12, fontWeight: 800, cursor: "pointer" }}>
      {vi ? "Dùng đối tác này" : "기존 거래처 사용"}
    </button>
  </div>;
}
