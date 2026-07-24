import {
  DEFAULT_STORE_ATTENDANCE_POLICY,
  DEFAULT_STORE_HOURS,
  STORE_DEFAULT_CUTOFF,
  STORE_TIMEZONE,
  type StoreSetting,
} from "./types";

export function fallbackStoreSetting(businessDate: string): StoreSetting {
  return {
    id: 0,
    timezone: STORE_TIMEZONE,
    businessDayCutoffTime: STORE_DEFAULT_CUTOFF,
    effectiveFromBusinessDate: businessDate,
    revision: 0,
    state: "active",
    createdBy: 0,
    createdAt: "",
    cancelledBy: null,
    cancelledAt: null,
    attendancePolicy: { ...DEFAULT_STORE_ATTENDANCE_POLICY },
    hours: DEFAULT_STORE_HOURS,
  };
}
