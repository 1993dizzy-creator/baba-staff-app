// @ts-expect-error Node's direct TypeScript tests require an explicit extension.
import { addStoreDays, calculateStoreBusinessDate, getStoreOperationState, isStoreTime, validateStoreHours } from "./business-time-core.ts";
// @ts-expect-error Node's direct TypeScript tests require an explicit extension.
import { DEFAULT_STORE_HOURS, STORE_DEFAULT_CUTOFF, STORE_TIMEZONE, type StoreBusinessHour, type StoreSetting } from "./types.ts";

const STORE_UTC_OFFSET = "+07:00";

export type BusinessTimeSource = "configured" | "fallback";

export type BusinessTimeSnapshot = {
  timezone: typeof STORE_TIMEZONE;
  cutoff: string;
  effectiveFromBusinessDate: string;
  revision: number;
  source: BusinessTimeSource;
  isFallback: boolean;
  hours: StoreBusinessHour[];
};

export type BusinessTimeContext = BusinessTimeSnapshot & {
  businessDate: string;
  dayOfWeek: number;
  isClosed: boolean;
  openTime: string | null;
  closeTime: string | null;
  openAt: string | null;
  closeAt: string | null;
  cutoffAt: string;
  collectionFrom: string | null;
  collectionTo: string;
  isOpen: boolean;
  isAfterCloseBeforeCutoff: boolean;
};

function withSeconds(time: string) {
  return `${time}:00`;
}

function timestampAt(dateKey: string, time: string) {
  return `${dateKey}T${withSeconds(time)}${STORE_UTC_OFFSET}`;
}

function weekdayForDateKey(dateKey: string) {
  return new Date(`${dateKey}T00:00:00Z`).getUTCDay();
}

export function createFallbackBusinessTimeSnapshot(
  effectiveFromBusinessDate: string
): BusinessTimeSnapshot {
  return {
    timezone: STORE_TIMEZONE,
    cutoff: STORE_DEFAULT_CUTOFF,
    effectiveFromBusinessDate,
    revision: 0,
    source: "fallback",
    isFallback: true,
    hours: DEFAULT_STORE_HOURS.map((hour) => ({ ...hour })),
  };
}

export function createBusinessTimeSnapshot(
  setting: StoreSetting | null | undefined,
  fallbackBusinessDate: string
): BusinessTimeSnapshot {
  if (
    !setting ||
    setting.timezone !== STORE_TIMEZONE ||
    !isStoreTime(setting.businessDayCutoffTime) ||
    !validateStoreHours(setting.hours)
  ) {
    return createFallbackBusinessTimeSnapshot(fallbackBusinessDate);
  }

  return {
    timezone: setting.timezone,
    cutoff: setting.businessDayCutoffTime,
    effectiveFromBusinessDate: setting.effectiveFromBusinessDate,
    revision: setting.revision,
    source: "configured",
    isFallback: false,
    hours: setting.hours.map((hour) => ({ ...hour })),
  };
}

export function buildPosCollectionWindow(
  businessDate: string,
  snapshot: BusinessTimeSnapshot
) {
  const weekday = weekdayForDateKey(businessDate);
  const hour = snapshot.hours.find((item) => item.weekday === weekday);
  const nextDate = addStoreDays(businessDate, 1);
  const collectionFrom = hour?.openTime
    ? timestampAt(businessDate, hour.openTime)
    : null;

  return {
    dayOfWeek: weekday,
    isClosed: hour?.isClosed ?? true,
    openTime: hour?.openTime ?? null,
    closeTime: hour?.closeTime ?? null,
    openAt: collectionFrom,
    closeAt:
      hour?.openTime && hour.closeTime
        ? timestampAt(
            hour.closeTime <= hour.openTime ? nextDate : businessDate,
            hour.closeTime
          )
        : null,
    cutoffAt: timestampAt(nextDate, snapshot.cutoff),
    collectionFrom,
    collectionTo: timestampAt(nextDate, snapshot.cutoff),
  };
}

export function isStoreClosedOnBusinessDate(
  businessDate: string,
  hours: readonly StoreBusinessHour[],
) {
  const weekday = weekdayForDateKey(businessDate);
  const hour = hours.find((item) => item.weekday === weekday);
  return hour?.isClosed ?? true;
}

export function resolveStoreClosedByDate(
  dates: readonly string[],
  timeline: ReadonlyArray<{
    id: number;
    effectiveFromBusinessDate: string;
    hours: StoreBusinessHour[];
  }>,
) {
  const sorted = [...timeline].sort((a, b) =>
    a.effectiveFromBusinessDate === b.effectiveFromBusinessDate
      ? a.id - b.id
      : a.effectiveFromBusinessDate.localeCompare(b.effectiveFromBusinessDate),
  );
  const result = new Map<string, boolean>();
  for (const date of dates) {
    let current: (typeof sorted)[number] | null = null;
    for (const row of sorted) {
      if (row.effectiveFromBusinessDate > date) break;
      current = row;
    }
    result.set(date, current ? isStoreClosedOnBusinessDate(date, current.hours) : false);
  }
  return result;
}

export function calculateBusinessTimeContext(
  timestamp: Date | string,
  snapshot: BusinessTimeSnapshot
): BusinessTimeContext {
  const businessDate = calculateStoreBusinessDate(
    timestamp,
    snapshot.cutoff,
    snapshot.timezone
  );
  const window = buildPosCollectionWindow(businessDate, snapshot);
  const operation = getStoreOperationState(
    timestamp,
    snapshot.hours,
    snapshot.cutoff,
    snapshot.timezone
  );

  return { ...snapshot, businessDate, ...window, ...operation };
}
