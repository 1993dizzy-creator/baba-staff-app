import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {database,route,call} from './helpers/inventory-item-logs-fixture.mjs';

function load(path,deps={}){
 const m={exports:{}};
 const compiled=ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},reportDiagnostics:true});
 assert.deepEqual(compiled.diagnostics,[]);
 new Function('require','module','exports',compiled.outputText)(name=>{assert.ok(name in deps,name);return deps[name];},m,m.exports);
 return m.exports;
}
test('existing positive POS restorations display cancellation; new deductions retain sales label',()=>{
 const {getInventoryReasonBadgeMeta:badge}=load('lib/inventory/reasons.ts');
 assert.match(badge('sale_deduction','pos_sales','ko',1).text,/판매취소/);
 assert.match(badge('sale_deduction','pos_sales','vi','1').text,/Hủy bán/);
 assert.match(badge('sale_deduction','pos_sales','ko',-1).text,/판매차감/);
 assert.doesNotMatch(badge('purchase','edit_form','ko',1).text,/판매취소/);
});
test('item log ordering breaks equal timestamps by ID before latest-50/day-500 limits',async()=>{
 const rows=Array.from({length:520},(_,i)=>({id:i+1,item_id:1,reason:'sale_deduction',source:'pos_sales',change_quantity:-1,created_at:'2026-10-12T10:00:00Z',business_date:'2026-10-12'}));
 const latest=await call(route(database({inventory_logs:rows})),1);
 assert.deepEqual(latest.body.data.map(x=>x.id),Array.from({length:50},(_,i)=>520-i));
 const day=await call(route(database({inventory_logs:rows})),1,'?businessDate=2026-10-12');
 assert.deepEqual(day.body.data.map(x=>x.id),Array.from({length:500},(_,i)=>520-i));
 // Different timestamps still take priority over IDs.
 rows.push({...rows[0],id:1000,created_at:'2026-10-11T10:00:00Z'});
 assert.equal((await call(route(database({inventory_logs:rows})),1)).body.data[0].id,520);
});
test('unified initial executor propagates DB review result with zero success counts',async()=>{
 const current={receiptId:10,operationType:'initial_apply',actionableLineCount:1,blockingReasons:[],currentFingerprint:'fp'};
 const deps={
  'server-only':{},'node:crypto':{randomUUID:()=> 'test'},
  '@/lib/sales/inventory-deduction-lock':{isInventoryDeductionBusy:()=>false},
  '@/lib/sales/inventory-deduction-preview':{buildInventoryDeductionPreview:async()=>({receipts:[{receiptId:10,status:'ready',lines:[{deductions:[{}]}]}]})},
  '@/lib/sales/inventory-deduction-batches':{saveInventoryDeductionPreviewBatch:async()=>({batchId:1})},
  '@/lib/sales/inventory-deduction-batch-validation':{validateInventoryDeductionBatch:async()=>({found:true,applyReady:true,receipts:[]})},
  '@/lib/sales/inventory-deduction-reprocess':{},
  '@/lib/sales/inventory-deduction-unified-preview':{buildUnifiedInventoryDeductionPreview:async()=>({receipts:[current]})},
  '@/lib/supabase/server':{supabaseServer:{rpc:async()=>({data:{result:'needs_check',failureReason:'stock_check_boundary_requires_review'},error:null})}},
 };
 const {executeUnifiedInventoryDeductions}=load('lib/sales/inventory-deduction-unified-execute.ts',deps);
 const result=await executeUnifiedInventoryDeductions({actorUsername:'owner',items:[{receiptId:10,expectedOperationType:'initial_apply'}]});
 assert.equal(result.results[0].result,'needs_check');assert.equal(result.results[0].failureReason,'stock_check_boundary_requires_review');
 assert.equal(result.summary.appliedCount,0);assert.equal(result.summary.failedCount,0);assert.deepEqual(result.needsCheckReceiptIds,[10]);assert.deepEqual(result.processedReceiptIds,[]);
 current.operationType='needs_check';current.blockingReasons=['stock_check_boundary_requires_review'];
 const retry=await executeUnifiedInventoryDeductions({actorUsername:'owner',items:[{receiptId:10,expectedOperationType:'needs_check'}]});
 assert.equal(retry.results[0].result,'needs_check');
});

test('direct and saved-batch apply endpoints return 409 for committed review metadata',async()=>{
 const result={ok:false,result:'needs_check',failureReason:'stock_check_boundary_requires_review'};
 const deps={
  'next/server':{NextResponse:{json:(v,o)=>Response.json(v,o)}},
  '@/lib/auth/server-auth':{requireRole:async()=>({ok:true,actor:{username:'owner'}})},
  '@/lib/pos/mapping-admin':{getPositiveInteger:Number,getSupabaseErrorCode:e=>e.code},
  '@/lib/sales/inventory-deduction-lock':{isInventoryDeductionBusy:()=>false},
  '@/lib/sales/inventory-deduction-preview':{buildInventoryDeductionPreview:async()=>({receipts:[{receiptId:10,status:'ready',lines:[{deductions:[{}]}]}]})},
  '@/lib/sales/inventory-deduction-batches':{saveInventoryDeductionPreviewBatch:async()=>({batchId:1})},
  '@/lib/sales/inventory-deduction-batch-validation':{validateInventoryDeductionBatch:async()=>({found:true,applyReady:true,receipts:[]})},
  '@/lib/supabase/server':{supabaseServer:{rpc:async()=>({data:result,error:null})}},
 };
 const direct=load('app/api/admin/sales/inventory-deductions/apply/route.ts',deps);
 const saved=load('app/api/admin/sales/inventory-deductions/batches/[id]/apply/route.ts',deps);
 for(const response of [await direct.POST(new Request('http://local.test',{method:'POST',body:JSON.stringify({receiptIds:[10]})})),await saved.POST(null,{params:Promise.resolve({id:'1'})})]){
  assert.equal(response.status,409);assert.deepEqual(await response.json(),result);
 }
});
