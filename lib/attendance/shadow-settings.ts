import type {
  StoreAttendancePolicy,
  StoreSetting,
} from "../store-settings/types";

export type ResolvedAttendanceShadowSetting = {
  setting: StoreSetting;
  fallbackUsed: boolean;
  settingId: number | null;
  revision: number | null;
  attendancePolicy: StoreAttendancePolicy | null;
};

export function resolveAttendanceShadowSetting(
  businessDate: string,
  current: StoreSetting | null,
  createFallback: (date: string) => StoreSetting
): ResolvedAttendanceShadowSetting {
  if (current) {
    return {
      setting: current,
      fallbackUsed: false,
      settingId: current.id,
      revision: current.revision,
      attendancePolicy: current.attendancePolicy ?? null,
    };
  }

  const setting = createFallback(businessDate);
  return {
    setting,
    fallbackUsed: true,
    settingId: null,
    revision: null,
    attendancePolicy: { ...setting.attendancePolicy },
  };
}
