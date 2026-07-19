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

export type BusinessTimeShadow = {
  matches: boolean;
  differences: Array<"businessDate" | "databaseBusinessDate" | "collectionFrom" | "collectionTo">;
  legacy: { businessDate: string; collectionFrom: string; collectionTo: string };
  configured: { businessDate: string; collectionFrom: string | null; collectionTo: string };
  databaseBusinessDate: string;
  settingRevision: number;
  isFallback: boolean;
};

function withSeconds(time: string) {
  return `${time}:00`;
}

function timestampAt(dateKey: string, time: string) {
  return `${dateKey}T${withSeconds(time)}${STORE_UTC_OFFSET}`;
}

function sameInstant(left: string | null, right: string | null) {
  if (left === null || right === null) return left === right;
  return new Date(left).getTime() === new Date(right).getTime();
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

export function compareBusinessTimeShadow(params: {
  legacyBusinessDate: string;
  legacyCollectionFrom: string;
  legacyCollectionTo: string;
  configured: BusinessTimeContext;
  databaseBusinessDate: string;
}): BusinessTimeShadow {
  const differences: BusinessTimeShadow["differences"] = [];
  if (params.legacyBusinessDate !== params.configured.businessDate) differences.push("businessDate");
  if (params.databaseBusinessDate !== params.configured.businessDate) differences.push("databaseBusinessDate");
  if (!sameInstant(params.legacyCollectionFrom, params.configured.collectionFrom)) differences.push("collectionFrom");
  if (!sameInstant(params.legacyCollectionTo, params.configured.collectionTo)) differences.push("collectionTo");

  return {
    matches: differences.length === 0,
    differences,
    legacy: {
      businessDate: params.legacyBusinessDate,
      collectionFrom: params.legacyCollectionFrom,
      collectionTo: params.legacyCollectionTo,
    },
    configured: {
      businessDate: params.configured.businessDate,
      collectionFrom: params.configured.collectionFrom,
      collectionTo: params.configured.collectionTo,
    },
    databaseBusinessDate: params.databaseBusinessDate,
    settingRevision: params.configured.revision,
    isFallback: params.configured.isFallback,
  };
}
