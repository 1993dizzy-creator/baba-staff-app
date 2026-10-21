import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error Node direct TS tests need explicit extensions.
import {pendingResolutionEligibility,validResolutionPayments,duplicateLineGroups} from '../lib/sales/pending-resolution-policy.ts';
// @ts-expect-error Node direct TS tests need explicit extensions.
import {pendingResolutionCases} from './fixtures/pos-pending-resolution-cases.ts';
const now=Date.parse('2026-10-21T07:30:00Z');
const row={source:'cukcuk',payment_status:1,is_canceled:false,ref_date:'2026-10-21T14:00:00+07:00',created_at:'2026-10-21T07:05:00Z'};
test('29:59 and exactly 30:00 use UTC instants',()=>{
 assert.equal(pendingResolutionEligibility(row,now-1000).eligible,false);
 assert.equal(pendingResolutionEligibility(row,now).eligible,true);
 for(const patch of [{payment_status:3},{source:'manual'},{is_canceled:true}])assert.equal(pendingResolutionEligibility({...row,...patch},now).eligible,false);
});
test('null invalid future and timezone-free ref date fall back to created_at',()=>{
 for(const ref_date of [null,'invalid','2026-10-21T07:00:00','2026-10-21T08:00:00Z']){
  const value=pendingResolutionEligibility({...row,ref_date},now);
  assert.equal(value.eligible,false);assert.equal(value.eligibleAt,'2026-10-21T07:35:00.000Z');assert.equal(value.basis,'created_at');
  assert.equal(pendingResolutionEligibility({...row,ref_date,created_at:null},now).eligible,false);
 }
});
test('positive integer VND and exact distinct-method sum required',()=>{
 assert.equal(validResolutionPayments(100,[{method:'cash',amount:60},{method:'card',amount:40}]),true);
 for(const amount of [0,-1,1.5,'100',null])assert.equal(validResolutionPayments(amount,[{method:'cash',amount:100}]),false);
 assert.equal(validResolutionPayments(100,[{method:'cash',amount:99}]),false);
 assert.equal(validResolutionPayments(100,[{method:'cash',amount:50},{method:'cash',amount:50}]),false);
});
test('incident duplicate warnings ignore modification history and never delete lines',()=>{
 for(const fixture of pendingResolutionCases){
  const lines=Array.from({length:fixture.duplicate?2:1},(_,id)=>({id,item_code:'TEST',quantity:1,unit_price:fixture.amount}));
  const before=JSON.stringify(lines);assert.equal(duplicateLineGroups(lines).length,fixture.duplicate?1:0,fixture.refNo);assert.equal(JSON.stringify(lines),before);
 }
});
