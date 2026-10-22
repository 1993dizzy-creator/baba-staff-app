import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { inventoryDisplayOverlay } from '../lib/inventory/ledger-sync-contract.ts';
import { entriesTables } from './helpers/ledger-entries-tables.mjs';
const code = ts.transpileModule(readFileSync('lib/ledger/inventory-display.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
function displayFor(db) {
 const target={exports:{}};
 new Function('require','module','exports',code)(name=>{
  if(name==='server-only')return {};
  if(name==='@/lib/supabase/server')return {supabaseServer:db};
  if(name==='@/lib/inventory/ledger-sync-contract')return {inventoryDisplayOverlay};
  if(name==='./purchase-case-loader')return {};
  throw Error('Unexpected import '+name);
 },target,target.exports);
 return target.exports.withInventoryDisplay;
}
// Extend the shared fixture only in memory; run the actual display helper.
const fixtureUrl=new URL('./helpers/ledger-entries-api-fixture.mjs',import.meta.url);
const fixture=readFileSync(fixtureUrl,'utf8')
 .replace("from 'typescript'", `from '${import.meta.resolve('typescript')}'`)
 .replace('createRequire(import.meta.url)',`createRequire(${JSON.stringify(fixtureUrl.href)})`)
 .replace('denied = false }','denied = false, inventoryDisplayFactory }')
 .replace('  for (const name of [',`  if(inventoryDisplayFactory){
   const display=inventoryDisplayFactory(db);
   dependencies['@/lib/ledger/inventory-display'].withInventoryDisplay=(...args)=>{
    spies.displayConcurrency=args[1]?.concurrency;return display(...args);
   };
  }
  for (const name of [`);
const {entriesApi}=await import('data:text/javascript;base64,'+Buffer.from(fixture).toString('base64'));
function mockDb({failAt=-1,rejectAt=-1,empty=false}={}) {
 const state={calls:[],completed:[],active:0,max:0},failure=new Error('READ_FAILED');
 const db={from(table){
  const call={table,filters:[]};
  const query={
   select(columns){call.columns=columns;return query;},
   eq(column,value){call.filters.push([column,value]);return query;},
   in(column,ids){call.column=column;call.ids=ids;return query;},
   async then(resolve,reject){
    const index=state.calls.length;state.calls.push(call);state.active++;state.max=Math.max(state.max,state.active);
    await new Promise(done=>setTimeout(done,index%2===0?15:1));
    state.active--;state.completed.push(index);
    if(index===rejectAt)return reject(failure);
    if(index===failAt)return resolve({data:null,error:failure});
    return resolve({error:null,data:empty?null:call.ids.map(id=>table==='inventory_logs'
     ?{id,new_supplier:id%2?' 공급처 / Nhà cung cấp ':null}
     :{resolved_transaction_id:id,source_drift_snapshot:{item_name:`정정 ${id} / ${index}`,purchase_amount:id*17+index}})});
   },
  };return query;
 }};return {db,state,failure};
}
const rowsFor=count=>Array.from({length:count},(_,i)=>({id:i===400?1:i+1,source_snapshot:{inventory_log_id:i%1003+1,supplier:'증거',purchase_amount:i+100}}));
test('1201 rows: identical queries/output, bounded concurrency, reordered completion, immutable evidence',async()=>{
 const rows=rowsFor(1201),before=structuredClone(rows),serial=mockDb(),parallel=mockDb();
 const expected=await displayFor(serial.db)(rows),actual=await displayFor(parallel.db)(rows,{concurrency:2});
 assert.deepEqual(actual,expected);assert.deepEqual(rows,before);assert.equal(actual[0].display_snapshot.item_name,"정정 1 / 2");assert.equal(actual[0].display_snapshot.purchase_amount,100);
 assert.deepEqual(actual.map(r=>r.id),rows.map(r=>r.id));assert.deepEqual(parallel.state.calls,serial.state.calls);
 assert.equal(serial.state.calls.length,13);assert.equal(serial.state.max,1);assert.equal(parallel.state.max,2);
 assert.notDeepEqual(parallel.state.completed,serial.state.completed);
 assert.ok(parallel.state.calls.every(c=>c.ids.length<=200));
 assert.equal(parallel.state.calls.filter(c=>c.table==='inventory_logs').flatMap(c=>c.ids).length,1003);
 actual.forEach((row,i)=>assert.equal(row.source_snapshot,rows[i].source_snapshot));
});
test('empty input has no reads; null/empty results preserve all rows',async()=>{
 const {db,state}=mockDb({empty:true}),display=displayFor(db);
 assert.deepEqual(await display([],{concurrency:2}),[]);assert.equal(state.calls.length,0);
 const rows=rowsFor(401);assert.deepEqual(await display(rows,{concurrency:2}),rows);
});
for(const concurrency of [1,2])for(const failureIndex of [2,8])for(const mode of ['failAt','rejectAt'])test(`${mode}, concurrency ${concurrency}, read ${failureIndex}: fail closed, drain reads, stop scheduling`,async()=>{
 const {db,state,failure}=mockDb({[mode]:failureIndex}),rows=rowsFor(1201),before=structuredClone(rows);
 await assert.rejects(displayFor(db)(rows,{concurrency}),error=>error===failure);
 assert.equal(state.active,0);assert.ok(state.calls.length<13);
 const completed=state.completed.length;await new Promise(done=>setTimeout(done,25));
 assert.equal(state.completed.length,completed);assert.deepEqual(rows,before);
});
for(const month of ['2026-08','2026-09','2026-10'])test(`${month}: full response/amount/query parity, real helper, 1000+ transactions, other scopes serial`,async()=>{
 const tables=entriesTables(1001),before=structuredClone(tables),source=readFileSync('app/api/admin/ledger/route.ts','utf8');
 const serial=entriesApi(tables,{inventoryDisplayFactory:displayFor,source:source.replace('entriesOnly ? 2 : 1','1')});
 const parallel=entriesApi(tables,{inventoryDisplayFactory:displayFor});
 const left=await serial.get(month,'&scope=entries'),right=await parallel.get(month,'&scope=entries');
 assert.equal(left.status,200);assert.equal(right.status,200);assert.deepEqual(await right.json(),await left.json());
 const signatures=api=>api.calls.map(c=>JSON.stringify(c)).sort();
 assert.deepEqual(signatures(parallel),signatures(serial));assert.deepEqual(tables,before);assert.equal(parallel.spies.displayConcurrency,2);
 const full=entriesApi(tables,{inventoryDisplayFactory:displayFor});assert.equal((await full.get(month)).status,200);assert.equal(full.spies.displayConcurrency,1);
});




for(const mode of ['failAt','rejectAt'])test(`Entries GET returns whole-response 500 on display ${mode}`,async()=>{
 const failing=mockDb({[mode]:0});
 const api=entriesApi(entriesTables(1001),{inventoryDisplayFactory:()=>displayFor(failing.db)});
 const response=await api.get('2026-10','&scope=entries');
 assert.equal(response.status,500);assert.deepEqual(await response.json(),{ok:false,code:'LEDGER_LOAD_FAILED'});
 assert.equal(failing.state.active,0);
});
