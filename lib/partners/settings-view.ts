// 장부설정 > 거래처 sub-views and their URL contract
// (/admin/ledger/settings?tab=partners&view=pending|active|inactive).
export const PARTNER_SETTINGS_VIEWS = ["pending", "active", "inactive"] as const;
export type PartnerSettingsView = (typeof PARTNER_SETTINGS_VIEWS)[number];

export function parsePartnerSettingsView(value: string | null | undefined): PartnerSettingsView {
  return (PARTNER_SETTINGS_VIEWS as readonly string[]).includes(value ?? "") ? value as PartnerSettingsView : "active";
}

export const LEDGER_SETTINGS_TABS = ["basic", "partners", "reserves"] as const;
export type LedgerSettingsTab = (typeof LEDGER_SETTINGS_TABS)[number];

export function parseLedgerSettingsTab(value: string | null | undefined): LedgerSettingsTab {
  return (LEDGER_SETTINGS_TABS as readonly string[]).includes(value ?? "") ? value as LedgerSettingsTab : "basic";
}

export function ledgerSettingsHref(tab: LedgerSettingsTab, view?: PartnerSettingsView) {
  const params = new URLSearchParams({ tab });
  if (tab === "partners" && view) params.set("view", view);
  return `/admin/ledger/settings?${params.toString()}`;
}

// Old /admin/partners URLs keep working: every other query parameter is preserved.
export function legacyPartnerRedirectHref(view: PartnerSettingsView, searchParams: Record<string, string | string[] | undefined>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (key === "tab" || key === "view" || value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) params.append(key, item);
  }
  params.set("tab", "partners");
  params.set("view", view);
  return `/admin/ledger/settings?${params.toString()}`;
}

export const ledgerSettingsTabText = {
  ko: { basic: "기본설정", partners: "거래처", reserves: "준비금", tabsLabel: "장부설정 유형", fundAccounts: "자금계정", ownerSettlement: "사장 정산", accountCount: (count: number) => `${count}개`, participantCount: (count: number) => `참여자 ${count}명` },
  vi: { basic: "Cài đặt cơ bản", partners: "Đối tác", reserves: "Quỹ dự phòng", tabsLabel: "Loại cài đặt sổ", fundAccounts: "Tài khoản quỹ", ownerSettlement: "Quyết toán chủ", accountCount: (count: number) => `${count} tài khoản`, participantCount: (count: number) => `${count} người tham gia` },
} as const;

export const partnerSettingsText = {
  ko: { title: "거래처 설정", add: "+ 거래처 추가", addTitle: "거래처 추가", close: "닫기", manageSubtypes: "중분류 관리", pending: "등록대기", active: "사용중", inactive: "사용안함", empty: "조건에 맞는 거래처가 없습니다." },
  vi: { title: "Cài đặt đối tác", add: "+ Thêm đối tác", addTitle: "Thêm đối tác", close: "Đóng", manageSubtypes: "Quản lý danh mục phụ", pending: "Chờ duyệt", active: "Đang dùng", inactive: "Ngừng dùng", empty: "Không có đối tác phù hợp." },
} as const;
