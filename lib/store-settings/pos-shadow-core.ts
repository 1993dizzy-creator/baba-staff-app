import type { BusinessTimeSnapshot } from "./business-time-adapter-core.ts";

export type PosShadowStatus = "ready" | "mismatch" | "incomplete";

export type PosShadowObservation = {
  timestamp: string | null;
  configuredPureBusinessDate: string | null;
  configuredDbBusinessDate: string | null;
  inLegacyRange: boolean;
  inConfiguredRange: boolean;
  status: "completed" | "canceled" | "other";
  optionLineCount: number;
  parentLineCount: number;
};

export type PosShadowResult = {
  status: PosShadowStatus;
  businessDate: string;
  setting: {
    revision: number;
    timezone: string;
    cutoff: string;
    effectiveFromBusinessDate: string;
    isFallback: boolean;
  };
  window: {
    legacy: { from: string; to: string };
    configured: { from: string | null; to: string };
    fromMatches: boolean;
    toMatches: boolean;
    matches: boolean;
  };
  cukcuk: {
    listCount: number;
    detailCount: number;
    limit: number;
    limitReached: boolean;
    missingTimestampCount: number;
    detailFailureCount: number;
    completedCount: number;
    canceledCount: number;
    otherStatusCount: number;
    optionLineCount: number;
    parentLineCount: number;
  };
  businessDateComparison: {
    comparableCount: number;
    legacyConfiguredMatchCount: number;
    legacyConfiguredMismatchCount: number;
    pureDbComparableCount: number;
    pureDbMatchCount: number;
    pureDbMismatchCount: number;
  };
  rangeSetComparison: {
    legacyIncludedCount: number;
    configuredIncludedCount: number;
    bothIncludedCount: number;
    legacyOnlyCount: number;
    configuredOnlyCount: number;
    idSetsMatch: boolean;
  };
  mismatchKinds: string[];
};

function sameInstant(left: string | null, right: string | null) {
  if (left === null || right === null) return left === right;
  const leftTime = new Date(left).getTime();
  const rightTime = new Date(right).getTime();
  return Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime === rightTime;
}

export function isTimestampInHalfOpenRange(
  timestamp: string | null,
  from: string | null,
  to: string
) {
  if (!timestamp || !from) return false;
  const value = new Date(timestamp).getTime();
  const lower = new Date(from).getTime();
  const upper = new Date(to).getTime();
  return Number.isFinite(value) && Number.isFinite(lower) && Number.isFinite(upper)
    && value >= lower && value < upper;
}

export function buildPosShadowResult(params: {
  businessDate: string;
  snapshot: BusinessTimeSnapshot;
  legacyWindow: { from: string; to: string };
  configuredWindow: { from: string | null; to: string };
  listCount: number;
  detailCount: number;
  detailFailureCount: number;
  limit: number;
  observations: PosShadowObservation[];
}): PosShadowResult {
  const fromMatches = sameInstant(params.legacyWindow.from, params.configuredWindow.from);
  const toMatches = sameInstant(params.legacyWindow.to, params.configuredWindow.to);
  const windowMatches = fromMatches && toMatches;
  const comparable = params.observations.filter(
    (item) => item.timestamp && item.configuredPureBusinessDate
  );
  const pureDbComparable = comparable.filter((item) => item.configuredDbBusinessDate);
  const legacyConfiguredMismatchCount = comparable.filter(
    (item) => item.configuredPureBusinessDate !== params.businessDate
  ).length;
  const pureDbMismatchCount = pureDbComparable.filter(
    (item) => item.configuredPureBusinessDate !== item.configuredDbBusinessDate
  ).length;
  const legacyOnlyCount = params.observations.filter(
    (item) => item.inLegacyRange && !item.inConfiguredRange
  ).length;
  const configuredOnlyCount = params.observations.filter(
    (item) => !item.inLegacyRange && item.inConfiguredRange
  ).length;
  const missingTimestampCount = params.observations.filter((item) => !item.timestamp).length;
  const limitReached = params.listCount >= params.limit;
  const mismatchKinds: string[] = [];
  if (!windowMatches) mismatchKinds.push("collectionWindow");
  if (legacyConfiguredMismatchCount > 0) mismatchKinds.push("legacyConfiguredBusinessDate");
  if (pureDbMismatchCount > 0) mismatchKinds.push("configuredPureDatabaseBusinessDate");
  if (legacyOnlyCount > 0 || configuredOnlyCount > 0) mismatchKinds.push("invoiceRangeSet");

  const status: PosShadowStatus = mismatchKinds.length > 0
    ? "mismatch"
    : limitReached || missingTimestampCount > 0 || params.detailFailureCount > 0
      ? "incomplete"
      : "ready";

  return {
    status,
    businessDate: params.businessDate,
    setting: {
      revision: params.snapshot.revision,
      timezone: params.snapshot.timezone,
      cutoff: params.snapshot.cutoff,
      effectiveFromBusinessDate: params.snapshot.effectiveFromBusinessDate,
      isFallback: params.snapshot.isFallback,
    },
    window: {
      legacy: params.legacyWindow,
      configured: params.configuredWindow,
      fromMatches,
      toMatches,
      matches: windowMatches,
    },
    cukcuk: {
      listCount: params.listCount,
      detailCount: params.detailCount,
      limit: params.limit,
      limitReached,
      missingTimestampCount,
      detailFailureCount: params.detailFailureCount,
      completedCount: params.observations.filter((item) => item.status === "completed").length,
      canceledCount: params.observations.filter((item) => item.status === "canceled").length,
      otherStatusCount: params.observations.filter((item) => item.status === "other").length,
      optionLineCount: params.observations.reduce((sum, item) => sum + item.optionLineCount, 0),
      parentLineCount: params.observations.reduce((sum, item) => sum + item.parentLineCount, 0),
    },
    businessDateComparison: {
      comparableCount: comparable.length,
      legacyConfiguredMatchCount: comparable.length - legacyConfiguredMismatchCount,
      legacyConfiguredMismatchCount,
      pureDbComparableCount: pureDbComparable.length,
      pureDbMatchCount: pureDbComparable.length - pureDbMismatchCount,
      pureDbMismatchCount,
    },
    rangeSetComparison: {
      legacyIncludedCount: params.observations.filter((item) => item.inLegacyRange).length,
      configuredIncludedCount: params.observations.filter((item) => item.inConfiguredRange).length,
      bothIncludedCount: params.observations.filter(
        (item) => item.inLegacyRange && item.inConfiguredRange
      ).length,
      legacyOnlyCount,
      configuredOnlyCount,
      idSetsMatch: legacyOnlyCount === 0 && configuredOnlyCount === 0,
    },
    mismatchKinds,
  };
}
