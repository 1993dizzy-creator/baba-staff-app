"use client";

import { formatNumber } from "@/lib/inventory/money";
import {
  AUTO_BILLED_AMOUNT,
  editBilledAmountDraft,
  resolveBilledAmount,
  type BilledAmountDraft,
} from "@/lib/inventory/billed-amount";

const TEXT = {
  ko: {
    label: "실청구금액 (₫)",
    auto: "자동계산",
    manual: "직접 입력",
    calculated: "계산금액",
    difference: "차액",
    restore: "자동계산 복원",
    waiting: "수량·단가를 입력하면 자동 계산됩니다",
    invalid: "실청구금액을 입력하거나 자동계산을 복원해 주세요.",
    hint: "영수증 금액이 다를 때만 수정하세요. 실제 지급액은 장부 지급에서 따로 기록합니다.",
  },
  vi: {
    label: "Số tiền thực tính (₫)",
    auto: "Tự động",
    manual: "Nhập tay",
    calculated: "Tiền tính",
    difference: "Chênh lệch",
    restore: "Khôi phục tự động",
    waiting: "Nhập số lượng và đơn giá để tự tính",
    invalid: "Nhập số tiền thực tính hoặc khôi phục tự động.",
    hint: "Chỉ sửa khi số tiền trên hóa đơn khác. Số tiền thực trả được ghi riêng ở phần thanh toán sổ.",
  },
} as const;

const money = (value: number | null) => (value == null ? "-" : `${Math.round(value).toLocaleString("en-US")} ₫`);
const signedMoney = (value: number | null) =>
  value == null ? "-" : `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(Math.round(value)).toLocaleString("en-US")} ₫`;

// Always-visible 실청구금액 field of one receipt. Auto shows quantity x price and follows it;
// typing switches to manual and keeps the typed amount until 자동계산 복원.
export default function BilledAmountField({
  lang,
  calculated,
  draft,
  onChange,
  disabled = false,
  testId = "billed-amount",
}: {
  lang: "ko" | "vi";
  calculated: number | null;
  draft: BilledAmountDraft;
  onChange: (draft: BilledAmountDraft) => void;
  disabled?: boolean;
  testId?: string;
}) {
  const t = TEXT[lang];
  const resolved = resolveBilledAmount(draft, calculated);
  const manual = draft.mode === "manual";
  const inputValue = manual ? draft.manualText : calculated == null ? "" : formatNumber(Math.round(calculated));
  const differenceColor = !resolved.difference ? "#374151" : resolved.difference < 0 ? "#b91c1c" : "#1d4ed8";

  return (
    <div data-testid={testId} data-mode={draft.mode}
      style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0, padding: 8, borderRadius: 10,
        border: `1px solid ${manual ? "#fcd34d" : "#e5e7eb"}`, background: manual ? "#fffbeb" : "#f9fafb" }}>
      <label style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0, fontSize: 12, fontWeight: 800, color: "#111827" }}>
        <span style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
          {t.label}
          <span data-testid={`${testId}-mode`} style={{ padding: "1px 7px", borderRadius: 999, fontSize: 11, fontWeight: 800, whiteSpace: "nowrap",
            background: manual ? "#f59e0b" : "#e5e7eb", color: manual ? "#fff" : "#374151" }}>
            {manual ? t.manual : t.auto}
          </span>
        </span>
        <input type="text" inputMode="numeric" autoComplete="off" value={inputValue} disabled={disabled}
          placeholder={calculated == null ? t.waiting : undefined}
          data-testid={`${testId}-input`}
          onChange={(event) => onChange(editBilledAmountDraft(event.target.value))}
          style={{ width: "100%", minWidth: 0, boxSizing: "border-box", padding: "9px 10px", borderRadius: 8,
            border: "1px solid #d1d5db", background: "#fff", fontSize: 16, fontWeight: 800, color: "#111827" }} />
      </label>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "4px 10px", fontSize: 12, color: "#374151" }}>
        <span data-testid={`${testId}-calculated`}>{t.calculated} {money(calculated)}</span>
        <span data-testid={`${testId}-difference`} style={{ fontWeight: 800, color: differenceColor }}>
          {t.difference} {signedMoney(resolved.difference)}
        </span>
        <span style={{ flex: "1 1 auto" }} />
        {manual && (
          <button type="button" disabled={disabled} data-testid={`${testId}-restore`}
            onClick={() => onChange(AUTO_BILLED_AMOUNT)}
            style={{ minHeight: 28, padding: "4px 10px", borderRadius: 999, border: "1px solid #d1d5db", background: "#fff",
              color: "#111827", fontSize: 12, fontWeight: 800, whiteSpace: "nowrap", cursor: disabled ? "default" : "pointer" }}>
            {t.restore}
          </button>
        )}
      </div>
      {manual && !resolved.valid
        ? <div role="alert" style={{ fontSize: 12, fontWeight: 700, color: "#b91c1c" }}>{t.invalid}</div>
        : <div style={{ fontSize: 11, color: "#6b7280", overflowWrap: "anywhere" }}>{t.hint}</div>}
    </div>
  );
}
