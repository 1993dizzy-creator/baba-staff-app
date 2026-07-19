export const STORE_TIMEZONE = "Asia/Ho_Chi_Minh" as const;
export const STORE_DEFAULT_CUTOFF = "03:00" as const;

export type StoreLanguage = "ko" | "vi";
export type StoreRole = "owner" | "master" | "manager" | "leader" | string;

export type StoreBusinessHour = {
  weekday: number;
  isClosed: boolean;
  openTime: string | null;
  closeTime: string | null;
};

export type StoreSetting = {
  id: number;
  timezone: typeof STORE_TIMEZONE;
  businessDayCutoffTime: string;
  effectiveFromBusinessDate: string;
  revision: number;
  state: "active" | "cancelled";
  createdBy: number;
  createdAt: string;
  cancelledBy: number | null;
  cancelledAt: string | null;
  hours: StoreBusinessHour[];
};

export type StoreSettingsOverview = {
  businessDate: string;
  latestRevision: number;
  current: StoreSetting | null;
  scheduled: StoreSetting | null;
  fallbackUsed: boolean;
};

export type StoreSettingAuditLog = {
  id: number;
  setting_version_id: number;
  action: "created" | "cancelled";
  actor_user_id: number;
  before_snapshot: StoreSetting | null;
  after_snapshot: StoreSetting | null;
  created_at: string;
  actorName?: string;
};

export const DEFAULT_STORE_HOURS: StoreBusinessHour[] = [
  { weekday: 0, isClosed: false, openTime: "17:00", closeTime: "01:00" },
  ...Array.from({ length: 6 }, (_, index) => ({
    weekday: index + 1,
    isClosed: false,
    openTime: "16:00",
    closeTime: "01:00",
  })),
];
