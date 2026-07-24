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

export type StoreAttendancePolicy = {
  lateGraceMinutes: number;
  defaultNormalCheckoutTime: string;
};

export const DEFAULT_STORE_ATTENDANCE_POLICY: StoreAttendancePolicy = {
  lateGraceMinutes: 0,
  defaultNormalCheckoutTime: "00:00",
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
  attendancePolicy: StoreAttendancePolicy;
  hours: StoreBusinessHour[];
};

export type StoreBusinessDayOverride = {
  id: number;
  businessDate: string;
  actualCloseTime: string;
  reason: string | null;
  state: "active" | "cancelled";
  createdBy: number;
  createdAt: string;
  updatedBy: number | null;
  updatedAt: string | null;
  cancelledBy: number | null;
  cancelledAt: string | null;
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
  ...Array.from({ length: 7 }, (_, weekday) => ({
    weekday,
    isClosed: false,
    openTime: "16:00",
    closeTime: "01:00",
  })),
];
