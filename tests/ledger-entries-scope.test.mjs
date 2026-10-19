import test from 'node:test';import assert from 'node:assert/strict';import{readFileSync}from'node:fs';
import{entriesApi}from'./helpers/ledger-entries-api-fixture.mjs';import{entriesTables}from'./helpers/ledger-entries-tables.mjs';
import{LEDGER_ENTRY_FILTERS,entryMatchesListFilter}from'../lib/ledger/entry-list-filter.ts';import{entryDisplaySubtotal}from'../lib/ledger/entries.ts';
const body=async(api,month,scope='')=>{const r=await api.get(month,scope);assert.equal(r.status,200);return r.json();};
function totals(entries,filter){const rows=entries.filter(e=>entryMatchesListFilter(e,filter));const days={};for(const e of rows){const d=days[e.businessDate]??={income:0,expense:0,ids:[]};const s=entryDisplaySubtotal(e);d.income+=s.income;d.expense+=s.expense;d.ids.push(e.id);}return days;}
for(const month of ['2026-08','2026-09','2026-10'])test(`${month}: entries scope preserves every display/edit/candidate field, all filters and daily totals`,async()=>{
 const tables=entriesTables(),before=JSON.stringify(tables),fullApi=entriesApi(tables),lightApi=entriesApi(tables),full=await body(fullApi,month),light=await body(lightApi,month,'&scope=entries');
 assert.equal(light.scope,'entries');for(const key of ['fundsView','summary','accounts','categories','partners','entries','inventoryProjectionIssues','payrollPaymentGroupIssues'])assert.deepEqual(light[key],full[key],key);
 for(const filter of LEDGER_ENTRY_FILTERS)assert.deepEqual(totals(light.entries,filter),totals(full.entries,filter),filter);
 assert.ok(light.entries.some(e=>e.items?.some(i=>i.candidateId)),'pending candidate fields retained');
 assert.ok(light.entries.some(e=>e.payrollPayment),'effective payroll retained');assert.ok(light.entries.some(e=>e.paymentTransaction),'payable payment retained');
 for(const key of ['transactions','profitTransactions','cashReport','salesReceiptExplanation','parties'])assert.ok(!(key in light),key);
 assert.ok(fullApi.calls.some(c=>c.table==='ledger_payable_allocations'));assert.ok(!lightApi.calls.some(c=>c.table==='ledger_payable_allocations'));
 assert.ok(!lightApi.calls.some(c=>c.table==='ledger_recurring_expense_plans'));assert.ok(!lightApi.calls.some(c=>c.table==='ledger_parties'));
 assert.equal(lightApi.spies.entries,1);assert.equal(lightApi.spies.inventoryIssues,1);assert.equal(JSON.stringify(tables),before);
});
test('malformed payroll reversal diagnosis and month-close/payable/investment status stay intact',async()=>{
 const tables=entriesTables();tables.ledger_transactions.find(t=>t.source_type==='payroll_payment_group_reversal'&&t.business_date.startsWith('2026-10')).amount++;
 const full=await body(entriesApi(tables),'2026-10'),light=await body(entriesApi(tables),'2026-10','&scope=entries');assert.ok(light.payrollPaymentGroupIssues.length);assert.deepEqual(light.entries,full.entries);assert.deepEqual(light.payrollPaymentGroupIssues,full.payrollPaymentGroupIssues);
 for(const month of ['2026-08','2026-09','2026-10']){const api=entriesApi(tables),status=await(await api.auxGet(`/api/admin/ledger/month-close?month=${month}&mode=status`)).json();assert.equal(status.state,month==='2026-10'?'open':'closed');if(status.closure)assert.equal(status.closure.revision,3);
 const payables=await(await api.auxGet(`/api/admin/ledger/payables?month=${month}`)).json();assert.ok(payables.payables.length);assert.equal(payables.summary.closingOutstanding,payables.totalOutstanding);
 const investment=await(await api.auxGet(`/api/admin/ledger/investments?month=${month}&mode=summary`)).json();assert.equal(investment.periodNetChange,1000);}
});
test('1000+ rows are complete and a failed later month-ledger page fails closed',async()=>{
 const tables=entriesTables(1001),full=await body(entriesApi(tables),'2026-10'),light=await body(entriesApi(tables),'2026-10','&scope=entries');assert.deepEqual(light.entries,full.entries);assert.deepEqual(light.summary,full.summary);assert.ok(light.entries.length>1000);
 const r=await entriesApi(tables,{failKind:'ledger_transactions'}).get('2026-10','&scope=entries');assert.equal(r.status,500);
});
test('scope retains authorization and invalid-month checks; only Entries opts in',async()=>{
 const denied=entriesApi(entriesTables(),{denied:true});assert.equal((await denied.get('2026-10','&scope=entries')).status,403);assert.equal(denied.calls.length,0);
 const api=entriesApi(entriesTables());assert.equal((await api.get('bad','&scope=entries')).status,400);assert.equal(api.calls.length,0);
 const page=readFileSync('app/(protected)/admin/ledger/entries/page.tsx','utf8');assert.ok(page.includes('month=${requestedMonth}&scope=entries'));assert.ok(!readFileSync('app/(protected)/admin/ledger/page.tsx','utf8').includes('scope=entries'));
});
