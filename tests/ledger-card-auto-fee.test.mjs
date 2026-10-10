import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {planCardDepositWithFees,CARD_FEE_TARGET_RATE,CARD_FEE_AUTO_CLOSE_MIN_RATE,CARD_FEE_AUTO_CLOSE_MAX_RATE} from '../lib/ledger/card-fee-policy.ts';
import {cardFeeRowsAsAllocationLines,calculateCardGrossAtMonthEnd} from '../lib/ledger/card-settlements.ts';
import {normalizePostCloseCardFeeSnapshot} from '../lib/ledger/post-close-card-fee.ts';
import {buildProvisionalOperatingProfit} from '../lib/ledger/provisional-operating-profit.ts';
const sales=(remaining,current=10000000)=>[{id:1,business_date:'2026-08-20',outstandingGrossAmount:remaining},{id:2,business_date:'2026-09-02',outstandingGrossAmount:current}];
const feeMonths=remaining=>[{month:'2026-08',gross:100000000,outstanding:remaining}];
for(const [remaining,deposit,fee,allocations] of [[5000000,2850000,2150000,[2850000]],[5000000,2600000,2400000,[2600000]],[5000000,1500000,0,[1500000]],[3000000,4000000,2150000,[850000,3150000]],[2400000,1000000,2400000,[1000000]]])test(`preview fee ${fee} for remaining ${remaining}, deposit ${deposit}`,()=>{
 const plan=planCardDepositWithFees(sales(remaining),deposit,'2026-09-05',feeMonths(remaining));assert.equal(plan.error,null);assert.equal(plan.fees[0]?.amount??0,fee);assert.deepEqual(plan.rows.map(row=>row.allocatedAmount),allocations);assert.equal(plan.totalAllocated,deposit);
});
test('preview current month, review, rounding and capacity use exact deposit invariant',()=>{
 assert.equal(planCardDepositWithFees(sales(1000000),500000,'2026-09-05',feeMonths(1000000)).error,'review_required');
 assert.equal(planCardDepositWithFees(sales(3000000,0),2000000,'2026-09-05',feeMonths(3000000)).error,'exceeds_outstanding');
 assert.equal(planCardDepositWithFees(sales(5000000),2850000,'2026-08-25',feeMonths(5000000)).fees.length,0);
 const plan=planCardDepositWithFees([{id:1,business_date:'2026-08-20',outstandingGrossAmount:0.3},{id:2,business_date:'2026-09-01',outstandingGrossAmount:1}],0.5,'2026-09-05',[{month:'2026-08',gross:10,outstanding:0.3}]);assert.equal(plan.totalAllocated,0.5);assert.equal(plan.fees[0].amount,0.215);
 for(const amount of [0,-1,NaN,Infinity,0.0001])assert.equal(planCardDepositWithFees(sales(5000000),amount,'2026-09-05',[]).error,'invalid_amount');
});
test('SQL and shared preview policy rates are identical',()=>{
 const text=readFileSync('supabase/migrations/20261001193526_auto_finalize_closed_month_card_fees.sql','utf8');const policy=JSON.parse(text.match(/select '(\{"targetRate"[^']+)'::jsonb/)[1]);assert.deepEqual(policy,{targetRate:CARD_FEE_TARGET_RATE,minRate:CARD_FEE_AUTO_CLOSE_MIN_RATE,maxRate:CARD_FEE_AUTO_CLOSE_MAX_RATE});
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
