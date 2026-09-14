import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

function load(path, dependencies = {}) {
  const testModule = { exports: {} };
  const code = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('require', 'module', 'exports', code)(name => {
    assert.ok(name in dependencies, `Unexpected import ${name}`);
    return dependencies[name];
  }, testModule, testModule.exports);
  return testModule.exports;
}
const sale = (id, date, amount) => ({ id, business_date: date, amount, status: 'confirmed', source_type: 'pos_sales_daily_payment', source_key: `pos:${date}:card` });
const rec = (id, date, amount, status='matched', gross=amount, difference=0) => ({ id, deposit_date: date, deposit_amount: amount, status, matched_gross_amount: gross, difference_amount: difference });
function setup({ sales=[], reconciliations=[], lines=[], movements=[], denied=false, failTable=null }={}) {
  const calls=[], rpcCalls=[];
  const tables = {
    ledger_transactions: sales,
    ledger_card_reconciliations: reconciliations,
    ledger_card_reconciliation_lines: lines.map(line => ({ ...line, reconciliation: reconciliations.find(row => row.id === line.reconciliation_id) ?? null })),
    ledger_fund_accounts: [{id:1,code:'card_clearing',display_name:'Card',is_active:true},{id:2,code:'bank',display_name:'Bank',is_active:true}],
    ledger_movements: movements,
  };
  const db = {
    from(table) {
      const filters=[], orders=[];let from=0,to=999;
      const field=(row,key)=>key.split('.').reduce((current,part)=>current?.[part],row);
      const query={select(){return query},order(key,options={}){orders.push([key,options.ascending!==false]);return query},range(start,end){from=start;to=end;return query},then(resolve,reject){
        calls.push({table,from,to});
        if(table===failTable)return Promise.resolve({data:null,error:{code:'LOCAL_READ_FAILURE'}}).then(resolve,reject);
        const rows=tables[table].filter(row=>filters.every(filter=>filter(row))).sort((a,b)=>{
          for(const [key,ascending] of orders){const av=field(a,key),bv=field(b,key);if(av<bv)return ascending?-1:1;if(av>bv)return ascending?1:-1;}return 0;
        });
        return Promise.resolve({data:rows.slice(from,to+1),error:null}).then(resolve,reject);
      }};
      for(const op of ['eq','neq','gte','lt','in','like'])query[op]=(key,value)=>{filters.push(row=>{
        const actual=field(row,key);
        if(op==='eq')return actual===value;if(op==='neq')return actual!==value;
        if(op==='gte')return actual>=value;if(op==='lt')return actual<value;
        if(op==='in')return value.includes(actual);
        return new RegExp(`^${value.replaceAll('%','.*')}$`).test(actual);
      });return query;};
      return query;
    },
    async rpc(name,args) { rpcCalls.push({name,args});return {data:{status:name==='ledger_create_card_deposit_v1'?'created':args.p_confirm?'matched':'partial'},error:null}; },
  };
  const server={requireLedgerActor:async()=>denied?{response:Response.json({ok:false},{status:403})}:{actor:{id:7}},ledgerJson:(body,status=200)=>Response.json(body,{status})};
  const deps={'@/lib/supabase/server':{supabaseServer:db},'@/lib/ledger/server':server};
  deps['@/lib/ledger/card-settlements']=load('lib/ledger/card-settlements.ts');
  deps['@/lib/ledger/card-settlement-data']=load('lib/ledger/card-settlement-data.ts',deps);
  const api=load('app/api/admin/ledger/card-settlements/route.ts',deps),match=load('app/api/admin/ledger/card-settlements/[id]/match/route.ts',deps);
  return {api,match,calls,rpcCalls};
}
const get=async(state,month='2026-08')=>state.api.GET(new Request(`http://local/api/admin/ledger/card-settlements?month=${month}`));

