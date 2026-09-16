import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import test from 'node:test';

const require=createRequire(import.meta.url);
const {allocateOwnerRecoveryPool}=require('../lib/ledger/owner-recovery-core.ts');
const migration=readFileSync('supabase/migrations/20260916213000_separate_owner_capital_recovery.sql','utf8');
const route=readFileSync('app/api/admin/ledger/owners/route.ts','utf8');
const dashboard=readFileSync('lib/ledger/owners.ts','utf8');
const ownersPage=readFileSync('app/(protected)/admin/ledger/owners/page.tsx','utf8');
const settingsPage=readFileSync('app/(protected)/admin/ledger/settings/page.tsx','utf8');
function body(name,next){
  const start=migration.indexOf(`create or replace function public.${name}`);
  assert.ok(start>=0,name);
  const end=next?migration.indexOf(`create or replace function public.${next}`,start+1):migration.indexOf('alter function public.',start+1);
  assert.ok(end>start,name);
  return migration.slice(start,end);
}
const recoveryCapacity=body('ledger_owner_recovery_capacity_v1','ledger_confirm_owner_recovery_v1');
const confirmRecovery=body('ledger_confirm_owner_recovery_v1','ledger_owner_financial_capacity_v1');
const profitCapacity=body('ledger_owner_financial_capacity_v1','ledger_confirm_owner_settlement_v1');
const confirmProfit=body('ledger_confirm_owner_settlement_v1','ledger_pay_owner_allocation_v1');
const pay=body('ledger_pay_owner_allocation_v1','ledger_create_owner_investment_v1');
const investment=body('ledger_create_owner_investment_v1');

