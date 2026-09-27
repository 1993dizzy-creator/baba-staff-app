import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

function load(path, dependencies = {}) {
  const testModule = { exports: {} };
  const code = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  new Function('require', 'module', 'exports', code)(name => dependencies[name], testModule, testModule.exports);
  return testModule.exports;
}
const policy = load('lib/ledger/card-deposit-display.ts', { './card-settlements': load('lib/ledger/card-settlements.ts') });

test('deposit display no longer exposes a separate oldest-sale reference or fee preview', () => {
  assert.equal(policy.oldestUnsettledCardSale, undefined);
  assert.equal(policy.cardDepositPreview, undefined);
  assert.doesNotMatch(readFileSync('lib/ledger/card-deposit-display.ts', 'utf8'), /recommendCardAllocations|0\.018|\brate\b/);
});
test('matched and auto_allocated deposits form one list by deposit date then id; cancelled follow as history', () => {
  const row = (id, status, deposit_date) => ({ id, status, deposit_date, deposit_amount: 100 });
  const grouped = policy.groupCardDeposits([
    row(9, 'auto_allocated', '2026-09-25'), row(3, 'matched', '2026-09-03'), row(8, 'auto_allocated', '2026-09-15'),
    row(7, 'matched', '2026-09-15'), row(5, 'cancelled', '2026-09-04'), row(6, 'unmatched', '2026-09-16'), row(1, 'matched', '2026-08-31'),
  ], '2026-09');
  assert.deepEqual(grouped.deposits.map(r => [r.id, r.status]), [[3, 'matched'], [7, 'matched'], [8, 'auto_allocated'], [6, 'unmatched'], [9, 'auto_allocated']]);
  assert.deepEqual(grouped.cancelled.map(r => r.id), [5]);
  assert.deepEqual(Object.keys(grouped).sort(), ['cancelled', 'deposits'], 'no separate matched/auto/pending groups');
});
function api(account) {
  const calls = [];
  const query = { select(){return query;}, eq(...args){calls.push(args);return query;}, neq(...args){calls.push(args);return query;}, async maybeSingle(){return {data:account,error:null};} };
  const route = load('app/api/admin/ledger/card-settlements/route.ts', {
    '@/lib/ledger/card-settlements': {}, '@/lib/ledger/card-settlement-data': {},
    '@/lib/ledger/server': { requireLedgerActor: async()=>({actor:{id:7}}), ledgerJson:(body,status=200)=>Response.json(body,{status}) },
    '@/lib/supabase/server': { supabaseServer: { from:()=>query, rpc:async(name,args)=>{calls.push({name,args});return {data:{status:'created'},error:null};} } },
  });
  return { calls, post:body=>route.POST(new Request('http://local',{method:'POST',body:JSON.stringify(body)})) };
}
test('deposit POST resolves the active corporate bank and calls only the atomic auto-allocation RPC', async()=>{
  const state = api({id:42});
  const body = {depositAt:'2026-09-15T12:00:00+07:00',amount:5000000,memo:'m'};
  assert.equal((await state.post(body)).status,201);
  assert.ok(state.calls.some(call=>Array.isArray(call)&&call[0]==='code'&&call[1]==='baba_corporate_bank'));
  assert.ok(state.calls.some(call=>Array.isArray(call)&&call[0]==='is_active'&&call[1]===true));
  assert.ok(state.calls.some(call=>Array.isArray(call)&&call[0]==='type'&&call[1]==='card_clearing'));
  const rpcs = state.calls.filter(call=>!Array.isArray(call));
  assert.deepEqual(rpcs,[{name:'ledger_create_card_deposit_auto_allocate_v1',args:{p_deposit_at:body.depositAt,p_amount:5000000,p_destination_account_id:42,p_memo:'m',p_actor_user_id:7}}]);
  for(const extra of [{destinationAccountId:99},{reference:'r'},{allocations:[]}]) assert.equal((await state.post({...body,...extra})).status,400,JSON.stringify(extra));
  assert.equal((await (await api(null).post(body)).json()).code,'CORPORATE_BANK_ACCOUNT_MISSING');
});
test('UI registers deposits with a FIFO preview and has no manual sales-matching flow',()=>{
  const page=readFileSync('app/(protected)/admin/ledger/card-settlements/page.tsx','utf8');
  assert.doesNotMatch(page,/CardSalesList|destinationAccountId|setAccountId/);
  assert.match(page,/priorUnreconciledSales.length\?<p/);
  assert.match(page,/style=\{\{width:"100%"\}\}/);
  assert.doesNotMatch(page,/<details|matchedTotal|statusName|completedBadge|autoBadge/);
  for(const label of ['📅','💵','💡','📝']) assert.ok(page.includes(label));
  for(const contract of ['planCardDepositAutoAllocation(', 'formatLedgerAmountInput(amount)', 'sanitizeLedgerAmountInput(e.target.value)', 'parseLedgerAmount(amount)', 'openPos', '/cancel']) assert.ok(page.includes(contract),contract);
  assert.doesNotMatch(page,/\/match`|match\((true|false)\)|setAllocations|editableSales|buildEditableCardSales|recommendCardAllocations|expectedFee|기준 수수료율|추천 정산|matchSales/);
});
