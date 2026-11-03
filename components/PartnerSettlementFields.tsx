"use client";

import { BarSegmentedControl, keepingInputStyle } from "@/components/bar/keeping/KeepingUi";
import type { FundAccount, PartnerFormValue } from "@/components/PartnerForm";
import { SETTLEMENT_RULES, type PaymentMode, type SettlementRule } from "@/lib/partners/policy";
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
    ...(paymentMode === value.paymentMode ? {} : {
      settlementMode: null,
      settlementRule: null,
      settlementDays: null,
      defaultPaymentTermDays: null,
    }),
  });
  const labels = lang === "ko" ? {
    title: "정산조건", unset: "미지정", ad_hoc: "비정기 정산", weekly: "주간 정산", monthly_once: "월 1회 정산", monthly_twice: "월 2회 정산", net_days: "매입 후 N일 지급", weekday: "지급 요일", day: "지급일", days: "매입 후 지급일까지 일수", end: "말일", choose: "선택", note: "거래처 조건만 저장합니다. 기존 거래와 미지급금 지급기한은 변경하지 않습니다.", shortMonth: "해당 날짜가 없는 달은 말일 기준입니다.",
  } : {
    title: "Điều kiện thanh toán", unset: "Chưa xác định", ad_hoc: "Không định kỳ", weekly: "Hàng tuần", monthly_once: "Mỗi tháng 1 lần", monthly_twice: "Mỗi tháng 2 lần", net_days: "Trả sau N ngày kể từ khi mua", weekday: "Thứ thanh toán", day: "Ngày thanh toán", days: "Số ngày sau khi mua", end: "Cuối tháng", choose: "Chọn", note: "Chỉ lưu điều kiện đối tác. Không thay đổi giao dịch hoặc hạn trả công nợ hiện có.", shortMonth: "Nếu tháng không có ngày đã chọn, dùng ngày cuối tháng.",
  };
  const weekdays = lang === "ko" ? ["월요일", "화요일", "수요일", "목요일", "금요일", "토요일", "일요일"] : ["Thứ Hai", "Thứ Ba", "Thứ Tư", "Thứ Năm", "Thứ Sáu", "Thứ Bảy", "Chủ Nhật"];
  const changeRule = (rule: string) => onChange({ ...value, settlementMode: rule === "" ? null : rule === "ad_hoc" ? "ad_hoc" : "scheduled", settlementRule: rule === "" || rule === "ad_hoc" ? null : rule as SettlementRule, settlementDays: rule && rule !== "ad_hoc" && rule !== "net_days" ? [] : null, defaultPaymentTermDays: null });

  const inputStyle = compact ? { ...keepingInputStyle, minHeight: 40, padding: "0 10px" } : keepingInputStyle;
  return <div style={{ display: "grid", gap: compact ? 8 : 10 }}>
    <div style={{ display: "grid", gap: compact ? 4 : 5 }}>
      <span style={{ color: "#4b5563", fontSize: 12, fontWeight: 700, lineHeight: 1.35 }}>{t.defaultFundAccount}</span>
      <select disabled={disabled} value={value.defaultFundAccountId ?? ""} onChange={event => onChange({ ...value, defaultFundAccountId: event.target.value ? Number(event.target.value) : null })} style={inputStyle}>
        <option value="">{t.noFundAccount}</option>
        {fundAccounts.map(account => <option key={account.id} value={account.id}>{formatPartnerFundAccount(account.code, lang, "full")}</option>)}
      </select>
    </div>
    <PolicySegmentedField compact={compact} label={t.paymentMode} value={value.paymentMode} disabled={disabled} onChange={setPaymentMode} options={[{ value: "unspecified", label: t.unspecified }, { value: "immediate", label: t.immediate }, { value: "postpaid", label: t.postpaid }]} />
    {value.paymentMode === "postpaid" && <>
      <label>{labels.title}<select style={inputStyle} disabled={disabled} value={value.settlementMode === "ad_hoc" ? "ad_hoc" : value.settlementRule ?? ""} onChange={event => changeRule(event.target.value)}>
        <option value="">{labels.unset}</option><option value="ad_hoc">{labels.ad_hoc}</option>
        {SETTLEMENT_RULES.map(rule => <option key={rule} value={rule}>{labels[rule]}</option>)}
      </select></label>
      {value.settlementMode === "scheduled" && value.settlementRule === "net_days" && <label>{labels.days}<input style={inputStyle} disabled={disabled} required type="number" min={0} max={3650} step={1} value={value.defaultPaymentTermDays ?? ""} onChange={event => onChange({ ...value, defaultPaymentTermDays: event.target.value === "" ? null : Number(event.target.value) })} /></label>}
      {value.settlementMode === "scheduled" && value.settlementRule && value.settlementRule !== "net_days" && Array.from({ length: value.settlementRule === "monthly_twice" ? 2 : 1 }, (_, index) => <label key={index}>{value.settlementRule === "weekly" ? labels.weekday : `${labels.day} ${index + 1}`}<select style={inputStyle} disabled={disabled} required={value.settlementDays != null} value={value.settlementDays?.[index] ?? ""} onChange={event => {
        const days = [...(value.settlementDays ?? [])];
        days[index] = Number(event.target.value);
        onChange({ ...value, settlementDays: days });
      }}>
        <option value="" disabled>{labels.choose}</option>
        {value.settlementRule === "weekly" ? weekdays.map((day, i) => <option key={i} value={i + 1}>{day}</option>) : <><option value={0} disabled={value.settlementRule === "monthly_twice" && value.settlementDays?.[1 - index] === 0}>{labels.end}</option>{Array.from({ length: 31 }, (_, i) => <option key={i} value={i + 1} disabled={value.settlementRule === "monthly_twice" && value.settlementDays?.[1 - index] === i + 1}>{i + 1}</option>)}</>}
      </select></label>)}
      {value.settlementRule?.startsWith("monthly") && <small>{labels.shortMonth}</small>}
      <small style={{ color: "#6b7280" }}>{labels.note}</small>
    </>}
  </div>;
}
