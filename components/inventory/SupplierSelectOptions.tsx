import { renderPartnerOptionGroups } from "@/components/partners/PartnerOptionGroups";
import type { PartnerSelectOption } from "@/lib/partners/select-options";

type SupplierAlias = { id: number; supplierName: string; status: "pending" | "linked" | "ignored" };

// Inventory supplier <select> options: none, the shared 거래처 groups (`partner:{id}`),
// 확인 필요 unlinked aliases kept in their own group (`alias:{id}`), and 직접 입력 (`__custom__`).
export default function SupplierSelectOptions({ partners, aliases, lang, placeholder, directInput }: {
  partners: readonly PartnerSelectOption[]; aliases: readonly SupplierAlias[]; lang: "ko" | "vi"; placeholder: string; directInput: string;
}) {
  return <>
    <option value="">{placeholder}</option>
    {renderPartnerOptionGroups(partners, lang, partner => `partner:${partner.id}`)}
    <optgroup label={lang === "vi" ? "Cần xác nhận" : "확인 필요"}>
      {aliases.filter(alias => alias.status === "pending").map(alias => <option key={alias.id} value={`alias:${alias.id}`}>{alias.supplierName}</option>)}
    </optgroup>
    <option value="__custom__">{directInput}</option>
  </>;
}
