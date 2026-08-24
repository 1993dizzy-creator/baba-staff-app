"use client";

import { BarSegmentedControl, keepingInputStyle } from "@/components/bar/keeping/KeepingUi";
import type { FundAccount, PartnerFormValue } from "@/components/PartnerForm";
import type { PaymentMode } from "@/lib/partners/policy";
import { formatPartnerFundAccount, partnerText } from "@/lib/partners/text";

type Props = {
  lang: "ko" | "vi";
  value: PartnerFormValue;
  fundAccounts: FundAccount[];
  disabled?: boolean;
  compact?: boolean;
  onChange: (value: PartnerFormValue) => void;
};

function PolicySegmentedField<T extends string>({ label, value, disabled, compact, options, onChange }: { label: string; value: T; disabled?: boolean; compact?: boolean; options: Array<{ value: T; label: string }>; onChange: (value: T) => void }) {
  return <div style={{ display: "grid", gap: compact ? 4 : 5 }}><span style={{ color: "#4b5563", fontSize: 12, fontWeight: 700, lineHeight: 1.35 }}>{label} *</span><BarSegmentedControl compact={compact} label={label} value={value} disabled={disabled} onChange={onChange} options={options} /></div>;
}

export default function PartnerSettlementFields({ lang, value, fundAccounts, disabled, compact = false, onChange }: Props) {
  const t = partnerText[lang];
  const setPaymentMode = (paymentMode: PaymentMode) => onChange({
    ...value,
    paymentMode,
    settlementMode: paymentMode === "postpaid" ? "ad_hoc" : null,
    settlementRule: null,
    defaultPaymentTermDays: null,
  });

  const inputStyle = compact ? { ...keepingInputStyle, minHeight: 40, padding: "0 10px" } : keepingInputStyle;
  return <div style={{ display: "grid", gap: compact ? 8 : 10 }}>
    <div style={{ display: "grid", gap: compact ? 4 : 5 }}>
      <span style={{ color: "#4b5563", fontSize: 12, fontWeight: 700, lineHeight: 1.35 }}>{t.defaultFundAccount}</span>
      <select disabled={disabled} value={value.defaultFundAccountId ?? ""} onChange={event => onChange({ ...value, defaultFundAccountId: event.target.value ? Number(event.target.value) : null })} style={inputStyle}>
        <option value="">{t.noFundAccount}</option>
        {fundAccounts.map(account => <option key={account.id} value={account.id}>{formatPartnerFundAccount(account.code, lang, "full")}</option>)}
      </select>
    </div>
    <PolicySegmentedField compact={compact} label={t.paymentMode} value={value.paymentMode} disabled={disabled} onChange={setPaymentMode} options={[{ value: "immediate", label: t.immediate }, { value: "postpaid", label: t.postpaid }]} />
  </div>;
}