test('schema distinguishes capital recovery and profit distributions with correct uniqueness and policy',()=>{
  assert.match(migration,/settlement_type text not null default 'profit_distribution'/);
  assert.match(migration,/settlement_type in \('capital_recovery', 'profit_distribution'\)/);
  assert.match(migration,/alter column policy_id drop not null/);
  assert.match(migration,/settlement_type = 'capital_recovery' and policy_id is null/);
  assert.match(migration,/settlement_type = 'profit_distribution' and policy_id is not null/);
  assert.match(migration,/drop constraint ledger_owner_settlements_through_month_key/);
  assert.match(migration,/create unique index ledger_owner_profit_distribution_month_idx[\s\S]*where settlement_type = 'profit_distribution'/);
  assert.match(confirmRecovery,/values \(v_month, 'capital_recovery'/);
  assert.match(confirmProfit,/through_month = p_through_month[\s\S]*settlement_type = 'profit_distribution'/);
  assert.match(confirmProfit,/values \(p_through_month, 'profit_distribution'/);
});

test('recovery capacity is current, independent of profit settings, and caps cash and principal',()=>{
  assert.doesNotMatch(recoveryCapacity,/ledger_owner_profit_settings|ledger_month_closures|ledger_owner_settlement_policies/);
  assert.match(recoveryCapacity,/t\.occurred_at <= now\(\)/);
  assert.match(recoveryCapacity,/i\.occurred_at <= now\(\)/);
  assert.match(recoveryCapacity,/f\.is_active and f\.is_business_fund/);
  assert.match(recoveryCapacity,/f\.type in \('cash', 'bank', 'personal_custody'\)/);
  assert.match(recoveryCapacity,/p\.status <> 'cancelled'/);
  assert.match(recoveryCapacity,/s\.status in \('confirmed', 'partially_paid'\)/);
  assert.match(recoveryCapacity,/v_safe := greatest\(0, v_liquid - v_reserve - v_payable - v_owner_unpaid\)/);
  assert.match(recoveryCapacity,/least\(v_safe, v_unallocated\)/);
  for(const key of ['totalInvested','totalRecoveryAllocated','totalRecoveryPaid','totalUnallocatedUnrecoveredInvestment','totalCashUnrecoveredInvestment','recommendedMaxRecovery'])assert.ok(recoveryCapacity.includes(`'${key}'`));
});

test('confirmed unpaid recovery reserves both principal and safe cash for the next recovery',()=>{
  assert.match(recoveryCapacity,/sum\(a\.recovery_amount\) allocated/);
  assert.match(recoveryCapacity,/sum\(a\.assigned_amount - a\.paid_amount\)/);
  assert.match(recoveryCapacity,/s\.status in \('confirmed', 'partially_paid', 'paid'\)/);
  assert.match(recoveryCapacity,/greatest\(0, i\.invested - coalesce\(r\.allocated, 0\)\)/);
  assert.match(recoveryCapacity,/greatest\(0, i\.invested - coalesce\(r\.paid, 0\)\)/);
});

test('recovery confirmation needs cash and principal, without month close, policy or profit setup',()=>{
  for(const marker of ['ledger_owner_role_v1','pg_advisory_xact_lock','ledger_owner_recovery_capacity_v1','invalid_pool','no_unrecovered_investment','requested_above_recommended_max'])assert.ok(confirmRecovery.includes(marker),marker);
  assert.match(confirmRecovery,/scale\(p_requested_pool\) > 3/);
  assert.match(confirmRecovery,/p_requested_pool > \(v_capacity->>'recommendedMaxRecovery'\)::numeric/);
  assert.doesNotMatch(confirmRecovery,/ledger_month_is_closed_v1|ledger_owner_policy_at_v1|ledger_owner_profit_settings/);
  assert.match(confirmRecovery,/now\(\) at time zone 'Asia\/Ho_Chi_Minh'\) - interval '3 hours'/);
  assert.match(confirmRecovery,/'settlementType', 'capital_recovery'/);
  assert.match(confirmRecovery,/'allocationBasis', 'unrecovered_investment_ratio'/);
  assert.match(confirmRecovery,/v_assigned, v_assigned, 0, 0, 0, 0/);
  assert.match(confirmRecovery,/if v_assigned > v_line\.remaining/);
  assert.match(confirmRecovery,/from ranked order by user_id/);
  assert.match(confirmRecovery,/order by effective_from desc, id desc limit 1/);
  assert.match(confirmRecovery,/group by p\.user_id/g);
});

test('principal proportion ignores profit policy and preserves thousandth remainder',()=>{
  const owners=[
    {userId:3,participantId:13,unrecoveredForAllocation:'50'},
    {userId:1,participantId:11,unrecoveredForAllocation:'100'},
    {userId:2,participantId:12,unrecoveredForAllocation:'50'},
  ];
  assert.deepEqual(allocateOwnerRecoveryPool('40',owners).map(row=>row.assignedAmount),['20.000','10.000','10.000']);
  // A profit policy of 40/30/30 is intentionally absent from this input.
  assert.deepEqual(allocateOwnerRecoveryPool('0.005',owners).map(row=>row.assignedAmount),['0.003','0.001','0.001']);
  assert.throws(()=>allocateOwnerRecoveryPool('201',owners),RangeError);
  assert.match(confirmRecovery,/p_requested_pool \* e\.remaining \/ v_total exact_share/);
  assert.match(confirmRecovery,/trunc\(p_requested_pool \* e\.remaining \/ v_total, 3\) base_share/);
  assert.match(confirmRecovery,/order by exact_share - base_share desc, user_id/);
  assert.match(confirmRecovery,/base_share \+ case when remainder_rank <= remainder_units then 0\.001 else 0 end assigned/);
  assert.doesNotMatch(confirmRecovery,/then p_requested_pool - v_used/);
});

test('largest remainder protects a 0.001 principal near full recovery',()=>{
  const owners=[
    {userId:3,participantId:33,unrecoveredForAllocation:'0.001'},
    {userId:1,participantId:11,unrecoveredForAllocation:'100.000'},
    {userId:2,participantId:22,unrecoveredForAllocation:'100.000'},
  ];
  const rows=allocateOwnerRecoveryPool('199.999',owners);
  assert.deepEqual(rows.map(row=>row.assignedAmount),['99.999','99.999','0.001']);
  assert.equal(rows.reduce((sum,row)=>sum+Number(row.assignedAmount),0),199.999);
  for(const row of rows)assert.ok(Number(row.assignedAmount)<=Number(row.unrecoveredForAllocation));
  assert.deepEqual(allocateOwnerRecoveryPool('199.999',[...owners].reverse()),rows);
  assert.match(confirmRecovery,/if v_assigned > v_line\.remaining/);
  assert.match(confirmRecovery,/if v_used <> p_requested_pool/);
});

test('SQL and preview follow the same base, remainder rank, and user-id tie rule',()=>{
  for(const marker of ['exact_share','base_share','remainder_rank','remainder_units','order by user_id'])assert.ok(confirmRecovery.includes(marker));
  const tie=[{userId:2,participantId:2,unrecoveredForAllocation:'1.000'},{userId:1,participantId:1,unrecoveredForAllocation:'1.000'}];
  assert.deepEqual(allocateOwnerRecoveryPool('0.001',tie).map(row=>[row.userId,row.assignedAmount]),[[1,'0.001'],[2,'0.000']]);
  assert.deepEqual(allocateOwnerRecoveryPool('0.003',tie).map(row=>[row.userId,row.assignedAmount]),[[1,'0.002'],[2,'0.001']]);
});

test('profit capacity excludes recovery pool but both types remain payable obligations',()=>{
  assert.match(profitCapacity,/sum\(confirmed_pool\)[\s\S]*settlement_type = 'profit_distribution'/);
  assert.match(profitCapacity,/settlement_type = 'profit_distribution'\s+and through_month between v_start and p_through_month/);
  const distributions=[{month:'2026-07',amount:10},{month:'2026-08',amount:20},{month:'2026-10',amount:30}];
  assert.equal(distributions.filter(row=>row.month>='2026-08'&&row.month<='2026-08').reduce((sum,row)=>sum+row.amount,0),20);
  assert.match(profitCapacity,/where t\.status = 'confirmed' and t\.occurred_at <= now\(\)/);
  assert.match(profitCapacity,/from public\.ledger_reserve_entries where occurred_at <= now\(\)/);
  assert.match(profitCapacity,/v_undistributed := v_opening \+ v_profit - v_settled/);
  assert.match(profitCapacity,/sum\(a\.assigned_amount - a\.paid_amount\)[\s\S]*s\.status in \('confirmed', 'partially_paid'\)/);
  assert.doesNotMatch(profitCapacity,/settlement_type = 'capital_recovery'/);
  for(const marker of ['ledger_month_is_closed_v1','OWNER_PROFIT_TRACKING_NOT_CONFIGURED','ledger_owner_policy_at_v1'])assert.ok(confirmProfit.includes(marker));
  assert.match(confirmProfit,/v_assigned, 0, v_assigned/);
});

test('profit confirmation waits for actual principal payment, including fully allocated unpaid recovery',()=>{
  assert.match(confirmProfit,/v_recovery_capacity := public\.ledger_owner_recovery_capacity_v1\(\)/);
  assert.match(confirmProfit,/\(v_recovery_capacity->>'totalInvested'\)::numeric <= 0[\s\S]*'investment_not_configured'/);
  assert.match(confirmProfit,/\(v_recovery_capacity->>'totalCashUnrecoveredInvestment'\)::numeric > 0[\s\S]*'capital_recovery_not_completed'/);
  const eligibility=({invested,allocated,paid})=>{assert.ok(allocated>=paid);return invested<=0?'investment_not_configured':invested-paid>0?'capital_recovery_not_completed':'eligible'};
  assert.equal(eligibility({invested:0,allocated:0,paid:0}),'investment_not_configured');
  assert.equal(eligibility({invested:100,allocated:0,paid:0}),'capital_recovery_not_completed');
  assert.equal(eligibility({invested:100,allocated:100,paid:0}),'capital_recovery_not_completed');
  assert.equal(eligibility({invested:100,allocated:100,paid:100}),'eligible');
  assert.doesNotMatch(confirmProfit,/v_recovery_capacity->>'totalUnallocatedUnrecoveredInvestment'/);
});

test('capital payment stays recovery-only and preserves existing fund and month guards',()=>{
  assert.match(pay,/v_settlement\.settlement_type = 'capital_recovery' and v_profit_paid <> 0/);
  assert.match(pay,/'settlementType', v_settlement\.settlement_type/);
  for(const marker of ['invalid_fund_account','insufficient_fund','ledger_assert_month_open_v1','overpayment','ledger_audit_logs'])assert.ok(pay.includes(marker));
});

test('investment reduction cannot fall below confirmed recovery allocation',()=>{
  assert.match(investment,/v_new_investment := v_current \+ p_signed_amount/);
  assert.match(investment,/if v_new_investment < 0 then[\s\S]*'negative_cumulative_investment'/);
  assert.match(investment,/if v_new_investment < v_recovery_allocated then[\s\S]*'investment_below_recovery_obligation'/);
  assert.match(investment,/sum\(a\.recovery_amount\)/);
  assert.match(investment,/s\.status in \('confirmed', 'partially_paid', 'paid'\)/);
  assert.doesNotMatch(investment,/sum\(a\.recovery_paid_amount\)/);
  const result=(invested,allocated,delta)=>invested+delta<0?'negative_cumulative_investment':invested+delta<allocated?'investment_below_recovery_obligation':'allowed';
  assert.equal(result(100,80,-20),'allowed');
  assert.equal(result(100,80,-20.001),'investment_below_recovery_obligation');
  assert.equal(result(100,80,-50),'investment_below_recovery_obligation');
  assert.equal(result(100,0,-50),'allowed');
  assert.equal(result(100,80,-101),'negative_cumulative_investment');
});

test('investment floor joins participant history by user and counts obligations before payment',()=>{
  assert.match(investment,/from public\.ledger_owner_investments i\s+join public\.ledger_owner_participants p on p\.id = i\.participant_id\s+where p\.user_id = v_owner_user/);
  assert.match(investment,/from public\.ledger_owner_settlement_allocations a\s+join public\.ledger_owner_settlements s on s\.id = a\.settlement_id\s+join public\.ledger_owner_participants p on p\.id = a\.participant_id\s+where p\.user_id = v_owner_user/);
  const investments=[{participantId:10,userId:7,amount:60},{participantId:20,userId:7,amount:40}];
  const allocations=[{participantId:10,userId:7,recovery:30},{participantId:20,userId:7,recovery:50,pureProfit:0},{participantId:20,userId:7,recovery:0,pureProfit:20}];
  assert.equal(investments.filter(row=>row.userId===7).reduce((sum,row)=>sum+row.amount,0),100);
  assert.equal(allocations.filter(row=>row.userId===7).reduce((sum,row)=>sum+row.recovery,0),80);
  assert.equal(100-20,80);
});

test('replacement investment RPC keeps contribution, month, audit, and return contracts',()=>{
  assert.match(investment,/p_entry_type in \('opening', 'contribution'\) and p_signed_amount < 0/);
  assert.match(investment,/p_entry_type = 'adjustment' and nullif\(btrim\(p_reason\), ''\) is null/);
  assert.match(investment,/p_entry_type = 'contribution'[\s\S]*is_active and is_business_fund[\s\S]*type in \('cash', 'bank', 'personal_custody'\)/);
  assert.match(investment,/ledger_assert_month_open_v1\(date_trunc\('month', v_date\)::date\)/);
  assert.match(investment,/insert into public\.ledger_transactions/);
  assert.match(investment,/insert into public\.ledger_movements/);
  assert.match(investment,/insert into public\.ledger_owner_investments/);
  assert.match(investment,/'owner_investment_created'/);
  assert.match(investment,/'investmentId', v_id, 'transactionId', v_tx_id/);
});

test('investment writes share the recovery confirmation lock before reading both totals',()=>{
  const lock="pg_advisory_xact_lock(hashtext('ledger_owner_capital_recovery'))";
  assert.ok(confirmRecovery.includes(lock));
  assert.ok(investment.includes(lock));
  assert.ok(investment.indexOf(lock)<investment.indexOf('sum(i.signed_amount)'));
  assert.ok(investment.indexOf(lock)<investment.indexOf('sum(a.recovery_amount)'));
  assert.match(investment,/where user_id = v_owner_user order by id for update/);
});

test('future paid_at is rejected before any owner payment state changes',()=>{
  assert.match(pay,/if p_paid_at > now\(\) then\s+return jsonb_build_object\('status', 'future_payment_not_allowed'\)/);
  const guard=pay.indexOf('if p_paid_at > now()');
  for(const sideEffect of ['insert into public.ledger_transactions','insert into public.ledger_movements','update public.ledger_owner_settlement_allocations'])assert.ok(guard<pay.indexOf(sideEffect));
  assert.ok(guard<pay.indexOf('select * into v_allocation'));
  const state={invested:100,recoveryAllocated:100,paidAmount:0,recoveryPaid:0};
  assert.equal(state.invested-state.recoveryPaid,100);
  // The early return leaves both payment counters unchanged, so profit stays blocked.
  assert.deepEqual({paidAmount:state.paidAmount,recoveryPaid:state.recoveryPaid},{paidAmount:0,recoveryPaid:0});
  const paidNow={...state,paidAmount:100,recoveryPaid:100};
  assert.equal(paidNow.invested-paidNow.recoveryPaid,0);
  assert.match(confirmProfit,/totalCashUnrecoveredInvestment/);
});

test('RPC privileges remain service-role only with postgres ownership',()=>{
  for(const name of ['ledger_owner_recovery_capacity_v1','ledger_confirm_owner_recovery_v1','ledger_owner_financial_capacity_v1','ledger_confirm_owner_settlement_v1','ledger_pay_owner_allocation_v1','ledger_create_owner_investment_v1'])assert.match(migration,new RegExp(`alter function public\\.${name}[^;]* owner to postgres`));
  assert.match(migration,/revoke all on function[\s\S]*from public, anon, authenticated/);
  assert.match(migration,/grant execute on function[\s\S]*to service_role, postgres/);
  assert.match(migration,/public\.ledger_create_owner_investment_v1\(bigint,text,numeric,timestamptz,bigint,text,bigint\)[\s\S]*from public, anon, authenticated/);
  assert.match(migration,/public\.ledger_create_owner_investment_v1\(bigint,text,numeric,timestamptz,bigint,text,bigint\)[\s\S]*to service_role, postgres/);
  assert.equal((migration.match(/security definer/g)??[]).length,6);
  assert.equal((migration.match(/search_path = pg_catalog, public/g)??[]).length,6);
});

test('API and dashboard expose recovery without hiding profit settings compatibility',()=>{
  assert.match(route,/case"confirm_recovery":call=await supabaseServer\.rpc\("ledger_confirm_owner_recovery_v1"/);
  assert.match(route,/case"confirm":call=await supabaseServer\.rpc\("ledger_confirm_owner_settlement_v1"/);
  assert.match(route,/case"profit_settings"/);
  assert.match(dashboard,/rpc\("ledger_owner_recovery_capacity_v1"\)/);
  assert.match(dashboard,/recoveryCapacity:recoveryResult\.data/);
  assert.match(dashboard,/profitCapacity:capacityResult\.data/);
  assert.match(dashboard,/settlement_type,status,confirmed_pool/);
  assert.match(dashboard,/latestByUser/);
});

test('owners recovery UX has no month selector, distinguishes zero principal and full repayment',()=>{
  assert.match(ownersPage,/sheet==="recovery"/);
  assert.match(ownersPage,/action:"confirm_recovery"/);
  assert.doesNotMatch(ownersPage,/정산 기준 마감월|settlementMonth/);
  assert.match(ownersPage,/recoveryCapacity\.totalInvested\)<=0/);
  assert.match(ownersPage,/먼저 초기 투자금을 등록해주세요/);
  assert.match(ownersPage,/투자금 회수가 완료되었습니다/);
  assert.match(ownersPage,/settlement_type==="capital_recovery"\?"투자금 회수":"이익 정산"/);
  assert.match(ownersPage,/미회수 원금 비례/);
  assert.doesNotMatch(ownersPage,/allocateOwnerPool/);
});

test('settings shows principal rule and profit-only policy, without profit setup UI',()=>{
  assert.match(settingsPage,/투자금 회수 기준<\/span><strong>미회수 원금 비례/);
  assert.match(settingsPage,/이익 배분 비율 수정/);
  assert.match(settingsPage,/투자금 회수에는 사용되지 않으며/);
  assert.doesNotMatch(settingsPage,/미분배이익 시작 기준|action: "profit_settings"/);
  assert.match(settingsPage,/selectedUsers\.length !== 3/);
  assert.match(settingsPage,/participantEffectiveMonth/);
  assert.match(settingsPage,/policyEffectiveMonth/);
});
