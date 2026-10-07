// @ts-expect-error Direct Node TypeScript tests require explicit extensions.
import { addStoreDays, isStoreDateKey } from "../store-settings/business-time-core.ts";
import type { PosCloseTotals,PosCloseBuckets } from './pos-business-day-final-policy';
export type PosCloseView={
 businessDate:string;currentTotals:PosCloseTotals|null;currentFingerprint:string|null;sourceValid:boolean;
 latestClose:{id:number;revision:number;method:string;closedAt:string;closedBy:string;totals:PosCloseTotals;fingerprint:string}|null;
 latestFinalCheck:{id:number;result:'verified_unchanged'|'metadata_changed_only'|'financial_drift'|'sync_failed'|'source_invalid'|'month_closed';checkedAt:string;closedTotal:number|null;currentTotal:number|null;totalDelta:number|null;
   closedBuckets:PosCloseBuckets|null;currentBuckets:PosCloseBuckets|null;bucketDelta:PosCloseBuckets|null}|null;
 drift:boolean;delta:PosCloseTotals|null;canClose:boolean;canReclose:boolean;needsOwnerReview:boolean;monthClosed:boolean;
 finalCheckPending:boolean;
 closeEligibilityReason:string;closeAt:string|null;
 finalSync:{runId:number|null;lastSyncedAt:string|null;cutoffAt:string;eligible:boolean};
 ledgerProjection:{status:string;total:number};
};

/** Read-only display policy; does not schedule or execute a final check. */
export function isPosFinalCheckPending({ businessDate, latestClose, hasFinalCheck, now }: {
  businessDate: string;
  latestClose: { method: string; closedAt: string } | null;
  hasFinalCheck: boolean;
  now: Date;
}): boolean {
  if (!latestClose || latestClose.method !== "manual" || hasFinalCheck || !isStoreDateKey(businessDate)) return false;
  // vercel.json: sales-close-final runs at 20:05 UTC = 03:05 (+07).
  // The store's closeAt and configurable cutoffAt are not this cron schedule.
  const scheduledAt = Date.parse(addStoreDays(businessDate, 1) + "T03:05:00+07:00");
  const closedAt = Date.parse(latestClose.closedAt);
  const currentTime = now.getTime();
  return closedAt <= currentTime && closedAt < scheduledAt && currentTime < scheduledAt;
}
