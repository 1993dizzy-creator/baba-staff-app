import test from 'node:test';
import assert from 'node:assert/strict';
import {dashboardApi} from './helpers/ledger-dashboard-api-fixture.mjs';
import {dashboardTables} from './helpers/ledger-dashboard-tables.mjs';
test('dashboard API separates historical cash/financial recognition/status without counting a receipt twice',async()=>{
 const tables=dashboardTables();tables.ledger_month_closures=[];
 const load=async()=>{const r=await dashboardApi(tables,{cashImportStatus:{rows:395,cashReconciled:true,economicClosed:false,economicPending:241}}).get('2026-10','&scope=dashboard');assert.equal(r.status,200);return r.json();};
 const before=await load();
 const cash={id:99001,operation_id:'00000000-0000-0000-0000-000000099001',type:'historical_cash_event',status:'confirmed',business_date:'2026-10-10',occurred_at:'2026-10-10T12:00:00+07:00',recognition_month:null,amount:7,source_type:'sheet_cash_import',source_key:'sheet-cash:one',source_snapshot:{cashOnly:true},movements:[{amount:7,fund_account:{id:1,code:'store_cash'}}]};
 tables.ledger_transactions.push(cash);tables.ledger_movements.push({id:99001,fund_account_id:1,amount:7,transaction:{status:'confirmed',type:cash.type,business_date:cash.business_date,occurred_at:cash.occurred_at}});
 const after=await load();assert.equal(after.cashReport.unclassifiedCashMovement,7);assert.equal(after.summary.income,before.summary.income);assert.equal(after.summary.receivedIncome,before.summary.receivedIncome);assert.equal(after.cashImport.economicPending,241);
 tables.ledger_transactions.push({...cash,id:99002,type:'sales',source_type:'cash_import_recognition',source_key:'cash-import-economics:one',recognition_month:'2026-10-01',category_id:1,movements:[]});
 const recognized=await load();assert.equal(recognized.summary.income,after.summary.income+7);assert.equal(recognized.summary.receivedIncome,after.summary.receivedIncome);assert.deepEqual(recognized.accounts,after.accounts);assert.equal(recognized.cashReport.unclassifiedCashMovement,7);
});
test('status RPC may be absent before structure approval; permission/data failures are not concealed',async()=>{
 const missing=dashboardApi(dashboardTables(),{cashImportError:{code:'PGRST202'}});const r=await missing.get('2026-10','&scope=dashboard');assert.equal(r.status,200);assert.equal((await r.json()).cashImport,null);
 const denied=dashboardApi(dashboardTables(),{cashImportError:{code:'42501'}});assert.equal((await denied.get('2026-10','&scope=dashboard')).status,500);
 assert.ok(missing.calls.every(c=>!c.rpc||c.readOnly));
});
