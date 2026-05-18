export const INVENTORY_REASON_VALUES = [
  "purchase",
  "stock_check",
  "service",
  "other",
  "unclassified",
] as const;

export type InventoryReasonValue = (typeof INVENTORY_REASON_VALUES)[number];

export const INVENTORY_SOURCE_VALUES = [
  "quick_save",
  "edit_form",
  "create",
  "delete",
  "system",
] as const;

export type InventorySourceValue = (typeof INVENTORY_SOURCE_VALUES)[number];

export const INVENTORY_REGISTRATION_TYPES = [
  "existing_stock",
  "new_purchase",
] as const;

export type InventoryRegistrationType =
  (typeof INVENTORY_REGISTRATION_TYPES)[number];

export type QuickReasonValue = Exclude<
  InventoryReasonValue,
  "unclassified"
>;

export const QUICK_REASON_VALUES = [
  "purchase",
  "stock_check",
  "service",
  "other",
] as const satisfies readonly QuickReasonValue[];

export const INVENTORY_REASON_LABELS = {
  ko: {
    purchase: "구매입고",
    stock_check: "재고확인",
    service: "서비스/증정",
    other: "기타",
    unclassified: "미분류",
  },
  vi: {
    purchase: "Nhap mua",
    stock_check: "Kiem tra kho",
    service: "Dich vu/tang",
    other: "Khac",
    unclassified: "Chua phan loai",
  },
} satisfies Record<
  "ko" | "vi",
  Record<InventoryReasonValue, string>
>;

export function normalizeInventoryReason(
  value: unknown,
  fallback: InventoryReasonValue = "unclassified"
): InventoryReasonValue {
  if (value === "check") return "stock_check";
  return INVENTORY_REASON_VALUES.includes(value as InventoryReasonValue)
    ? (value as InventoryReasonValue)
    : fallback;
}

export function normalizeInventorySource(
  value: unknown,
  fallback: InventorySourceValue = "system"
): InventorySourceValue {
  return INVENTORY_SOURCE_VALUES.includes(value as InventorySourceValue)
    ? (value as InventorySourceValue)
    : fallback;
}

export function getReasonByRegistrationType(
  value: unknown
): InventoryReasonValue {
  if (value === "new_purchase") return "purchase";
  return "stock_check";
}

export function isPurchaseReason(value: unknown) {
  return normalizeInventoryReason(value) === "purchase";
}
