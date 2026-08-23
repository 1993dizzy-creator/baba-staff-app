"use client";

import { useState, type FormEvent } from "react";
import { BarField, BarSection, BarSegmentedControl, keepingInputStyle, primaryButtonStyle } from "@/components/bar/keeping/KeepingUi";
import PartnerSettlementFields from "@/components/PartnerSettlementFields";
import { PARTNER_TYPES, type PartnerType, type PaymentMode, type SettlementMode, type SettlementRule } from "@/lib/partners/policy";
import { formatPartnerSubtypeName, partnerText, partnerTypeLabels } from "@/lib/partners/text";

export type PartnerFormValue = { name: string; partnerType: PartnerType; paymentMode: PaymentMode; settlementMode: SettlementMode | null; settlementRule: SettlementRule | null; defaultPaymentTermDays: number | null; defaultFundAccountId: number | null; partnerSubtypeId: number | null; contactName: string | null; phone: string | null; memo: string | null; isActive: boolean; ledgerPartyId: number | null };
export type FundAccount = { id: number; code: string; displayName: string; type: string };
export type PartnerSubtype = { id: number; code: string; partnerType: PartnerType; nameKo: string | null; nameVi: string | null; sortOrder: number; isActive: boolean };

const basicGridStyle: React.CSSProperties = { display: "grid", gridTemplateColumns: "minmax(0, 1.65fr) minmax(110px, 1fr)", gap: 10, alignItems: "start" };
const twoColumnGridStyle: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10, alignItems: "start" };

type Props = {
  lang: "ko" | "vi";
  initial?: PartnerFormValue;
  fundAccounts: FundAccount[];
  partnerSubtypes: PartnerSubtype[];
  submitLabel?: string;
  showActive?: boolean;
  layout?: "modal" | "page";
  first?: boolean;
  formId?: string;
  onSavingChange?: (saving: boolean) => void;
  onSubmit: (value: PartnerFormValue) => Promise<boolean>;
};

