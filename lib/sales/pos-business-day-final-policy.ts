// @ts-expect-error Direct Node TypeScript tests require explicit extensions.
import { POS_BUCKETS } from '../ledger/pos-sales-source.ts';
export type PosCloseBuckets = Record<(typeof POS_BUCKETS)[number], number>;
export type PosCloseTotals = PosCloseBuckets & { total: number };
export type PosFinalSyncRun = {
  id: number; business_date: string; source: string; status: string; source_complete: boolean | null;
  started_at: string | null; finished_at: string | null; error_message: string | null;
};
export function isEligiblePosFinalSync(run: PosFinalSyncRun | null, date: string, cutoffAt: string, now: Date) {
  if (!run || !Number.isSafeInteger(Number(run.id)) || Number(run.id)<1) return false;
  const cutoff=Date.parse(cutoffAt), started=Date.parse(run.started_at ?? ''), finished=Date.parse(run.finished_at ?? '');
  return run.business_date===date && run.source==='cukcuk' && run.status==='success'
    && run.source_complete===true && run.error_message===null
    && Number.isFinite(cutoff) && started>=cutoff && started<cutoff+86400000
    && finished>=started && finished<=now.getTime() && finished>=now.getTime()-1800000;
}
export function posSnapshotTotals(snapshot: unknown): PosCloseTotals {
  if (!snapshot || typeof snapshot!=='object') throw Error('POS_SOURCE_SNAPSHOT_INCOMPLETE');
  const source=snapshot as {receiptTotal?: unknown; totalsByBucket?: Record<string,unknown>};
  if (!Number.isSafeInteger(source.receiptTotal) || Number(source.receiptTotal)<0 || !source.totalsByBucket
    || POS_BUCKETS.some(b=>!Number.isSafeInteger(source.totalsByBucket?.[b]) || Number(source.totalsByBucket?.[b])<0)) throw Error('POS_SOURCE_SNAPSHOT_INCOMPLETE');
  const totals={total:Number(source.receiptTotal),cash:Number(source.totalsByBucket.cash),transfer:Number(source.totalsByBucket.transfer),
    card:Number(source.totalsByBucket.card),other:Number(source.totalsByBucket.other)};
  if(POS_BUCKETS.reduce((sum,b)=>sum+totals[b],0)!==totals.total) throw Error('POS_PAYMENT_BUCKET_ALLOCATION_MISMATCH');
  return totals;
}
export function comparePosFinalAmounts(closed: PosCloseTotals,current: PosCloseTotals,closedFingerprint:string,currentFingerprint:string) {
  const delta={total:current.total-closed.total,cash:current.cash-closed.cash,transfer:current.transfer-closed.transfer,
    card:current.card-closed.card,other:current.other-closed.other};
  return {result:Object.values(delta).some(n=>n!==0)?'financial_drift':closedFingerprint===currentFingerprint?'verified_unchanged':'metadata_changed_only',delta};
}
