import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {calculateReceiptFinancials} from '../lib/sales/receipt-financials.ts';
import {splitReceiptPayment} from '../lib/sales/receipt-split-payment.ts';
import {buildPaymentSummary,findPaymentReconciliationMismatches} from '../lib/sales/payment-summary.ts';

const route=readFileSync('app/api/admin/sales/receipts/[id]/route.ts','utf8');
const page=readFileSync('app/(protected)/admin/sales/receipts/page.tsx','utf8');
const today=readFileSync('app/api/admin/sales/today/route.ts','utf8');
const monthly=readFileSync('app/api/admin/sales/monthly/route.ts','utf8');

test('split uses the final override amount, leaving the manual adjustment separate',()=>{
 const financials=calculateReceiptFinancials({lines:[{finalAmount:5137000,taxRate:0}],taxMode:'apply',originalTaxAmount:0,finalAmountOverride:5130000});
 assert.equal(financials.calculatedFinalAmount,5137000);
 assert.equal(financials.manualAdjustmentAmount,-7000);
 assert.deepEqual(splitReceiptPayment(financials.finalAmount,5000000),{cashAmount:5000000,otherAmount:130000,paymentTotal:5130000});
 assert.equal(splitReceiptPayment(financials.calculatedFinalAmount,5000000)?.otherAmount,137000);
 assert.ok(route.indexOf('const finalAmount = financials.finalAmount')<route.indexOf('splitReceiptPayment(finalAmount, body.splitCashAmount)'));
});

test('split only accepts two positive integer portions',()=>{
 assert.deepEqual(splitReceiptPayment(165000,100000),{cashAmount:100000,otherAmount:65000,paymentTotal:165000});
 for(const value of [null,'',0,-1,165000,165001,1.5,NaN,Infinity])assert.equal(splitReceiptPayment(165000,value),null);
});

test('payment rows feed separate cash and other buckets without double counting',()=>{
 const rows=[{receipt_id:1,business_date:'2026-09-28',payment_type:null,payment_name:'Ti\u1ec1n m\u1eb7t',card_name:null,amount:100000},{receipt_id:1,business_date:'2026-09-28',payment_type:null,payment_name:'Kh\u00e1c',card_name:null,amount:65000}];
 assert.deepEqual(buildPaymentSummary(rows),{cashAmount:100000,transferAmount:0,cardAmount:0,otherAmount:65000,paymentTotalAmount:165000});
 assert.deepEqual(findPaymentReconciliationMismatches([{id:1,payment_status:3,is_canceled:false,final_amount:165000}],rows),[]);
 assert.match(today,/paymentSummary: buildPaymentSummary\(paidPaymentRows\)/);
 assert.match(monthly,/paymentSummary: buildPaymentSummary\(filterPaidPayments\(receiptRows, paymentRows\)\)/);
});

test('edit UI and API carry split cash while keeping cash change and revision flows',()=>{
 assert.match(page,/splitCashAmount: paymentMethod === "split" \? splitCashAmount : null/);
 assert.match(page,/splitReceiptPayment\(draftPaymentTotal, splitCashAmount\)/);
 assert.match(page,/getPaymentSummaryText\(receipt.payments, text\)/);
 assert.match(page,/payments.map\(\(payment\) => \(/);
 assert.match(route,/p_split_cash_amount: split\?\.cashAmount \?\? null/);
 assert.match(route,/p_expected_revision: expectedRevision/);
 assert.match(route,/receipt_revision_conflict/);
});
