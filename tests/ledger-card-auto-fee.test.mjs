import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {planCardDepositWithFees} from '../lib/ledger/card-fee-policy.ts';
import {cardFeeRowsAsAllocationLines,calculateCardGrossAtMonthEnd} from '../lib/ledger/card-settlements.ts';
import {normalizePostCloseCardFeeSnapshot} from '../lib/ledger/post-close-card-fee.ts';
import {buildProvisionalOperatingProfit} from '../lib/ledger/provisional-operating-profit.ts';
const sales=(remaining,current=10000000)=>[{id:1,business_date:'2026-08-20',outstandingGrossAmount:remaining},{id:2,business_date:'2026-09-02',outstandingGrossAmount:current}];
const feeMonths=remaining=>[{month:'2026-08',gross:100000000,outstanding:remaining}];
// Actual-deposit policy: a deposit pays real principal oldest-first and never plans a fee, whatever the remaining rate.
for(const [remaining,deposit,allocations] of [[5000000,2850000,[2850000]],[5000000,1500000,[1500000]],[3000000,4000000,[3000000,1000000]],[1000000,500000,[500000]],[2400000,1000000,[1000000]]])test(`preview pays FIFO principal only for remaining ${remaining}, deposit ${deposit}`,()=>{
 const plan=planCardDepositWithFees(sales(remaining),deposit,'2026-09-05',feeMonths(remaining));assert.equal(plan.error,null);assert.deepEqual(plan.fees,[]);assert.deepEqual(plan.rows.map(row=>row.allocatedAmount),allocations);assert.equal(plan.totalAllocated,deposit);
});
test('preview provisional, review, rounding and capacity use exact deposit invariant',()=>{
 // A provisional manual fee covering the remainder is never repaid; ambiguous provisional data needs review.
 const provisional=planCardDepositWithFees(sales(3000000),5000000,'2026-09-05',[{...feeMonths(3000000)[0],provisionalFee:3000000}]);assert.deepEqual(provisional.rows.map(row=>[row.transactionId,row.allocatedAmount]),[[2,5000000]]);assert.deepEqual(provisional.fees,[]);
 assert.equal(planCardDepositWithFees(sales(3000000),500000,'2026-09-05',[{...feeMonths(3000000)[0],provisionalFee:3000000,reviewRequired:true}]).error,'review_required');
 assert.equal(planCardDepositWithFees(sales(3000000),500000,'2026-09-05',[{...feeMonths(3000000)[0],provisionalFee:4000000}]).error,'review_required');
 // Legacy review alone no longer blocks a plain FIFO deposit (no fee is guessed any more).
 assert.equal(planCardDepositWithFees(sales(1000000),500000,'2026-09-05',[{...feeMonths(1000000)[0],reviewRequired:true}]).error,null);
 assert.equal(planCardDepositWithFees(sales(3000000,0),4000000,'2026-09-05',feeMonths(3000000)).error,'exceeds_outstanding');
 const plan=planCardDepositWithFees([{id:1,business_date:'2026-08-20',outstandingGrossAmount:0.3},{id:2,business_date:'2026-09-01',outstandingGrossAmount:1}],0.5,'2026-09-05',[{month:'2026-08',gross:10,outstanding:0.3}]);assert.equal(plan.totalAllocated,0.5);assert.deepEqual(plan.rows.map(row=>row.allocatedAmount),[0.3,0.2]);assert.deepEqual(plan.fees,[]);
 for(const amount of [0,-1,NaN,Infinity,0.0001])assert.equal(planCardDepositWithFees(sales(5000000),amount,'2026-09-05',[]).error,'invalid_amount');
});
test('the rate policy is removed from the settlement migration and the deposit RPC',()=>{
 const text=readFileSync('supabase/migrations/20261108100000_card_fee_actual_deposit_settlement.sql','utf8');
 assert.match(text,/drop function ledger_card_fee_private\.policy\(\);/);
 const deposit=text.slice(text.indexOf('create or replace function public.ledger_create_card_deposit_auto_allocate_v1'),text.indexOf('-- 2. Post-close finalizer'));
 assert.doesNotMatch(deposit,/minRate|maxRate|targetRate|finalize_month|v_total_fee/);
});
test('actual auto fee date consumes operational gross without rewriting previous month-end gross',()=>{
 const feeLines=cardFeeRowsAsAllocationLines([{id:1,closure_id:1,pos_card_transaction_id:1,allocated_fee_amount:2150000,closure:{status:'confirmed',fee_month:'2026-08-01',finalization_business_date:'2026-09-05'}}]);
 assert.equal(feeLines[0].reconciliation.deposit_date,'2026-09-05');
 const lines=[{reconciliation_id:2,pos_card_transaction_id:1,allocated_gross_amount:97000000,reconciliation:{status:'auto_allocated',deposit_date:'2026-08-25'}},...feeLines];
 const gross=calculateCardGrossAtMonthEnd([{id:1,business_date:'2026-08-20',amount:100000000}],lines,'2026-08-01','2026-09-01');assert.equal(gross.monthlyUnreconciledGross,3000000);
});
test('expected fee finalization is excluded from snapshot drift, but real holdings drift is retained',()=>{
 const stored={funds:{bank:97000000,clearing:3000000},expense:{total:100,byCategory:{Other:100}},operatingResult:{expense:100,operatingProfit:1000},card:{feeStatus:'pending',feeClosure:null,finalConfirmedFee:0}};
 const current=structuredClone(stored);current.expense.total+=2150000;current.expense.byCategory['\uce74\ub4dc \uc815\uc0b0 \ucc28\uc561']=2150000;current.operatingResult.expense+=2150000;current.operatingResult.operatingProfit-=2150000;current.card={feeStatus:'confirmed',feeClosure:{autoConfirmed:true,feeAmount:2150000},finalConfirmedFee:2150000};
 assert.deepEqual(normalizePostCloseCardFeeSnapshot(current,stored),stored);assert.equal(stored.card.feeClosure,null);assert.equal(current.card.feeStatus,'confirmed');
 current.funds.bank+=1;assert.notDeepEqual(normalizePostCloseCardFeeSnapshot(current,stored),stored);
});
test('historical fee-pending P&L remains provisional and becomes final after recognition',()=>{
 const args={isCurrentMonth:false,summary:{income:100000000,expense:0,operatingProfit:100000000,cardFeePending:true},payroll:null,currentCard:null,previousCard:null};
 assert.equal(buildProvisionalOperatingProfit(args).mode,'provisional');const final=buildProvisionalOperatingProfit({...args,summary:{income:100000000,expense:2150000,operatingProfit:97850000,cardFeePending:false}});assert.equal(final.mode,'final');assert.equal(final.operatingProfit,97850000);
});
