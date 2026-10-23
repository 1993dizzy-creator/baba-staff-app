import { createHash } from 'node:crypto';
// @ts-expect-error Direct Node TypeScript tests require explicit extensions.
import { POS_BUCKETS,canonicalPosJson,posSourceFingerprint } from '../ledger/pos-sales-source.ts';
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
type PosJsonObject=Record<string,unknown>;
const sameKeys=(value:unknown,keys:string[]):value is PosJsonObject=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value)
  &&Object.keys(value as object).sort().join()===[...keys].sort().join();
const omit=(value:PosJsonObject,key:string)=>Object.fromEntries(Object.entries(value).filter(([name])=>name!==key));
const SNAPSHOT_KEYS=['schemaVersion','businessDate','receiptCount','receiptTotal','paymentTotal','totalsByBucket','receipts','payments','rows'];
const RECEIPT_KEYS=['receiptId','refNo','refDate','finalAmount','revision','updatedAt'];
// Explicit order of the original August bucket snapshot (bucket_fingerprint in SQL).
const BUCKET_PAYMENT_KEYS=['paymentId','receiptId','refNo','refDate','paymentMethod','paymentAmount','receiptFinalAmount','receiptRevision','receiptUpdatedAt'];
/** Removes only receipt updated_at copies and the bucket hashes derived from them; null when the shape is not verifiable. */
function withoutReceiptUpdatedAt(snapshot:unknown){
  if(!sameKeys(snapshot,SNAPSHOT_KEYS)||!Array.isArray(snapshot.receipts)||!Array.isArray(snapshot.rows)
    ||snapshot.rows.length!==POS_BUCKETS.length)return null;
  const updatedAt=new Map<unknown,unknown>();
  for(const receipt of snapshot.receipts as unknown[]){
    if(!sameKeys(receipt,RECEIPT_KEYS)||updatedAt.has(receipt.receiptId)
      ||(receipt.updatedAt!==null&&typeof receipt.updatedAt!=='string'))return null;
    updatedAt.set(receipt.receiptId,receipt.updatedAt);
  }
  const rows:PosJsonObject[]=[];
  for(const [index,row] of (snapshot.rows as unknown[]).entries()){
    if(!sameKeys(row,['businessDate','bucket','amount','fingerprint','snapshot'])||row.bucket!==POS_BUCKETS[index])return null;
    const bucket=row.snapshot;
    if(!sameKeys(bucket,['businessDate','bucket','receiptCount','payments'])||!Array.isArray(bucket.payments))return null;
    const payments=bucket.payments as unknown[];
    if(!payments.every(payment=>sameKeys(payment,BUCKET_PAYMENT_KEYS)&&updatedAt.has(payment.receiptId)
      &&payment.receiptUpdatedAt===updatedAt.get(payment.receiptId)))return null;
    const details=payments as PosJsonObject[];
    const bucketJson=JSON.stringify({businessDate:bucket.businessDate,bucket:bucket.bucket,receiptCount:bucket.receiptCount,
      payments:details.map(payment=>Object.fromEntries(BUCKET_PAYMENT_KEYS.map(key=>[key,payment[key]])))});
    if(row.fingerprint!==createHash('sha256').update(bucketJson).digest('hex'))return null;
    rows.push({...omit(row,'fingerprint'),snapshot:{...bucket,payments:details.map(payment=>omit(payment,'receiptUpdatedAt'))}});
  }
  return {...snapshot,receipts:(snapshot.receipts as PosJsonObject[]).map(receipt=>omit(receipt,'updatedAt')),rows};
}
/**
 * True only when a closed day and the current POS source differ solely in receipt
 * updated_at (e.g. an inventory deduction check touching the row). Receipts, payments,
 * buckets, revisions and every other snapshot field must be identical and both
 * snapshots must reproduce their stored fingerprints; anything else stays drift.
 */
export function isPosTimestampOnlyDrift(closedSnapshot:unknown,closedFingerprint:string|null,current:{sourceSnapshot:unknown;sourceFingerprint:string}){
  if(!closedFingerprint||closedFingerprint===current.sourceFingerprint)return false;
  try{
    if(posSourceFingerprint(closedSnapshot)!==closedFingerprint||posSourceFingerprint(current.sourceSnapshot)!==current.sourceFingerprint)return false;
    const closed=withoutReceiptUpdatedAt(closedSnapshot),now=withoutReceiptUpdatedAt(current.sourceSnapshot);
    return closed!==null&&now!==null&&canonicalPosJson(closed)===canonicalPosJson(now);
  }catch{return false;}
}
