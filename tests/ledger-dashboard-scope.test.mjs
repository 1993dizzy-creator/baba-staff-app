import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dashboardApi} from './helpers/ledger-dashboard-api-fixture.mjs';
import {dashboardTables} from './helpers/ledger-dashboard-tables.mjs';
import {buildDashboardReport} from '../lib/ledger/dashboard-report.ts';
import {buildDashboardDetailEmoji} from '../lib/ledger/dashboard-detail-emoji.ts';
import {buildProvisionalOperatingProfit} from '../lib/ledger/provisional-operating-profit.ts';
const body=async(api,month,scope='')=>{const response=await api.get(month,scope);assert.equal(response.status,200);return response.json();};

test('July cash reconstruction changes historical views only, including live November and every ledger API scope', async () => {
 const tables=dashboardTables();
 tables.ledger_fund_accounts[1].code='baba_corporate_bank';
 tables.ledger_fund_accounts.push(...[{id:4,code:'cho_personal_custody'},{id:5,code:'vuong_personal_custody'}].map(a=>({...a,type:'personal_custody',is_active:true,is_business_fund:true})));
 const snapshot=JSON.stringify(tables);
 const months=['2026-08','2026-09','2026-10','2026-11'];
 for(const closed of [true,false]) {
  const original=structuredClone(tables);
  if(!closed) original.ledger_month_closures=[];
  const withHistory=structuredClone(original);
  const beforeJuly=await body(dashboardApi(original,{businessDate:'2026-11-15'}),'2026-07','&scope=accounts');
  for(const id of [1,2,4,5]) {
   const transaction={id:9000+id,type:'expense',status:'confirmed',business_date:'2026-07-20',recognition_month:'2026-07-01',occurred_at:'2026-07-20T12:00:00+07:00',source_type:'manual',category:{id:4},amount:1_234_567,source_snapshot:{},movements:[{amount:-1_234_567,fund_account:{id}}]};
   withHistory.ledger_transactions.push(transaction);
   withHistory.ledger_movements.push({id:9000+id,fund_account_id:id,amount:-1_234_567,transaction:{type:'expense',status:'confirmed',business_date:transaction.business_date,occurred_at:transaction.occurred_at}});
  }
  for(const month of months) for(const scope of ['','&scope=accounts','&scope=dashboard']) {
   const before=await body(dashboardApi(original,{businessDate:'2026-11-15'}),month,scope);
   const after=await body(dashboardApi(withHistory,{businessDate:'2026-11-15'}),month,scope);
   assert.deepEqual(after.accounts,before.accounts,`${month} ${scope} cash impact = 0`);
   if(scope!=='&scope=accounts') {assert.deepEqual(after.summary,before.summary);assert.deepEqual(after.cashReport,before.cashReport);}
  }
  const afterJuly=await body(dashboardApi(withHistory,{businessDate:'2026-11-15'}),'2026-07','&scope=accounts');
  for(const id of [1,2,4,5]) assert.equal(afterJuly.accounts.find(a=>a.id===id).balance,beforeJuly.accounts.find(a=>a.id===id).balance-1_234_567);
  assert.equal(JSON.stringify(original),JSON.stringify({...tables,...(!closed?{ledger_month_closures:[]}: {})}));
  assert.deepEqual(withHistory.ledger_payable_allocations,original.ledger_payable_allocations);
  assert.deepEqual(withHistory.ledger_month_closures,original.ledger_month_closures);
 }
 assert.equal(JSON.stringify(tables),snapshot);
});
test('movement relation rows returned as arrays normalize to the same August opening, November opening/current balances and zero July impact', async () => {
 const tables=dashboardTables();
 tables.ledger_fund_accounts[1].code='baba_corporate_bank';
 tables.ledger_fund_accounts.push(...[{id:4,code:'cho_personal_custody'},{id:5,code:'vuong_personal_custody'}].map(a=>({...a,type:'personal_custody',is_active:true,is_business_fund:true})));
 const withHistory=structuredClone(tables);
 for(const id of [1,2,4,5]) withHistory.ledger_movements.push({id:9100+id,fund_account_id:id,amount:-1_234_567,transaction:{type:'expense',status:'confirmed',business_date:'2026-07-20',occurred_at:'2026-07-20T12:00:00+07:00'}});
 const api=(t,shape)=>dashboardApi(t,{businessDate:'2026-11-15',movementRelationShape:shape});
 for(const month of ['2026-08','2026-09','2026-10','2026-11']) for(const scope of ['','&scope=accounts']) {
  const object=await body(api(tables,'object'),month,scope);
  const array=await body(api(tables,'array'),month,scope);
  const arrayWithJuly=await body(api(withHistory,'array'),month,scope);
  assert.deepEqual(array.accounts,object.accounts,`${month} ${scope}: array relation = object relation`);
  assert.deepEqual(arrayWithJuly.accounts,object.accounts,`${month} ${scope}: July history impact = 0 with array relations`);
  if(month==='2026-08') assert.equal(array.accounts.find(a=>a.id===1).openingBalance,100000,'August opening seed kept');
  if(month==='2026-11') {
   // November has no opening row: opening = prior confirmed movements (business_date kept for the boundary).
   const october=await body(api(tables,'array'),'2026-10','&scope=accounts');
   for(const account of array.accounts) assert.equal(account.openingBalance,october.accounts.find(a=>a.id===account.id).balance,`November opening = October closing (${account.code})`);
   assert.ok(array.accounts.some(a=>a.balance!==0),'November current balances are computed');
  }
 }
 // Both read paths share the one normalization: accounts scope equals the general ledger read.
 for(const month of ['2026-08','2026-11']) assert.deepEqual((await body(api(withHistory,'array'),month,'&scope=accounts')).accounts,(await body(api(withHistory,'array'),month,'')).accounts);
});
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
 assert.equal(report.kpis.expense,21200); // payment movements, including August's legacy-snapshot month
 assert.equal(report.expenses.reduce((sum,row)=>sum+row.amount,0),report.kpis.expense);
 assert.equal(d.cashReport.actualCashOutflowMovement,report.kpis.expense);
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
