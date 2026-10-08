import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { computeDashboardFundFlows, isInvestmentCashMovement } from '../lib/ledger/dashboard-cash-report.ts';
import { businessFundMovementNet, computeActualCashOutflow } from '../lib/ledger/cash-outflow.ts';
import { buildDashboardReport } from '../lib/ledger/dashboard-report.ts';
const ids = new Set([1,2,3,5]);
const row = (id, net, extra={}) => ({ id, type:'balance_adjustment', source_type:'manual', business_date:'2026-09-10', status:'confirmed', movements:[{amount:net,fund_account:{id:1}}], ...extra });
const capital = [row(1676,-35000000,{type:'owner_settlement_payment',source_key:'owner-capital-recovery-pending:2026-09-10:mjk',source_snapshot:{settlementType:'capital_recovery'}}),
  row(1678,-35000000,{type:'owner_settlement_payment',source_key:'owner-capital-recovery:2026-09-17:han',movements:[{amount:-30000000,fund_account:{id:1}},{amount:-5000000,fund_account:{id:5}}]}),
  row(1679,-60000000,{type:'owner_settlement_payment',source_key:'owner-capital-recovery-pending:2026-09-19:cho',movements:[{amount:-60000000,fund_account:{id:3}}]}),
  row(2059,-10000000,{type:'owner_settlement_payment',source_type:'owner_investment_recovery'})];
const flow = rows => computeDashboardFundFlows(rows,ids,'2026-09');
const classified = result => result.operatingIncomeMovement-result.actualCashOutflowMovement+result.investmentCashFlow+result.otherFundAdjustment;

test('September four capital recoveries include pending and explicit recovery source, preserving every fund movement',()=>{
  const result=flow(capital);assert.equal(result.investmentCashFlow,-140000000);assert.equal(result.otherFundAdjustment,0);
  assert.equal(result.actualCashOutflowMovement,0);assert.equal(computeActualCashOutflow(capital,ids,'2026-09'),0);
  assert.equal(classified(result),capital.reduce((s,t)=>s+businessFundMovementNet(t,ids),0));
});

test('owner settlement type alone and a misleading memo never classify ordinary profit settlements as capital',()=>{
  for(const snapshot of [{settlementType:'pure_profit',recoveryPaid:0,pureProfitPaid:100},{recoveryPaid:20,pureProfitPaid:80},{}]){
    const t=row(1,-100,{type:'owner_settlement_payment',source_snapshot:snapshot,memo:'owner-capital-recovery: investment refund'});
    assert.equal(isInvestmentCashMovement(t),false);assert.equal(flow([t]).otherFundAdjustment,-100);
  }
  assert.equal(isInvestmentCashMovement(row(1,-100,{type:'owner_settlement_payment',source_snapshot:{settlementType:'capital_recovery'}})),true);
  assert.equal(isInvestmentCashMovement(row(1,-100,{type:'owner_settlement_payment',source_snapshot:{recoveryPaid:100,pureProfitPaid:0}})),true);
});

test('operating payments never duplicate in adjustments; technical reversal movements remain visible once',()=>{
  const rows=[row(1768,-3555000,{type:'expense'}),row(1969,3555000,{type:'expense',source_type:'ledger_correction',source_key:'repair:manual-1768-reversal'}),
    row(2,-5993300,{type:'expense',source_type:'inventory_purchase_rebook'}),row(3,-1122916,{source_key:'historical-payable-bridge:real'}),row(4,-41404000,{source_key:'sheet-balance-adjustment:craft-beer'}),row(5,46376.6)];
  const result=flow(rows);assert.equal(result.actualCashOutflowMovement,3555000+5993300+1122916+41404000);
  assert.equal(result.otherFundAdjustment,3601376.6);
  assert.equal(classified(result),rows.reduce((s,t)=>s+businessFundMovementNet(t,ids),0));
});

test('technical reversal/rebook groups are measured by their actual net, not discarded by labels',()=>{
  const rows=[row(1,-100,{source_type:'technical_adjustment_reversal'}),row(2,100,{source_type:'technical_adjustment_rebook'}),row(3,5,{source_type:'technical_adjustment'})];
  assert.equal(flow(rows).otherFundAdjustment,5);assert.equal(classified(flow(rows)),5);
});

