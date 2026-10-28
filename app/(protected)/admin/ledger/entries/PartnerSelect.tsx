"use client";

import { renderPartnerOptionGroups } from "@/components/partners/PartnerOptionGroups";
import { keepingInputStyle } from "@/components/bar/keeping/KeepingUi";

type Partner = { id: number; name: string; partnerType: string | null; isActive: boolean; emoji: string };

export default function PartnerSelect({ id, partners, lang, value, onChange, required = false, disabled = false, manual = false }: {
  id: string; partners: readonly Partner[]; lang: "ko" | "vi"; value: string; onChange: (value: string) => void;
  required?: boolean; disabled?: boolean; manual?: boolean;
}) {
  const activePartners = partners.filter(partner => partner.isActive);
  return <select id={id} data-manual-field={manual ? "partner" : undefined} value={value} required={required} disabled={disabled} onChange={event => onChange(event.target.value)} style={keepingInputStyle}>
    <option value="">{required ? (lang === "vi" ? "Chọn đối tác" : "거래처 선택") : (lang === "vi" ? "Không có" : "없음")}</option>
    {renderPartnerOptionGroups(activePartners, lang, partner => String(partner.id))}
  </select>;
}
