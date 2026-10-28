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

// v2 manual entry kinds (ledger_create_reserve_entry_v2) and the allocate kinds shown in
// history. extra/restore are stored as entry_type 'allocate' + allocation_kind.
const RESERVE_KIND_LABELS = {
  ko: { regular: "정기 적립", extra: "추가 적립", restore: "해제금 복구", release: "해제", consume: "사용" },
  vi: { regular: "Trích lập định kỳ", extra: "Trích lập thêm", restore: "Hoàn lại khoản đã giải phóng", release: "Giải phóng", consume: "Sử dụng" },
} as const;

export function reserveKindLabel(kind: keyof (typeof RESERVE_KIND_LABELS)["ko"], lang: "ko" | "vi") {
  return RESERVE_KIND_LABELS[lang][kind];
}

// History label: v2 allocate rows name their kind; v1 rows keep the entry_type label.
export function reserveEntryLabel(entry: { entry_type: string; allocation_kind?: string | null }, lang: "ko" | "vi") {
  const kind = entry.entry_type === "allocate" ? entry.allocation_kind : null;
  return kind && kind in RESERVE_KIND_LABELS[lang]
    ? RESERVE_KIND_LABELS[lang][kind as keyof (typeof RESERVE_KIND_LABELS)["ko"]]
    : reserveEntryTypeText(entry.entry_type, lang);
}

// Display-only sign for a reserve entry amount. release/consume read as
// outflows, allocate as unsigned, adjustment keeps its stored sign. The stored
// amount is never changed.
export function reserveEntryDisplaySign(entryType: string, amount: number) {
  if (entryType === "release" || entryType === "consume") return "−";
  return entryType === "adjustment" && amount < 0 ? "−" : "";
}
