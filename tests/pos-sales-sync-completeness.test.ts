import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
// @ts-expect-error Direct Node tests require explicit extensions.
import { isSalesSyncSourceComplete, syncRunCompletionEvidence } from '../lib/pos/cukcuk/sales-sync-completeness.ts';
const complete={status:'success' as const,limitReached:false,skippedDetailCount:0,
  paymentSnapshotUnavailableCount:0,receiptPaymentSourceComplete:true,partial:false,errorMessage:null};
test('normal fully saved and reconciled source completes true with null error',()=>{
  assert.equal(isSalesSyncSourceComplete(complete),true);
  assert.deepEqual(syncRunCompletionEvidence('success',true),{source_complete:true,error_message:null});
});
for(const [name,change] of Object.entries({limit:{limitReached:true},detailSkip:{skippedDetailCount:1},
  paymentUnavailable:{paymentSnapshotUnavailableCount:1},partial:{partial:true},unknownSource:{receiptPaymentSourceComplete:false},
  failed:{status:'failed' as const},error:{errorMessage:'DETAIL_SKIPPED'}}))test(name+' cannot complete source',()=>{
  assert.equal(isSalesSyncSourceComplete({...complete,...change}),false);
});
test('failed, unproven and error-bearing completions cannot store true',()=>{
  assert.equal(syncRunCompletionEvidence('failed',true).source_complete,false);
  assert.equal(syncRunCompletionEvidence('success',undefined).source_complete,false);
  assert.equal(syncRunCompletionEvidence('success',true,'warning').source_complete,false);
  assert.equal(syncRunCompletionEvidence('success',true,'').source_complete,false);
});
test('route uses explicit raw response limit evidence and enforces completion writes',()=>{
  const route=readFileSync('app/api/pos/cukcuk/sainvoices/sync-to-sales/route.ts','utf8');
  assert.match(route,/const limitReached = invoices\.length >= limit/);
  assert.match(route,/sourceComplete: isSalesSyncSourceComplete\(/);
  assert.match(route,/await loadPosBusinessDaySource\(businessDate\)/);
  assert.match(route,/syncRunCompletionEvidence\(params.status, params.sourceComplete, params.errorMessage\)/);
  assert.match(route,/status: "failed",\s+source_complete: false/);
});