// ledgerPartyId is a backend-compatibility field only (business_partner <-> ledger_party
// bridge). It is never rendered here; it is carried through unchanged from `initial` on
// edit (so an existing link is never silently dropped) and stays null on create.
export default function PartnerForm({ lang, initial, fundAccounts, partnerSubtypes, submitLabel, showActive = true, layout = "page", first = true, formId, onSavingChange, onSubmit }: Props) {
  const t = partnerText[lang];
  const sectionLabels = lang === "vi"
    ? { basic: "Thông tin cơ bản", payment: "Thông tin thanh toán", contact: "Liên hệ", memo: "Ghi chú", other: "Khác" }
    : { basic: "기본 정보", payment: "결제 정보", contact: "연락처", memo: "메모", other: "기타" };
  const emptyValue: PartnerFormValue = { name: "", partnerType: "other", paymentMode: "immediate", settlementMode: null, settlementRule: null, defaultPaymentTermDays: null, defaultFundAccountId: null, partnerSubtypeId: null, contactName: null, phone: null, memo: null, isActive: true, ledgerPartyId: null };
  const [value, setValue] = useState<PartnerFormValue>(initial ?? emptyValue);
  const [saving, setSaving] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true); onSavingChange?.(true);
    try { const ok = await onSubmit(value); if (ok && !initial) setValue(emptyValue); }
    finally { setSaving(false); onSavingChange?.(false); }
  }

  // Only the current partnerType's subtypes are offered; a subtype the Partner is already
  // assigned (value.partnerSubtypeId) stays listed even if it has since been deactivated,
  // so editing an existing Partner never silently drops or resets it.
  const subtypeOptions = partnerSubtypes
    .filter(subtype => subtype.partnerType === value.partnerType && (subtype.isActive || subtype.id === value.partnerSubtypeId))
    .sort((a, b) => a.sortOrder - b.sortOrder);

  function changePartnerType(partnerType: PartnerType) {
    // Changing 대분류 immediately clears 중분류 unless it still belongs to the new partnerType.
    const stillValid = value.partnerSubtypeId !== null && partnerSubtypes.some(subtype => subtype.id === value.partnerSubtypeId && subtype.partnerType === partnerType);
    setValue({ ...value, partnerType, partnerSubtypeId: stillValid ? value.partnerSubtypeId : null });
  }

  return <form id={formId} onSubmit={submit}>
    <BarSection title={sectionLabels.basic} icon="📌" first={first}>
      <div style={basicGridStyle}>
        <BarField label={t.name} required>{({ id }) => <input id={id} required maxLength={200} value={value.name} onChange={event => setValue({ ...value, name: event.target.value })} style={keepingInputStyle} />}</BarField>
        <BarField label={t.type}>{({ id }) => <select id={id} value={value.partnerType} onChange={event => changePartnerType(event.target.value as PartnerType)} style={keepingInputStyle}>{PARTNER_TYPES.map(type => <option key={type} value={type}>{partnerTypeLabels[type][lang]}</option>)}</select>}</BarField>
      </div>
      <BarField label={t.subtype}>{({ id }) => <select id={id} value={value.partnerSubtypeId ?? ""} onChange={event => setValue({ ...value, partnerSubtypeId: event.target.value ? Number(event.target.value) : null })} style={keepingInputStyle}>
        <option value="">{formatPartnerSubtypeName(null, lang)}</option>
        {subtypeOptions.map(subtype => <option key={subtype.id} value={subtype.id}>{formatPartnerSubtypeName(subtype, lang)}</option>)}
      </select>}</BarField>
    </BarSection>
    <BarSection title={sectionLabels.payment} icon="💳">
      <PartnerSettlementFields lang={lang} value={value} fundAccounts={fundAccounts} disabled={saving} onChange={setValue} />
    </BarSection>
    <BarSection title={sectionLabels.contact} icon="☎️">
      <div style={twoColumnGridStyle}>
        <BarField label={t.contact}>{({ id }) => <input id={id} maxLength={120} value={value.contactName ?? ""} onChange={event => setValue({ ...value, contactName: event.target.value || null })} style={keepingInputStyle} />}</BarField>
        <BarField label={t.phone}>{({ id }) => <input id={id} type="tel" maxLength={80} value={value.phone ?? ""} onChange={event => setValue({ ...value, phone: event.target.value || null })} style={keepingInputStyle} />}</BarField>
      </div>
    </BarSection>
    <BarSection title={showActive ? sectionLabels.other : sectionLabels.memo} icon="📝">
      {showActive
        ? <BarField label={t.memo}>{({ id }) => <textarea id={id} rows={2} value={value.memo ?? ""} onChange={event => setValue({ ...value, memo: event.target.value || null })} style={{ ...keepingInputStyle, minHeight: 76, padding: "10px 12px", resize: "vertical", fontFamily: "inherit" }} />}</BarField>
        : <textarea aria-label={t.memo} rows={2} value={value.memo ?? ""} onChange={event => setValue({ ...value, memo: event.target.value || null })} style={{ ...keepingInputStyle, minHeight: 76, padding: "10px 12px", resize: "vertical", fontFamily: "inherit" }} />}
      {showActive ? <div style={{ display: "grid", gap: 5 }}>
        <span style={{ color: "#4b5563", fontSize: 12, fontWeight: 700, lineHeight: 1.35 }}>{t.status}</span>
        <BarSegmentedControl label={t.status} disabled={saving} value={value.isActive ? "active" : "inactive"} onChange={next => setValue({ ...value, isActive: next === "active" })} options={[{ value: "active", label: t.active }, { value: "inactive", label: t.inactive }]} />
      </div> : null}
    </BarSection>
    {layout === "modal" ? null : <button style={{ ...primaryButtonStyle, width: "100%", opacity: saving ? .6 : 1 }} disabled={saving}>{saving ? t.saving : submitLabel ?? t.save}</button>}
  </form>;
}
