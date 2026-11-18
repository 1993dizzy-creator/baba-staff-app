// App-level: a failed apply RPC (e.g. SQLSTATE 57014 statement timeout) closes its
// own previously committed preview batch so leftover `selected` candidates can
// never be applied later, without touching candidates or masking the failure.
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

function load(path,deps={}){
 const m={exports:{}};
 const compiled=ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},reportDiagnostics:true});
 assert.deepEqual(compiled.diagnostics,[]);
 new Function('require','module','exports',compiled.outputText)(name=>{assert.ok(name in deps,name);return deps[name];},m,m.exports);
 return m.exports;
}

// Minimal in-memory PostgREST builder: select/update with eq filters.
function fakeSupabase(tables,{rpcError,failUpdates=false}={}){
 const updates=[];
 function from(table){
  const state={op:'select',values:null,filters:[],single:false};
  const builder={
   select(){return builder;},
   update(values){if(failUpdates)throw new Error('update unavailable');state.op='update';state.values=values;return builder;},
   eq(k,v){state.filters.push([k,v]);return builder;},
   limit(){return builder;},
   maybeSingle(){state.single=true;return builder;},
   then(resolve,reject){
    try{
     const rows=(tables[table]||[]).filter(r=>state.filters.every(([k,v])=>r[k]===v));
     if(state.op==='update'){updates.push({table,values:state.values,filters:state.filters});for(const r of rows)Object.assign(r,state.values);}
     const data=state.single?(rows[0]?{...rows[0]}:null):rows.map(r=>({...r}));
     return Promise.resolve({data,error:null}).then(resolve,reject);
    }catch(e){return Promise.reject(e).then(resolve,reject);}
   },
  };
  return builder;
 }
 return {updates,client:{from,rpc:async()=>({data:null,error:rpcError})}};
}

function executor(supabase){
 const current={receiptId:10,operationType:'initial_apply',actionableLineCount:1,blockingReasons:[],currentFingerprint:'fp'};
 return load('lib/sales/inventory-deduction-unified-execute.ts',{
  'server-only':{},'node:crypto':{randomUUID:()=> 'exec'},
  '@/lib/sales/inventory-deduction-lock':{isInventoryDeductionBusy:e=>e?.code==='55P03'},
  '@/lib/sales/inventory-deduction-preview':{buildInventoryDeductionPreview:async()=>({receipts:[{receiptId:10,status:'ready',lines:[{deductions:[{}]}]}]})},
  '@/lib/sales/inventory-deduction-batches':{saveInventoryDeductionPreviewBatch:async()=>({batchId:1329})},
  '@/lib/sales/inventory-deduction-batch-validation':{validateInventoryDeductionBatch:async()=>({found:true,applyReady:true,receipts:[]})},
  '@/lib/sales/inventory-deduction-reprocess':{},
  '@/lib/sales/inventory-deduction-unified-preview':{buildUnifiedInventoryDeductionPreview:async()=>({receipts:[current]})},
  '@/lib/supabase/server':{supabaseServer:supabase.client},
 }).executeUnifiedInventoryDeductions;
}
const run=execute=>execute({actorUsername:'owner',items:[{receiptId:10,expectedOperationType:'initial_apply'}]});
const tables=batchStatus=>({
 pos_inventory_deduction_batches:[{id:1329,status:batchStatus,error_message:null}],
 pos_inventory_deduction_receipts:[{id:1457,batch_id:1329,receipt_id:10,status:batchStatus==='applied'?'applied':'ready',selected_for_apply:true,workflow_type:'initial_apply',receipt_content_fingerprint:'fp',error_message:null}],
 pos_inventory_deductions:[{id:2236,batch_id:1329,status:'selected',operation_type:'preview'}],
});
const timeout={code:'57014',message:'canceling statement due to statement timeout',details:'row data must not be logged'};

test('statement timeout closes the preview batch, keeps candidate evidence and reports SQLSTATE',async t=>{
 t.mock.method(console,'error',()=>{});t.mock.method(console,'info',()=>{});
 const db=tables('previewed'),supabase=fakeSupabase(db,{rpcError:timeout});
 const result=(await run(executor(supabase))).results[0];
 assert.equal(result.result,'failed');assert.equal(result.batchId,1329);
 assert.match(result.failureReason,/^sqlstate_57014:canceling statement/);
 assert.deepEqual(db.pos_inventory_deduction_batches[0],{id:1329,status:'failed',error_message:'apply_rpc_failed:57014',updated_at:db.pos_inventory_deduction_batches[0].updated_at});
 const receipt=db.pos_inventory_deduction_receipts[0];
 assert.equal(receipt.status,'failed');assert.equal(receipt.selected_for_apply,false);assert.equal(receipt.error_message,'apply_rpc_failed:57014');
 assert.deepEqual(db.pos_inventory_deductions[0],{id:2236,batch_id:1329,status:'selected',operation_type:'preview'},'Candidates are evidence and stay untouched');
 assert.deepEqual(supabase.updates[0].filters,[['id',1329],['status','previewed']],'Close is conditional on previewed');
 const logged=JSON.stringify(console.error.mock.calls.map(c=>c.arguments));
 assert.match(logged,/SALES_INVENTORY_APPLY_RPC_FAILED/);assert.match(logged,/57014/);assert.match(logged,/rpcMs/);
 assert.doesNotMatch(logged,/row data must not be logged/);
});

test('a batch the RPC actually committed is never reopened or failed',async t=>{
 t.mock.method(console,'error',()=>{});t.mock.method(console,'info',()=>{});
 const db=tables('applied'),supabase=fakeSupabase(db,{rpcError:{code:'08006',message:'connection failure'}});
 const result=(await run(executor(supabase))).results[0];
 assert.equal(result.result,'already_processed');
 assert.equal(db.pos_inventory_deduction_batches[0].status,'applied');
 assert.equal(db.pos_inventory_deduction_receipts[0].status,'applied');
 assert.equal(supabase.updates.filter(u=>u.table==='pos_inventory_deduction_receipts').length,0);
});

test('busy lock result stays a retryable stale preview and still closes its own batch',async t=>{
 t.mock.method(console,'error',()=>{});t.mock.method(console,'info',()=>{});
 const db=tables('previewed'),supabase=fakeSupabase(db,{rpcError:{code:'55P03',message:'lock not available'}});
 const result=(await run(executor(supabase))).results[0];
 assert.equal(result.result,'stale_preview');assert.equal(result.failureReason,'inventory_busy_refresh_required');
 assert.equal(db.pos_inventory_deduction_batches[0].status,'failed');
});

test('a failure while closing the batch never masks the original apply failure',async t=>{
 t.mock.method(console,'error',()=>{});t.mock.method(console,'info',()=>{});
 const db=tables('previewed'),supabase=fakeSupabase(db,{rpcError:timeout,failUpdates:true});
 const result=(await run(executor(supabase))).results[0];
 assert.equal(result.result,'failed');assert.match(result.failureReason,/^sqlstate_57014:/);
 assert.equal(db.pos_inventory_deduction_batches[0].status,'previewed');
 assert.match(JSON.stringify(console.error.mock.calls.map(c=>c.arguments)),/SALES_INVENTORY_APPLY_BATCH_CLOSE_FAILED/);
});
