import { PAYMENT_REFRESH_MESSAGES, payablePaymentErrorMessage } from "../lib/ledger/payable-payment-messages.ts";
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync,existsSync} from 'node:fs';
import ts from 'typescript';
import {sendPayablePayment,pendingPayablePayment} from '../lib/ledger/payable-payment-client.ts';
const memory=()=>{const data=new Map();return{getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)}};
function reset(){globalThis.localStorage=memory();localStorage.setItem('baba_user',JSON.stringify({id:2}));globalThis.sessionStorage=memory();globalThis.window=new EventTarget();}
const body={partyId:10,fundAccountId:1,occurredAt:'2026-10-05T12:00:00+07:00',amount:1000,allocations:[{payableId:7,allocatedAmount:1000}],memo:null};
const success=()=>Response.json({ok:true,result:{status:'paid',paymentTransactionId:1}},{status:201});
test('client: double click shares attempt, network loss reuses key, altered payload blocked, distinct normal attempt gets a new key',async()=>{
 reset();const posts=[];let resolve;globalThis.fetch=async(_url,init)=>{posts.push(JSON.parse(init.body));return new Promise(r=>resolve=r)};
 const a=sendPayablePayment(body,async()=>{}),b=sendPayablePayment(body,async()=>{});assert.equal(a,b);assert.equal(posts.length,1);resolve(success());await a;assert.equal(pendingPayablePayment(10),null);
 globalThis.fetch=async(_url,init)=>{posts.push(JSON.parse(init.body));throw Error('response lost after server commit')};
 await assert.rejects(()=>sendPayablePayment(body,async()=>{}));const pending=pendingPayablePayment(10);assert.notEqual(pending.requestId,posts[0].requestId);
 await assert.rejects(()=>sendPayablePayment({...body,amount:2000},async()=>{}),/PAYMENT_REQUEST_PENDING/);assert.equal(posts.length,2);
 globalThis.fetch=async(_url,init)=>{posts.push(JSON.parse(init.body));return success()};await sendPayablePayment(body,async()=>{});assert.equal(posts[2].requestId,pending.requestId);assert.equal(pendingPayablePayment(10),null);
});
test('client: refresh failure and reload keep original payload/key; cannot pay without durable storage',async()=>{
 reset();let posts=[];globalThis.fetch=async(_url,init)=>{posts.push(JSON.parse(init.body));return success()};
 await assert.rejects(()=>sendPayablePayment(body,async()=>{throw Error('refresh failed')}));const attempt=pendingPayablePayment(10);
 // A new module instance represents a tab reload; sessionStorage survives.
 const client=await import('../lib/ledger/payable-payment-client.ts?reload=1');
 await client.sendPayablePayment(attempt.body,async()=>{});assert.equal(posts[0].requestId,posts[1].requestId);assert.equal(client.pendingPayablePayment(10),null);
 sessionStorage.setItem=()=>{throw Error('storage blocked')};assert.throws(()=>sendPayablePayment(body,async()=>{}),/storage blocked/);assert.equal(posts.length,2);
});
test('client: deterministic refusal permits correction; 500/parse failures and key conflict preserve attempt',async()=>{
 reset();for(const response of [()=>Response.json({code:'IDEMPOTENCY_STATE_INVALID'},{status:409}),()=>Response.json({code:'FORBIDDEN'},{status:403}),()=>Response.json({code:'INVALID_BODY'},{status:400}),()=>Response.json({code:'IDEMPOTENCY_KEY_REQUIRED'},{status:428}),()=>Response.json({code:'PAYABLE_PAYMENT_FAILED'},{status:500}),()=>new Response('bad json',{status:201}),()=>Response.json({code:'IDEMPOTENCY_CONFLICT'},{status:409})]){
  globalThis.fetch=async()=>response();await assert.rejects(()=>sendPayablePayment(body,async()=>{}));assert.ok(pendingPayablePayment(10));
 }
 globalThis.fetch=async()=>Response.json({code:'INVALID_ALLOCATION'},{status:409});await assert.rejects(()=>sendPayablePayment(body,async()=>{}));assert.equal(pendingPayablePayment(10),null);
});
const source=readFileSync('app/api/admin/ledger/payables/pay/route.ts','utf8');
function api({actor={id:2},rpc=async()=>({data:{status:'paid'},error:null})}={}){
 const output=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,mod={exports:{}};
 new Function('require','module','exports',output)(name=>({
  '@/lib/ledger/payable-payment-messages':{PAYMENT_REFRESH_MESSAGES},
  '@/lib/ledger/server':{requireLedgerActor:async()=>({actor,response:actor?null:Response.json({code:'FORBIDDEN'},{status:403})}),ledgerJson:(json,status=200)=>Response.json(json,{status})},
  '@/lib/supabase/server':{supabaseServer:{rpc}}
 })[name],mod,mod.exports);return mod.exports.POST;
}
const key='f418a078-c318-4a55-aea4-f0775c8f9d13';
const req=(b,headers={})=>new Request('http://localhost/api/admin/ledger/payables/pay',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(b)});
test('API: keyless legacy request fails closed without RPC; invalid or mismatched keys rejected',async()=>{
 let count=0;const post=api({rpc:async()=>{count++;throw Error('must not call')}});const legacy=await post(req(body));assert.equal(legacy.status,428);assert.deepEqual(await legacy.json(),{ok:false,code:'IDEMPOTENCY_KEY_REQUIRED',action:'refresh',message:PAYMENT_REFRESH_MESSAGES});
 assert.equal((await post(req({...body,requestId:'bad'}))).status,400);assert.equal((await post(req({...body,requestId:key},{'Idempotency-Key':crypto.randomUUID()}))).status,409);assert.equal(count,0);
});
test('API: body/header keys map V2 args and authenticated actor; no V1 fallback',async()=>{
 for(const viaHeader of [false,true]){let call;const post=api({rpc:async(...args)=>{call=args;return{data:{status:'paid',paymentTransactionId:5},error:null}}});
 const r=await post(req(viaHeader?body:{...body,requestId:key},viaHeader?{'Idempotency-Key':key}:{}));assert.equal(r.status,201);assert.equal(call[0],'ledger_pay_payables_v2');assert.equal(call[1].p_request_id,key);assert.equal(call[1].p_actor_user_id,2);assert.deepEqual(call[1].p_allocations,body.allocations);
 }
});
test('API: conflicts/overpayment/permission/server failure return correct status',async()=>{
 for(const [status,http] of [['idempotency_state_invalid',409],['idempotency_conflict',409],['invalid_allocation',409],['amount_exceeds_outstanding',409],['forbidden',403],['invalid_amount',400]]){
 const response=await api({rpc:async()=>({data:{status},error:null})})(req({...body,requestId:key}));assert.equal(response.status,http);assert.equal((await response.json()).code,status.toUpperCase());
 }
 const original=console.error;console.error=()=>{};try{assert.equal((await api({rpc:async()=>({data:null,error:{code:'PGRST202'}})})(req({...body,requestId:key}))).status,500)}finally{console.error=original}
 assert.equal((await api({actor:null})(req({...body,requestId:key}))).status,403);
});
test('snapshot: 1709 is existing explicit sheet-row cash reconciliation; original settlement unchanged',{skip:!existsSync('.qa-review/october-settlement/comparison.json')},()=>{
 const b=JSON.parse(readFileSync('.qa-review/october-settlement/baseline.json')),comparison=JSON.parse(readFileSync('.qa-review/october-settlement/comparison.json'));
 for(const [row,id,difference] of [[99,2489,9],[132,2891,100],[150,2892,1600]]){const r=comparison.sheetGroups.find(r=>r.row===row);assert.equal(r.allocatedDifference,difference);assert.equal(r.reconciliationAmount,difference);assert.equal(r.difference,0);assert.equal(r.match,true);assert.deepEqual(r.reconciliations.map(t=>t.transactionId),[id]);assert.equal(b.allocations.filter(a=>a.payment_transaction_id===id).length,0);}
 assert.equal(comparison.sheetGroups.every(r=>r.match),true);assert.equal(comparison.totals.adjustment,-7100);assert.equal(comparison.invariant,true);
});
test('KO/VI refresh and incomplete-record messages are actionable and hide internal codes',()=>{
   for(const vi of [false,true]){assert.equal(payablePaymentErrorMessage('IDEMPOTENCY_KEY_REQUIRED',vi),PAYMENT_REFRESH_MESSAGES[vi?'vi':'ko']);const message=payablePaymentErrorMessage('IDEMPOTENCY_STATE_INVALID',vi);assert.doesNotMatch(message,/IDEMPOTENCY|NULL|completed_at/);assert.match(message,vi?/Không tạo yêu cầu mới/:/새 요청을 만들지/)}
  });
