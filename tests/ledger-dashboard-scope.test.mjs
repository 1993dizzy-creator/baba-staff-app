import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dashboardApi} from './helpers/ledger-dashboard-api-fixture.mjs';
import {dashboardTables} from './helpers/ledger-dashboard-tables.mjs';
import {buildDashboardReport} from '../lib/ledger/dashboard-report.ts';
import {buildDashboardDetailEmoji} from '../lib/ledger/dashboard-detail-emoji.ts';
import {buildProvisionalOperatingProfit} from '../lib/ledger/provisional-operating-profit.ts';
const body=async(api,month,scope='')=>{const response=await api.get(month,scope);assert.equal(response.status,200);return response.json();};
for(const month of ['2026-08','2026-09','2026-10'])test(`${month}: full/dashboard report, details, cash, balances, estimates and revision 3 agree`,async()=>{
 const tables=dashboardTables(),snapshot=JSON.stringify(tables),full=dashboardApi(tables),light=dashboardApi(tables);
 const previous=`2026-${String(Number(month.slice(5))-1).padStart(2,'0')}`;
 const f=await body(full,month),p=await body(full,previous),d=await body(light,month,'&scope=dashboard'),dp=await body(light,previous,'&scope=dashboard');
 assert.deepEqual(buildDashboardReport(d,dp),buildDashboardReport(f,p));assert.deepEqual(d.cashReport,f.cashReport);assert.deepEqual(d.salesReceiptExplanation,f.salesReceiptExplanation);
 for(const key of Object.keys(d.summary))assert.equal(d.summary[key],f.summary[key],key);
 assert.equal(d.fundsView.mode,month==='2026-10'?'live':'closed_snapshot');
 for(const loading of [false,true])for(const status of ['predicted','finalized','unavailable']){
  const sources={isCurrentMonth:month==='2026-10',payroll:{month,status,amount:15000,recognizedAmount:status==='finalized'?15000:0,adjustment:status==='finalized'?0:status==='unavailable'?null:15000},payrollLoading:loading,currentCard:{monthlyCardGross:30000,monthlySettledGross:10000,monthlySettlementDifference:1000},previousCard:{actualDifferenceRate:0.02}};
  assert.deepEqual(buildProvisionalOperatingProfit({...sources,summary:d.summary}),buildProvisionalOperatingProfit({...sources,summary:f.summary}));
 }
 const report=buildDashboardReport(f,p),fd=buildDashboardDetailEmoji(f),dd=buildDashboardDetailEmoji(d);for(const row of report.income)for(const detail of row.details)assert.equal(dd(detail,'income',row.id),fd(detail,'income',row.id));
 assert.deepEqual(light.spies,{inventoryDisplay:0,inventoryIssues:0,entries:0,reserveEntries:0});
 assert.ok(!light.calls.some(c=>['ledger_candidates','ledger_parties'].includes(c.table)));
 assert.ok(!light.calls.some(c=>['paidRoots','paidCorrections','recognition'].includes(c.kind)));
 assert.ok(!light.calls.some(c=>c.columns.includes('payable:')));
 for(const key of ['entries','inventoryProjectionIssues','payrollPaymentGroupIssues','parties'])assert.ok(!(key in d),key);
 const accounts=await body(dashboardApi(tables),month,'&scope=accounts');assert.deepEqual(accounts.accounts,f.accounts);
 assert.equal(JSON.stringify(tables),snapshot);assert.ok(tables.ledger_month_closures.every(c=>c.revision===3));
});

test('dashboard profit and cash inputs paginate all 1000+ rows; a later page error fails closed',async()=>{
 const tables=dashboardTables(1001),full=dashboardApi(tables),light=dashboardApi(tables),f=await body(full,'2026-10'),d=await body(light,'2026-10','&scope=dashboard');
 assert.deepEqual(d.summary,Object.fromEntries(Object.keys(d.summary).map(k=>[k,f.summary[k]])));assert.deepEqual(d.cashReport,f.cashReport);
 assert.ok(light.calls.filter(c=>c.kind==='profit').length>=2);
 for(const failKind of ['profit','ledger_transactions','movements']) {
  const failing=dashboardApi(tables,{failKind}),response=await failing.get('2026-10','&scope=dashboard');assert.equal(response.status,500);assert.equal((await response.json()).code,'LEDGER_LOAD_FAILED');
 }
});

test('dashboard keeps authentication/month validation and default/accounts modes',async()=>{
 const denied=dashboardApi(dashboardTables(),{denied:true});assert.equal((await denied.get('2026-10','&scope=dashboard')).status,403);assert.equal(denied.calls.length,0);
 const invalid=dashboardApi(dashboardTables());assert.equal((await invalid.get('invalid','&scope=dashboard')).status,400);assert.equal(invalid.calls.length,0);
 const api=dashboardApi(dashboardTables());const full=await body(api,'2026-10');assert.ok(Array.isArray(full.entries));assert.ok('inventoryProjectionIssues'in full);assert.equal(api.spies.entries,1);
});

test('only the dashboard opts into the compact scope; existing helper formulas remain the report boundary',()=>{
 const page=readFileSync('app/(protected)/admin/ledger/page.tsx','utf8');assert.equal((page.match(/scope=dashboard/g)||[]).length,2);
 for(const page of ['app/(protected)/admin/ledger/entries/page.tsx','app/(protected)/admin/ledger/settings/page.tsx'])assert.ok(!readFileSync(page,'utf8').includes('scope=dashboard'));
});
