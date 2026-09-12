import type { PosCloseTotals,PosCloseBuckets } from './pos-business-day-final-policy';
export type PosCloseView={
 businessDate:string;currentTotals:PosCloseTotals|null;currentFingerprint:string|null;sourceValid:boolean;
 latestClose:{id:number;revision:number;method:string;closedAt:string;closedBy:string;totals:PosCloseTotals;fingerprint:string}|null;
 latestFinalCheck:{id:number;result:'verified_unchanged'|'metadata_changed_only'|'financial_drift'|'sync_failed'|'source_invalid'|'month_closed';checkedAt:string;closedTotal:number|null;currentTotal:number|null;totalDelta:number|null;
   closedBuckets:PosCloseBuckets|null;currentBuckets:PosCloseBuckets|null;bucketDelta:PosCloseBuckets|null}|null;
 drift:boolean;delta:PosCloseTotals|null;canClose:boolean;canReclose:boolean;needsOwnerReview:boolean;monthClosed:boolean;
 closeEligibilityReason:string;closeAt:string|null;
 finalSync:{runId:number|null;lastSyncedAt:string|null;cutoffAt:string;eligible:boolean};
 ledgerProjection:{status:string;total:number};
};
