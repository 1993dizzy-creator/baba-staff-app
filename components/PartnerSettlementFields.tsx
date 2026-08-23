"use client";

import { BarField, BarSegmentedControl, keepingInputStyle } from "@/components/bar/keeping/KeepingUi";
import type { PartnerFormValue } from "@/components/PartnerForm";
import type { PaymentMode, SettlementMode, SettlementRule } from "@/lib/partners/policy";
import { partnerText } from "@/lib/partners/text";

type Props = {
  lang: "ko" | "vi";
  value: PartnerFormValue;
  disabled?: boolean;
  onChange: (value: PartnerFormValue) => void;
};

function PolicySegmentedField<T extends string>({ label, value, disabled, options, onChange }: { label: string; value: T; disabled?: boolean; options: Array<{ value: T; label: string }>; onChange: (value: T) => void }) {
  return <div style={{ display: "grid", gap: 5 }}><span style={{ color: "#4b5563", fontSize: 12, fontWeight: 700, lineHeight: 1.35 }}>{label} *</span><BarSegmentedControl label={label} value={value} disabled={disabled} onChange={onChange} options={options} /></div>;
}

export default function PartnerSettlementFields({ lang, value, disabled, onChange }: Props) {
  const t = partnerText[lang];
  const setPaymentMode = (paymentMode: PaymentMode) => onChange({
    ...value,
    paymentMode,
    settlementMode: null,
    settlementRule: null,
    defaultPaymentTermDays: null,
  });
  const setSettlementMode = (settlementMode: SettlementMode) => onChange({
    ...value,
    settlementMode,
    settlementRule: null,
    defaultPaymentTermDays: null,
  });
  const setSettlementRule = (settlementRule: SettlementRule) => onChange({
    ...value,
    settlementRule,
    defaultPaymentTermDays: null,
  });

  return <div style={{ display: "grid", gap: 10 }}>
    <PolicySegmentedField label={t.paymentMode} value={value.paymentMode} disabled={disabled} onChange={setPaymentMode} options={[{ value: "immediate", label: t.immediate }, { value: "postpaid", label: t.postpaid }]} />
    {value.paymentMode === "postpaid" ? <>
      {value.settlementMode === null ? <p role="status" style={{ margin: 0, padding: "9px 11px", borderRadius: 9, background: "#fff7ed", color: "#9a3412", fontSize: 11, lineHeight: 1.45 }}>{t.legacySettlement}</p> : null}
      <PolicySegmentedField<SettlementMode | ""> label={t.settlementMode} value={value.settlementMode ?? ""} disabled={disabled} onChange={mode => { if (mode) setSettlementMode(mode); }} options={[{ value: "ad_hoc", label: t.adHoc }, { value: "scheduled", label: t.scheduled }]} />
      {value.settlementMode === "scheduled" ? <>
        <PolicySegmentedField<SettlementRule | ""> label={t.settlementRule} value={value.settlementRule ?? ""} disabled={disabled} onChange={rule => { if (rule) setSettlementRule(rule); }} options={[{ value: "net_days", label: t.netDays }, { value: "monthly_once", label: t.monthlyOnce }, { value: "monthly_twice", label: t.monthlyTwice }]} />
        {value.settlementRule === "net_days" ? <BarField label={t.paymentDeadline} required help={t.paymentDeadlineHelp}>{({ id, describedBy }) => <div style={{ position: "relative" }}><input id={id} aria-describedby={describedBy} required type="number" inputMode="numeric" min={0} max={3650} step={1} disabled={disabled} value={value.defaultPaymentTermDays ?? ""} onChange={event => onChange({ ...value, defaultPaymentTermDays: event.target.value === "" ? null : Number(event.target.value) })} style={{ ...keepingInputStyle, paddingRight: 42 }} /><span aria-hidden="true" style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", color: "#6b7280", fontSize: 12 }}>{t.days}</span></div>}</BarField> : null}
      </> : null}
    </> : null}
  </div>;
}
