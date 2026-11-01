import assert from 'node:assert/strict';
import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import crypto from 'node:crypto';
import ts from 'typescript';

const BASE='cc755198ad061866936a0eb43e12d72c86c6e913';
const REASON='stock_check_boundary_requires_review';
function load(source,deps){
 const m={exports:{}};
 const output=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true},reportDiagnostics:true});
 assert.deepEqual(output.diagnostics,[]);
 new Function('require','module','exports',output.outputText)(name=>{assert.ok(name in deps,name);return deps[name];},m,m.exports);
 return m.exports;
}
const read=p=>readFileSync(p,'utf8');
const blob=(ref,p)=>execFileSync('git',['show',ref+':'+p],{encoding:'utf8',maxBuffer:4*1024*1024});

test('final verification: snapshot static assertion fails identically on parent and baseline',t=>{
 const path='tests/inventory-daily-item-logs.test.mjs',page='app/(protected)/inventory/snapshots/page.tsx';
 const parent=execFileSync('git',['rev-parse',BASE+'^'],{encoding:'utf8'}).trim();
 const failures=[];
 for(const ref of [parent,BASE]){
  let checked=0;
  load(blob(ref,path),{
   'node:assert/strict':assert,
   'node:test':(name,fn)=>{if(!name.startsWith('snapshot modal:'))return;checked++;try{fn();assert.fail('Expected the known baseline failure');}catch(e){assert.equal(e.code,'ERR_ASSERTION');assert.equal(e.operator,'match');assert.equal(String(e.expected),'/canChangeReceiptSupplier = \\["owner", "master"\\]/');failures.push(String(e.expected));}},
   'node:fs':{readFileSync:p=>blob(ref,p)},
   './helpers/inventory-item-logs-fixture.mjs':{},'../lib/inventory/daily-item-log-entries.ts':{},
  });
  assert.equal(checked,1);
  t.diagnostic(ref+': existing assertion '+failures.at(-1));
 }
 assert.equal(blob(parent,page),blob(BASE,page));assert.equal(blob(parent,path),blob(BASE,path));
 assert.deepEqual(failures,[failures[0],failures[0]]);
});

// Only the existing receipt queue protocol is emulated; no inventory/SQL writes.
function receiptQueue(rows){
 const reads=[],writes=[];
 const value=(r,k,op,v)=>op==='is'?r[k]==null:op==='neq'?r[k]!=null&&String(r[k])!==v:op==='eq'?String(r[k])===v:op==='lt'?r[k]!=null&&String(r[k])<v:false;
 return {reads,writes,from(table){
  assert.equal(table,'pos_sales_receipts');let update=null;const filters=[];
  const q={select(){return q;},update(v){update=v;return q;},eq(k,v){filters.push(r=>r[k]===v);return q;},lt(k,v){filters.push(r=>r[k]!=null&&r[k]<v);return q;},not(k,op,v){assert.equal(op,'is');assert.equal(v,null);filters.push(r=>r[k]!=null);return q;},
   or(s){filters.push(r=>s.split(',').some(part=>{const [k,op,...v]=part.split('.');return value(r,k,op,v.join('.'));}));return q;},order(){return q;},limit(){return q;},
   async then(resolve,reject){try{const selected=rows.filter(r=>filters.every(f=>f(r)));if(update){for(const r of selected){writes.push({id:r.id,...update});Object.assign(r,update);}}else reads.push(selected.map(r=>r.id));return resolve({data: update?null:selected.map(r=>({id:r.id})),error:null});}catch(e){return reject(e);}},
  };return q;
 }};
}

test('final verification: cron excludes review conflicts across ticks and admits reviewed receipts again',async()=>{
 const rows=[1,2,3].map(id=>({id,payment_status:3,is_canceled:id===2,updated_at:'2026-10-12T12:00:00Z',inventory_deduction_auto_eligible_at:'2026-10-12T12:00:00Z',inventory_deduction_last_checked_at:null,inventory_deduction_processing_paused:false,inventory_deduction_processing_error:id<=2?REASON:'admin_edit_failed'}));
 const db=receiptQueue(rows),previews=[],executions=[];
 const policy=load(read('lib/sales/inventory-deduction-workflow-policy.ts'),{});
 const {classifyReceipt}=load(read('lib/sales/inventory-deduction-unified-preview.ts')+'\nexport {classifyReceipt};',{
  'server-only':{},'@/lib/supabase/server':{},'@/lib/sales/inventory-deduction-preview':{},'@/lib/sales/inventory-deduction-fingerprint':{},'@/lib/sales/inventory-deduction-workflow-policy':policy,'@/lib/sales/inventory-deduction-recipe-policy':{},
 });
 const history={activeAppliedDeductionCount:1,hasSuccessfulInventoryProcessingHistory:true,lastProcessedFingerprint:'old',hasSuccessfulCurrentFingerprint:false};
 const classify=row=>({...classifyReceipt({receipt:row,previewReceipt:null,currentFingerprint:'changed',history}),receiptId:row.id,updatedAt:row.updated_at,currentFingerprint:'changed'});
 for(const row of rows.slice(0,2)){assert.equal(classify(row).canExecute,false);assert.equal(classify(row).operationType,'needs_check');}
 const {runSalesDeductionCron}=load(read('lib/sales/sales-deduction-cron-shared.ts'),{
  crypto,'next/server':{NextResponse:{json:Response.json}},'@/lib/supabase/server':{supabaseServer:db},
  '@/lib/sales/inventory-deduction-unified-preview':{buildUnifiedInventoryDeductionPreview:async({receiptIds})=>{previews.push(...receiptIds);return {receipts:receiptIds.map(id=>classify(rows.find(r=>r.id===id)))};}},
  '@/lib/sales/inventory-deduction-unified-execute':{executeUnifiedInventoryDeductions:async({items})=>{executions.push(...items.map(i=>i.receiptId));return {results:[{result:'applied',batchId:1}]};}},
 });
 const original=JSON.stringify(rows.slice(0,2));const now=Date.now;
 try{
  for(const minutes of [0,16,32]){Date.now=()=>now()+minutes*60000;const result=await runSalesDeductionCron({businessDate:'2026-11-02',actor:{id:1,username:'owner'}});assert.equal(result.body.failedCount,0);assert.equal(result.body.candidateCount,1);assert.deepEqual(db.reads.at(-1),[3]);}
 }finally{Date.now=now;}
 assert.equal(JSON.stringify(rows.slice(0,2)),original);assert.deepEqual(executions,[]);assert.deepEqual(previews,[3,3,3]);
 // An administrator's existing edit-completion path clears the error and requeues.
 const admin=read('app/api/admin/sales/receipts/[id]/route.ts');
 assert.match(admin,/inventory_deduction_auto_eligible_at: completedAt,[\s\S]{0,240}inventory_deduction_processing_error: null/);
 Object.assign(rows[0],{inventory_deduction_processing_error:null,inventory_deduction_reprocess_required:true,inventory_deduction_last_checked_at:null});
 assert.equal(classify(rows[0]).operationType,'reprocess_modified');assert.equal(classify(rows[0]).canExecute,true);
 await runSalesDeductionCron({businessDate:'2026-11-02',actor:{id:1,username:'owner'}});
 assert.deepEqual(executions,[1]);assert.equal(rows[1].inventory_deduction_processing_error,REASON);
});
