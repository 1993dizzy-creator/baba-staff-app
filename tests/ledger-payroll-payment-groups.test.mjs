import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildLedgerEntries,entryDisplaySubtotal} from '../lib/ledger/entries.ts';
import {entryMatchesListFilter} from '../lib/ledger/entry-list-filter.ts';
import {analyzePayrollPaymentGroups} from '../lib/ledger/payroll-payment-groups.ts';
import {payment,reversal,octoberHistory} from './helpers/payroll-payment-group-fixture.mjs';
const build=rows=>buildLedgerEntries(rows,[],new Map(),[],'2026-10');
const total=(entries,filter)=>entries.filter(e=>entryMatchesListFilter(e,filter)).reduce((a,e)=>{const s=entryDisplaySubtotal(e);a.income+=s.income;a.expense+=s.expense;return a;},{income:0,expense:0});

test('October supplied totals: 18 originals -> 3 effective groups, no additional cash/P&L subtraction',()=>{
 const rows=octoberHistory(),before=JSON.stringify(rows),entries=build(rows);
 assert.equal(rows.filter(r=>r.source_type==='payroll_payment_group').length,18);
 assert.equal(rows.filter(r=>r.source_type==='payroll_payment_group').reduce((n,r)=>n+r.amount,0),1434753636);
 assert.equal(analyzePayrollPaymentGroups(rows).reversedOriginalIds.size,15);
 assert.deepEqual(analyzePayrollPaymentGroups(rows).issues,[]);
 assert.equal(total(entries,'payroll').expense,151448409);
 assert.deepEqual(total(entries,'all'),{income:41530800,expense:158654309});
 assert.equal(total(entries,'expense').expense,158654309);
 assert.equal(entries.filter(e=>entryMatchesListFilter(e,'payroll')).length,3);
 assert.equal(entries.filter(e=>entryMatchesListFilter(e,'all')).length,5); // synthetic day's count only
 assert.equal(rows.flatMap(r=>r.movements).reduce((n,m)=>n+m.amount,0),41530800-158654309);
 assert.equal(rows.find(r=>r.source_type==='payroll_completed_batch').amount,176185794);
 assert.equal(entries.some(e=>e.transactionId===403),false);
 assert.equal(JSON.stringify(rows),before);
 // No application ID allowlist or latest-version heuristic.
 const remapped=rows.map(r=>({...r,id:r.id+10000,correction_of_id:r.correction_of_id==null?null:r.correction_of_id+10000,source_snapshot:{...r.source_snapshot,...(r.source_snapshot?.originalTransactionId?{originalTransactionId:r.source_snapshot.originalTransactionId+10000}:{})}}));
 assert.deepEqual(total(build(remapped.reverse()),'all'),total(entries,'all'));
});

test('first, repeated, distinct date/account, cancellation to zero, repay: only matched originals disappear',()=>{
 const first=payment(1,10),second=payment(2,30),third=payment(3,60),otherAccount=payment(4,7,2),otherDay=payment(5,9,1,'2026-10-11');
 const rows=[first];assert.equal(total(build(rows),'payroll').expense,10);
 rows.push(reversal(first,11),second);assert.equal(total(build(rows),'payroll').expense,30);
 rows.push(reversal(second,12),third,otherAccount,otherDay);assert.equal(total(build(rows),'payroll').expense,76);
 rows.push(reversal(third,13));assert.equal(total(build(rows),'payroll').expense,16);
 rows.push(payment(6,40));assert.equal(total(build(rows),'payroll').expense,56);
});

for(const [name,mutate,code] of [
 ['wrong amount',(o,r)=>{r.amount++;},'amount_mismatch'],
 ['wrong account',(o,r)=>{r.movements[0].fund_account.id=2;},'movement_mismatch'],
 ['wrong movement sign',(o,r)=>{r.movements[0].amount=-r.amount;},'movement_mismatch'],
 ['missing movements',(o,r)=>{r.movements=[];},'movement_mismatch'],
 ['split movement',(o,r)=>{r.movements.push({...r.movements[0],amount:0});},'movement_mismatch'],
 ['wrong group',(o,r)=>{r.source_snapshot.groupKey='other';},'group_mismatch'],
 ['wrong snapshot reference',(o,r)=>{r.source_snapshot.originalTransactionId=99;},'group_mismatch'],
 ['wrong business date',(o,r)=>{r.business_date='2026-10-11';},'group_mismatch'],
 ['missing sign',(o,r)=>{delete r.economic_effect_sign;},'invalid_original'],
 ['wrong type',(o,r)=>{r.type='expense';},'invalid_original'],
 ['unconfirmed original',o=>{o.status='pending';},'invalid_original'],
 ['wrong original source',o=>{o.source_type='manual';},'invalid_original'],
]) test(`malformed reversal: ${name} keeps original and reports ${code}`,()=>{
 const o=payment(1,50),r=reversal(o,2);mutate(o,r);
 const result=analyzePayrollPaymentGroups([o,r]);assert.equal(result.reversedOriginalIds.size,0);assert.equal(result.issues[0].code,code);
 assert.ok(build([o,r]).some(e=>e.transactionId===1));
});

test('unconfirmed reversal cannot hide a confirmed original',()=>{
 const o=payment(1,50),r={...reversal(o,2),status:'pending'};
 assert.equal(analyzePayrollPaymentGroups([o,r]).reversedOriginalIds.size,0);
 assert.equal(total(build([o,r]),'payroll').expense,50);
});
test('orphan, missing reference, duplicate cancellation and absent cancellation are diagnosed conservatively',()=>{
 const o=payment(1,50),r=reversal(o,2);
 for(const row of [r,{...r,correction_of_id:null},{...r,correction_of_id:99}])assert.equal(analyzePayrollPaymentGroups([row]).issues[0].code,'missing_original');
 const duplicate=analyzePayrollPaymentGroups([o,r,{...r,id:3}]);assert.equal(duplicate.reversedOriginalIds.size,0);assert.ok(duplicate.issues.every(i=>i.code==='duplicate_reversal'));
 const overlap=analyzePayrollPaymentGroups([o,payment(9,100)]);assert.equal(overlap.reversedOriginalIds.size,0);assert.equal(overlap.issues.length,2);
 assert.equal(total(build([o,payment(9,100)]),'payroll').expense,150);
});
test('legacy August payments on September 10/11 stay visible without group metadata',()=>{
 const rows=[payment(1,137195248,1,'2026-09-10'),payment(2,7650000,2,'2026-09-10'),payment(3,3000000,1,'2026-09-11')];
 for(const r of rows)delete r.source_snapshot;
 assert.equal(total(build(rows),'payroll').expense,147845248);
 assert.equal(analyzePayrollPaymentGroups(rows).issues.length,0);
});
test('API keeps raw transaction reporting and exposes diagnostics; page warns in both languages',()=>{
 const api=readFileSync('app/api/admin/ledger/route.ts','utf8'),page=readFileSync('app/(protected)/admin/ledger/entries/page.tsx','utf8');
 assert.match(api,/analyzePayrollPaymentGroups\(displayTransactions\)/);
 assert.match(api,/payrollPaymentGroupIssues, salesReceiptExplanation/);
 assert.match(api,/transactions: displayTransactions, entries/);
 assert.match(page,/data\.payrollPaymentGroupIssues\?\.length/);
 assert.ok(page.includes('급여 역분개 연결 확인 필요'));assert.ok(page.includes('Cần kiểm tra liên kết hoàn chi lương'));
});