test('GET keeps sale-month gross separate from deposit-month summary and returns oldest outstanding candidates across months',async()=>{
  const state=setup({sales:[sale(3,'2026-09-01',2000),sale(2,'2026-08-15',1000),sale(1,'2026-07-15',500)],reconciliations:[rec(1,'2026-09-10',982,'matched',1000,18),rec(2,'2026-08-20',300,'partial',400),rec(3,'2026-08-21',200,'cancelled')],lines:[{id:1,reconciliation_id:1,pos_card_transaction_id:2,allocated_gross_amount:1000},{id:2,reconciliation_id:2,pos_card_transaction_id:3,allocated_gross_amount:400},{id:3,reconciliation_id:3,pos_card_transaction_id:1,allocated_gross_amount:500}],movements:[{id:1,fund_account_id:1,amount:2000,transaction:{status:'confirmed'}},{id:2,fund_account_id:1,amount:9999,transaction:{status:'draft'}},{id:3,fund_account_id:2,amount:8888,transaction:{status:'confirmed'}}]});
  const august=await(await get(state)).json();
  assert.equal(august.summary.monthlyCardGross,1000);assert.equal(august.summary.monthlyReconciledGross,1000);assert.equal(august.summary.monthlyUnreconciledGross,0);assert.equal(august.summary.totalUnreconciledGross,2100);assert.equal(august.summary.cardPendingBalance,2000);assert.equal(august.summary.actualCardDeposits,300);assert.equal(august.summary.monthlyUnmatchedDeposits,300);assert.equal(august.summary.actualDifferenceRate,null);
  assert.deepEqual(august.sales.map(row=>row.id),[1,3]);assert.deepEqual(august.reconciliations.map(row=>row.id),[2]);
  const september=await(await get(state,'2026-09')).json();assert.equal(september.summary.monthlyUnreconciledGross,1600);assert.equal(september.summary.monthlyCompletedGross,1000);assert.equal(september.summary.monthlyCompletedDeposit,982);assert.equal(september.summary.monthlyCompletedDifference,18);assert.equal(september.summary.actualDifferenceRate,0.018);
});
test('GET with no reconciliation leaves full monthly and total gross outstanding',async()=>{
  const state=setup({sales:[sale(1,'2026-08-01',1000),sale(2,'2026-09-01',2000)]});const body=await(await get(state)).json();assert.equal(body.summary.monthlyUnreconciledGross,1000);assert.equal(body.summary.totalUnreconciledGross,3000);assert.equal(body.summary.actualCardDeposits,0);
});
test('GET pages sales, reconciliation lines and clearing movements beyond 1000 rows',async()=>{
  const sales=Array.from({length:1001},(_,i)=>sale(i+1,'2026-08-01',1000));
  const state=setup({sales,reconciliations:[rec(1,'2026-09-01',100100,'partial',100100)],lines:sales.map(row=>({id:row.id,reconciliation_id:1,pos_card_transaction_id:row.id,allocated_gross_amount:100})),movements:sales.map(row=>({id:row.id,fund_account_id:1,amount:1,transaction:{status:'confirmed'}}))});
  const body=await(await get(state)).json();assert.equal(body.summary.monthlyUnreconciledGross,900900);assert.equal(body.summary.cardPendingBalance,1001);
  for(const table of ['ledger_transactions','ledger_card_reconciliation_lines','ledger_movements'])assert.equal(state.calls.filter(call=>call.table===table).length,2);
});
test('GET authorization, invalid month and failed reads do not silently return financial totals',async()=>{
  const denied=setup({denied:true});assert.equal((await get(denied)).status,403);assert.equal(denied.calls.length,0);
  const invalid=setup();assert.equal((await get(invalid,'2026-13')).status,400);assert.equal(invalid.calls.length,0);
  const failed=setup({failTable:'ledger_card_reconciliation_lines'});assert.equal((await get(failed)).status,500);
});
test('create and partial/confirmed match still forward the existing RPC contracts without direct writes',async()=>{
  const state=setup();
  const deposit={depositAt:'2026-09-10T10:00:00+07:00',amount:982,destinationAccountId:2,reference:'local-test',memo:'local-test'};
  const response=await state.api.POST(new Request('http://local/api/admin/ledger/card-settlements',{method:'POST',body:JSON.stringify(deposit)}));assert.equal(response.status,201);
  assert.deepEqual(state.rpcCalls[0],{name:'ledger_create_card_deposit_v1',args:{p_deposit_at:deposit.depositAt,p_amount:982,p_destination_account_id:2,p_reference:'local-test',p_memo:'local-test',p_actor_user_id:7}});
  const allocations=[{transactionId:1,allocatedGrossAmount:1000}];
  for(const confirm of [false,true]){
    const response=await state.match.POST(new Request('http://local/api/admin/ledger/card-settlements/1/match',{method:'POST',body:JSON.stringify({allocations,confirm})}),{params:Promise.resolve({id:'1'})});assert.equal(response.status,200);assert.deepEqual(state.rpcCalls.at(-1),{name:'ledger_match_card_reconciliation_v1',args:{p_reconciliation_id:1,p_allocations:allocations,p_confirm:confirm,p_actor_user_id:7}});
  }
  assert.equal(state.calls.length,0);
});
