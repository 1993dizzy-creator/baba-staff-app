import assert from 'node:assert/strict';
import test from 'node:test';
import {assessCukcukShadowSource,assessShadowRecovery,hasExplicitEventTime,type RecoveryManifest,type RecoveryScan} from '../lib/pos/cukcuk/shadow-source-contract.ts';
const hash='a'.repeat(64);
const scan=(refs:string[]):RecoveryScan=>({total:refs.length,pages:Array.from({length:Math.max(1,Math.ceil(refs.length/100))},(_,i)=>({page:i+1,limit:100,refs:refs.slice(i*100,(i+1)*100)})),details:refs.map(refId=>({refId,ok:true,semanticHash:hash}))});
const manifest=(refs:string[]):RecoveryManifest=>({scope:{branchId:'synthetic-branch',from:'2026-10-08T00:00:00+07:00',toExclusive:'2026-10-13T00:00:00+07:00'},first:scan(refs),verification:scan(refs),localRefs:refs});
test('CUKCUK documented identity/status/time do not prove source ordering or physical return',()=>{
 for(const status of [3,4,5]){
  const r=assessCukcukShadowSource({RefID:'synthetic-ref',BranchID:'synthetic-branch',RefDate:'2026-10-09T20:01:00+07:00',PaymentStatus:status,CancelDate:'2026-10-12T10:00:00+07:00',ModifiedDate:'2026-10-12T10:00:00+07:00',EditVersion:999},'2026-10-12T12:00:00Z');
  assert.equal(r.status,'BLOCKED');assert.equal(r.providerSequenceVerified,false);assert.equal(r.automaticConfirmation,false);
  assert.equal(r.fields.revisionCandidate,999);assert.equal(r.cancellationProvesPhysicalReturn,false);
 }
});
test('timezone-free and invalid calendar times are held; collection time is separate',()=>{
 assert.equal(hasExplicitEventTime('2026-10-09T20:01:00'),false);
 assert.equal(hasExplicitEventTime('2026-02-31T20:01:00+07:00'),false);
 assert.equal(hasExplicitEventTime('2026-10-09T20:01:00.123456+07:00'),true);
 const r=assessCukcukShadowSource({RefId:'r',BranchId:'b',RefDate:'2026-10-09T20:01:00'},'2026-10-12T12:00:00Z');
 assert.ok(r.reasons.includes('invoice_time_offset_unknown'));assert.equal(r.fields.collectedAt,'2026-10-12T12:00:00Z');
});
test('two consistent counted scans reconcile 150 identities but cannot certify a provider snapshot',()=>{
 const m=manifest(Array.from({length:150},(_,i)=>'synthetic-'+i)),original=JSON.stringify(m),r=assessShadowRecovery(m);
 assert.equal(r.enumerationStatus,'PASS');assert.equal(r.transitionStatus,'BLOCKED');assert.equal(r.automaticConfirmation,false);
 assert.equal(r.recovery.advanceWatermark,false);assert.equal(r.recovery.deleteLocalRows,false);assert.equal(r.recovery.mutateInventory,false);
 assert.deepEqual(assessShadowRecovery(m),r);assert.equal(JSON.stringify(m),original);
});
test('outage replay detects missing five historical receipts including Glenfiddich without deleting extras',()=>{
 const m=manifest(['2601006796-synthetic','risk-2','risk-3','risk-4','risk-5']);m.localRefs=['local-only'];
 const r=assessShadowRecovery(m);assert.equal(r.enumerationStatus,'BLOCKED');assert.equal(r.missingLocally.length,5);
 assert.deepEqual(r.locallyOnly,['local-only']);assert.equal(r.recovery.refetchDetailIds.length,6);assert.equal(r.recovery.replayClosedWindow,true);
});
test('truncation, duplicate pages, absent/wrong detail and equal-count identity replacement are held',()=>{
 const base=manifest(Array.from({length:101},(_,i)=>'r'+i));
 for(const mutate of [
  (m:RecoveryManifest)=>{m.first.pages.pop();},
  (m:RecoveryManifest)=>{m.first.pages[1].refs=['r0'];},
  (m:RecoveryManifest)=>{m.first.details.pop();},
  (m:RecoveryManifest)=>{m.first.details[0].refId='wrong-ref';},
  (m:RecoveryManifest)=>{m.verification=scan([...m.localRefs.slice(1),'replacement']);},
  (m:RecoveryManifest)=>{m.verification.details[0].semanticHash='b'.repeat(64);},
 ]){const m=structuredClone(base);mutate(m);assert.equal(assessShadowRecovery(m).enumerationStatus,'BLOCKED');}
});