test('internal transfers net zero; transfers across the holdings boundary are preserved',()=>{
  const internal=row(1,-500,{type:'transfer',movements:[{amount:-500,fund_account:{id:1}},{amount:500,fund_account:{id:2}}]});
  assert.equal(classified(flow([internal])),0);
  assert.equal(flow([row(2,-100,{type:'transfer'})]).otherFundAdjustment,-100);
});

test('card clearing is never holdings even if an erroneous caller includes its account ID',()=>{
  const rows=[row(1,999,{movements:[{amount:999,fund_account:{id:4,type:'card_clearing',code:'card_clearing'}}]})];
  assert.equal(computeDashboardFundFlows(rows,new Set([1,4]),'2026-09').otherFundAdjustment,0);
  assert.equal(businessFundMovementNet(rows[0],new Set([1,4])),0);
});

test('non-cash records, cancelled transactions and opening entries cannot inflate period flow',()=>{
  assert.equal(classified(flow([row(1,100,{movements:[]}),row(2,999,{status:'cancelled'}),row(3,500,{type:'opening'})])),0);
});

test('legacy expense KPI snapshot is preserved while actual cash payments are classified only once',()=>{
  const rows=[row(1,-100,{type:'expense',business_date:'2026-08-02'}),row(2,0,{business_date:'2026-08-31',source_key:'legacy_sheet_expense_reconciliation:2026-08',source_snapshot:{sheetCashOutflow:200,fundMovementApplied:false}}),row(3,10,{business_date:'2026-08-31',source_type:'technical_adjustment'})];
  assert.equal(computeActualCashOutflow(rows,ids,'2026-08'),200);
  const result=computeDashboardFundFlows(rows,ids,'2026-08');assert.equal(result.actualCashOutflowMovement,100);assert.equal(result.otherFundAdjustment,10);assert.equal(classified(result),-90);
});

const fixture = (month, opening, closing, received, outflow, cashReport) => ({month,summary:{income:696984269,otherIncome:5819069,expense:406979586,operatingProfit:290004683,receivedIncome:received,actualCashOutflow:outflow},
  fundsView:{mode:'closed_snapshot'},accounts:[{code:'store_cash',type:'cash',is_business_fund:true,openingBalance:opening,balance:closing}],categories:[],profitTransactions:[],cashReport:{expenseBreakdown:[],...cashReport}});

test('September opening, flows and closing reconcile; expense KPI and profit remain unchanged',()=>{
  const current=fixture('2026-09',327538240,338845642,717991032,569415006.6,{actualCashOutflowMovement:569415006.6,investmentCashFlow:-140000000,otherFundAdjustment:2731376.6,operatingIncomeMovement:717991032});
  const result=buildDashboardReport(current,current);
  assert.ok(Math.abs(result.cashFlow.reconciliationDifference)<.001);assert.equal(Math.round(result.kpis.expense),569415007);
  assert.equal(result.kpis.income,717991032);assert.equal(result.kpis.operatingProfit,290004683);assert.equal(result.kpis.cashDifference,148576025.39999998);
});

test('August non-cash sales correction remains a visible difference rather than an invented movement',()=>{
  const current=fixture('2026-08',300353642,327538240,706109063,778924465,{actualCashOutflowMovement:521514025.5,investmentCashFlow:100000000,otherFundAdjustment:-255444639.5,operatingIncomeMovement:704143263});
  const result=buildDashboardReport(current,current);assert.equal(result.kpis.expense,778924465);assert.equal(result.cashFlow.actualCashOutflow,521514025.5);
  assert.equal(result.cashFlow.reconciliationDifference,-1965800);
});

for(const month of ['2026-08','2026-09','2026-10'])test(month+' allocation excludes adjacent months and preserves movement sum',()=>{
  const rows=[row(1,-50,{type:'owner_settlement_payment',source_type:'owner_investment_recovery',business_date:month+'-15'}),row(2,500,{business_date:'2026-07-31'}),row(3,500,{business_date:'2026-11-01'})];
  assert.equal(classified(computeDashboardFundFlows(rows,ids,month)),-50);
});

test('cash-flow UI uses full amounts and explicit zero without the million abbreviation',()=>{
  const page=readFileSync('app/(protected)/admin/ledger/page.tsx','utf8');assert.ok(!page.includes('compactMoney'));
  assert.ok(page.includes('money(report.cashFlow.openingBalance)'));assert.ok(page.includes('money(report.cashFlow.closingBalance)'));
  assert.ok(page.includes('label={copy.cashFlowMatched} amount={0}'));
});
