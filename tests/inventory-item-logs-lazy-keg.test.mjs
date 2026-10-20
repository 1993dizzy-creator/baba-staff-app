import assert from 'node:assert/strict';
import test from 'node:test';
import {writeFileSync,mkdirSync} from 'node:fs';
import {fixture,database,route,call} from './helpers/inventory-item-logs-fixture.mjs';
// Compare the preserved full-enrichment path with the deferred path on read-only fixtures.
test('L3/L4 50-record histories preserve saved sessions and exact detail while deferring POS reads',async()=>{
 const results=[];mkdirSync('.qa-review/keg-logs',{recursive:true});
 for(const code of ['L3','L4']){
  const {itemId,tables}=fixture(code,50),original=JSON.stringify(tables);
  const beforeDb=database(tables,{delay:3}),afterDb=database(tables,{delay:3});
  const before=await call(route(beforeDb),itemId);
  const after=await call(route(afterDb),itemId,'?includeKegSalesBreakdown=false');
  assert.equal(before.status,200);assert.equal(after.status,200);assert.equal(after.body.data.length,50);
  assert.equal(afterDb.reads.length,2);assert.deepEqual(afterDb.reads.map(r=>r.table),['inventory_logs','inventory_keg_sessions']);
  for(const log of after.body.data){const full=before.body.data.find(r=>r.id===log.id);const{salesBreakdown:ignored,salesBreakdownMismatch,...base}=full.previousKegSummary;assert.ok(ignored);assert.equal(typeof salesBreakdownMismatch,'boolean');const{salesBreakdownMismatch:pending,...saved}=log.previousKegSummary;assert.equal(pending,false);assert.deepEqual(saved,base);}
  const detailDb=database(tables,{delay:3}),detail=await call(route(detailDb),itemId,'?kegLogId=10000');
  assert.equal(detail.status,200);assert.equal(detail.body.logId,10000);assert.equal(detail.body.itemId,itemId);
  assert.deepEqual(detail.body.summary,before.body.data.find(r=>r.id===10000).previousKegSummary);assert.equal(detail.body.summary.salesBreakdownMismatch,true);
  const legacy=await call(route(database(tables)),itemId);assert.deepEqual(legacy.body,before.body);
  assert.equal(JSON.stringify(tables),original);
  const result={code,records:50,httpInitialBefore:1,httpInitialAfter:1,httpWithOneDetailAfter:2,before:{ms:before.ms,queries:beforeDb.reads.length,queryMs:beforeDb.reads.reduce((s,r)=>s+r.ms,0),bytes:before.bytes},after:{ms:after.ms,queries:afterDb.reads.length,queryMs:afterDb.reads.reduce((s,r)=>s+r.ms,0),bytes:after.bytes},detail:{ms:detail.ms,queries:detailDb.reads.length,bytes:detail.bytes}};
  results.push(result);writeFileSync('.qa-review/keg-logs/'+code+'-responses.json',JSON.stringify({before:before.body,after:after.body,detail:detail.body,timing:result}));console.log(JSON.stringify(result));
 }
 writeFileSync('.qa-review/keg-logs/api-benchmark.json',JSON.stringify(results,null,2));
});

test('ordinary/empty logs avoid Keg reads; auth, item ownership, malformed ids, and failures stay explicit',async()=>{
 const {itemId,tables}=fixture('L3',2);
 const normal={...tables,inventory_logs:[{id:1,item_id:8,source:'edit_form',created_at:'2026-10-01'}]};
 for(const id of [8,9]){const db=database(normal);const r=await call(route(db),id,'?includeKegSalesBreakdown=false');assert.equal(r.status,200);assert.equal(r.body.data.length,id===8?1:0);assert.equal(db.reads.length,1);}
 for(const query of ['?kegLogId=0','?kegLogId=-1','?kegLogId=NaN','?kegLogId=1.5']){const db=database(tables);assert.equal((await call(route(db),itemId,query)).status,400);assert.equal(db.reads.length,0);}
 const denied=database(tables);assert.equal((await call(route(denied,{authenticated:false}),itemId,'?kegLogId=10000')).status,401);assert.equal(denied.reads.length,0);
 const other=database(tables);assert.equal((await call(route(other),4,'?kegLogId=10000')).status,404);assert.equal(other.reads.length,1);
 assert.equal((await call(route(database(normal)),8,'?kegLogId=1')).status,404);
 const oldError=console.error;console.error=()=>{};
 try{assert.equal((await call(route(database(tables,{failTable:'inventory_logs'})),itemId,'?includeKegSalesBreakdown=false')).status,500);assert.equal((await call(route(database(tables,{failTable:'pos_products'})),itemId,'?kegLogId=10000')).status,503);}finally{console.error=oldError;}
 const zero={...tables,inventory_keg_sessions:tables.inventory_keg_sessions.map(r=>({...r,sold_quantity:0}))};const db=database(zero);const r=await call(route(db),itemId,'?kegLogId=10000');assert.equal(r.status,200);assert.equal(r.body.summary.soldMl,0);assert.equal(db.reads.length,2);
 const first={...tables,inventory_keg_sessions:[]};assert.equal((await call(route(database(first)),itemId,'?kegLogId=10000')).status,404);
});
