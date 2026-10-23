// Shared KO/VI display labels for ledger_reserve_entries.entry_type. The stored
// enum values never change; only the visible text does.
const RESERVE_ENTRY_TYPE_LABELS = {
  ko: { allocate: "적립", release: "해제", consume: "사용", adjustment: "조정" },
  vi: { allocate: "Trích lập", release: "Giải phóng", consume: "Sử dụng", adjustment: "Điều chỉnh" },
} as const;

export type ReserveEntryTypeKey = keyof (typeof RESERVE_ENTRY_TYPE_LABELS)["ko"];
export const RESERVE_ENTRY_TYPE_KEYS = Object.keys(RESERVE_ENTRY_TYPE_LABELS.ko) as ReserveEntryTypeKey[];

export function reserveEntryTypeLabel(entryType: ReserveEntryTypeKey, lang: "ko" | "vi") {
  return RESERVE_ENTRY_TYPE_LABELS[lang][entryType];
}

// For raw DB values: an unknown entry_type is shown as stored.
export function reserveEntryTypeText(entryType: string, lang: "ko" | "vi") {
  return (RESERVE_ENTRY_TYPE_LABELS[lang] as Record<string, string>)[entryType] ?? entryType;
}

// Display-only sign for a reserve entry amount. release/consume read as
// outflows, allocate as unsigned, adjustment keeps its stored sign. The stored
// amount is never changed.
export function reserveEntryDisplaySign(entryType: string, amount: number) {
  if (entryType === "release" || entryType === "consume") return "−";
  return entryType === "adjustment" && amount < 0 ? "−" : "";
}
