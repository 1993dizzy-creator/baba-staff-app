import test from 'node:test';
import assert from 'node:assert/strict';
import {fundOpeningBoundaries,fundMovementInScope,normalizeFundMovementRows} from '../lib/ledger/fund-account-view.ts';
import {buildDashboardReport} from '../lib/ledger/dashboard-report.ts';
import {buildLedgerEntries} from '../lib/ledger/entries.ts';
import {computeReceivedIncome} from '../lib/ledger/summary.ts';
const row=(id,date,type='transfer')=>({fund_account_id:id,amount:1,transaction:{business_date:date,type}});
test('monthly boundaries are per fund; earlier months do not add to July or August opening a second time',()=>{
 const movements=[row(1,'2026-01-01','opening'),row(1,'2026-06-30'),row(1,'2026-07-01','opening'),row(1,'2026-07-31'),row(1,'2026-08-01','opening'),row(5,'2026-01-01','opening'),row(5,'2026-06-30'),row(4,'2026-01-01','opening')];
 const july=fundOpeningBoundaries(movements,'2026-07');assert.equal(july.get(1),'2026-07-01');assert.equal(july.get(5),'2026-01-01');
 assert.equal(fundMovementInScope('store_cash','2026-06-30','2026-07',july.get(1)),false);
 assert.equal(fundMovementInScope('vuong_personal_custody','2026-06-30','2026-07',july.get(5)),true);
 const august=fundOpeningBoundaries(movements,'2026-08');assert.equal(fundMovementInScope('store_cash','2026-07-31','2026-08',august.get(1)),false);
 assert.equal(fundMovementInScope('card_clearing','2026-01-01','2026-08','2026-08-01'),true);
 for(let n=1;n<=6;n++){const month=`2026-0${n}`;assert.equal(fundOpeningBoundaries(movements,month).get(1),'2026-01-01');}
 assert.deepEqual(normalizeFundMovementRows([{fund_account_id:1,amount:1,transaction:[{business_date:'2026-07-01',type:'opening'}]}]),[row(1,'2026-07-01','opening')]);
});
test('unclassified cash has its own waterfall and entry label, never profit or a balance adjustment',()=>{
 const base={month:'2026-07',fundsView:{mode:'provisional'},summary:{income:0,expense:0,operatingProfit:0,receivedIncome:0,actualCashOutflow:0,otherIncome:0},accounts:[{code:'store_cash',type:'cash',is_business_fund:true,balance:10,openingBalance:10}],categories:[],profitTransactions:[],cashReport:{expenseBreakdown:[],investmentCashFlow:0,otherFundAdjustment:0,operatingIncomeMovement:0}};
 const report=buildDashboardReport({...base,accounts:[{...base.accounts[0],balance:17}],cashReport:{...base.cashReport,unclassifiedCashMovement:7},cashImport:{rows:395,cashReconciled:true,economicClosed:false,economicPending:241}},base);
 assert.equal(report.cashFlow.unclassifiedCashMovement,7);assert.equal(report.cashFlow.reconciliationDifference,0);assert.equal(report.kpis.operatingProfit,0);assert.equal(report.cashImport.economicClosed,false);
 const [entry]=buildLedgerEntries([{id:1,type:'historical_cash_event',status:'confirmed',business_date:'2026-07-01',occurred_at:'2026-07-01T12:00:00+07',amount:7,source_type:'sheet_cash_import',source_key:'sheet-cash:one',source_snapshot:{cashOnly:true},category:null,party:null,movements:[{amount:7,fund_account:{id:1,code:'store_cash',display_name:'Cash'}}]}],[],new Map());
 assert.equal(entry.title,'과거 자금 기록');assert.match(entry.subtitle,/분류 대기/);assert.equal(entry.participatesInProfit,false);assert.equal(entry.isSystemAdjustment,false);
 assert.equal(computeReceivedIncome(8907800,0,0,8907800),0); // Follow-up noncash sales never add the same receipt twice.
});
