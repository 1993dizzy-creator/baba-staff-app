import { partnerOptionLabel, partnerSelectGroups } from "@/lib/partners/select-options";

type Partner = { id: number; name: string; partnerType: string | null; isActive?: boolean; emoji?: string | null };

// The 거래처 <optgroup>s every select shares; optionValue is the screen's own value format.
export function renderPartnerOptionGroups<T extends Partner>(partners: readonly T[], lang: "ko" | "vi", optionValue: (partner: T) => string) {
  return partnerSelectGroups(partners, lang).map(group => <optgroup key={group.group} label={group.label}>
    {group.partners.map(partner => <option key={partner.id} value={optionValue(partner)}>{partnerOptionLabel(partner)}</option>)}
  </optgroup>);
}
