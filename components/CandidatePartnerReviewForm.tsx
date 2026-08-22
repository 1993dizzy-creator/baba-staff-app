"use client";

import { useState, type FormEvent } from "react";
import { BarField, BarSection, BarSegmentedControl, keepingInputStyle, primaryButtonStyle } from "@/components/bar/keeping/KeepingUi";
import type { PartnerFormValue } from "@/components/PartnerForm";
import { PARTNER_TYPES, type PartnerType, type PaymentMode } from "@/lib/partners/policy";
import { partnerText, partnerTypeLabels } from "@/lib/partners/text";

type Props = {
  lang: "ko" | "vi";
  initial: PartnerFormValue;
  submitLabel: string;
  onSubmit: (value: PartnerFormValue) => Promise<boolean>;
};

const candidateBasicGrid: React.CSSProperties = { display: "grid", gridTemplateColumns: "minmax(0, 1.65fr) minmax(110px, 1fr)", gap: 10, alignItems: "start" };
const candidateTwoColumnGrid: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10, alignItems: "start" };

export default function CandidatePartnerReviewForm({ lang, initial, submitLabel, onSubmit }: Props) {
  const t = partnerText[lang];
  const labels = lang === "vi"
    ? { basic: "Thông tin cơ bản", payment: "Hình thức thanh toán", contact: "Liên hệ", memo: "Ghi chú" }
    : { basic: "기본 정보", payment: "결제 방식", contact: "연락처", memo: "메모" };
  const [value, setValue] = useState(initial);
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try { await onSubmit(value); } finally { setSaving(false); }
  }

  return <form onSubmit={submit}>
    <BarSection title={labels.basic} icon="📌">
      <div style={candidateBasicGrid}>
        <BarField label={t.name} required>{({ id }) => <input id={id} required maxLength={200} value={value.name} onChange={event => setValue({ ...value, name: event.target.value })} style={keepingInputStyle} />}</BarField>
        <BarField label={t.type}>{({ id }) => <select id={id} value={value.partnerType} onChange={event => setValue({ ...value, partnerType: event.target.value as PartnerType })} style={keepingInputStyle}>{PARTNER_TYPES.map(type => <option key={type} value={type}>{partnerTypeLabels[type][lang]}</option>)}</select>}</BarField>
      </div>
    </BarSection>
    <BarSection title={labels.payment} icon="💳">
      <BarSegmentedControl label={t.paymentMode} value={value.paymentMode} disabled={saving} onChange={(mode: PaymentMode) => setValue({ ...value, paymentMode: mode, defaultPaymentTermDays: mode === "immediate" ? null : value.defaultPaymentTermDays ?? 30 })} options={[{ value: "immediate", label: t.immediate }, { value: "postpaid", label: t.postpaid }]} />
    </BarSection>
    <BarSection title={labels.contact} icon="☎️">
      <div style={candidateTwoColumnGrid}>
        <BarField label={t.contact}>{({ id }) => <input id={id} maxLength={120} value={value.contactName ?? ""} onChange={event => setValue({ ...value, contactName: event.target.value || null })} style={keepingInputStyle} />}</BarField>
        <BarField label={t.phone}>{({ id }) => <input id={id} type="tel" maxLength={80} value={value.phone ?? ""} onChange={event => setValue({ ...value, phone: event.target.value || null })} style={keepingInputStyle} />}</BarField>
      </div>
    </BarSection>
    <BarSection title={labels.memo} icon="📝">
      <textarea aria-label={labels.memo} rows={2} value={value.memo ?? ""} onChange={event => setValue({ ...value, memo: event.target.value || null })} style={{ ...keepingInputStyle, minHeight: 76, padding: "10px 12px", resize: "vertical", fontFamily: "Arial, Helvetica, sans-serif", lineHeight: 1.5 }} />
    </BarSection>
    <button disabled={saving} style={{ ...primaryButtonStyle, width: "100%", opacity: saving ? .6 : 1 }}>{saving ? t.saving : submitLabel}</button>
  </form>;
}
