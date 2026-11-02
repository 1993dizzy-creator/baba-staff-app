import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import ts from 'typescript';
import { nativeInventoryPostgres } from './helpers/inventory-native-postgres.mjs';
import { initializeShadow, readMigration } from './helpers/pos-shadow-fixture.mjs';
function load(path,deps={}) {
 const m={exports:{}};
 const c=ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},reportDiagnostics:true});
 assert.deepEqual(c.diagnostics,[]);
 new Function('require','module','exports',c.outputText)(name=>{assert.ok(name in deps,'Unexpected dependency: '+name);return deps[name];},m,m.exports);
 return m.exports;
}
const compare=load('lib/pos/cukcuk/sales-receipt-sync-compare.ts');
const payment=load('lib/pos/cukcuk/payment-snapshot.ts');
const collection=load('lib/pos/cukcuk/reliable-collection.ts',{'node:crypto':{createHash},'./sales-receipt-sync-compare':compare,'./payment-snapshot':payment});
const ingestion=load('lib/pos/cukcuk/reliable-ingestion.ts',{'node:crypto':{randomUUID},'./reliable-collection':collection});
const adapter=load('lib/pos/cukcuk/sales-receipt-sync.ts',{
 '@/lib/supabase/server':{supabaseServer:{}},'@/lib/pos/cukcuk/sales-receipt-inventory-change':{},
 '@/lib/pos/cukcuk/sales-receipt-sync-compare':compare,'@/lib/pos/cukcuk/payment-snapshot':payment,
});
const branch='synthetic-branch',scope='a'.repeat(64)+':'+branch;
const window={businessDate:'2026-10-09',collectionFrom:'2026-10-09T09:00:00Z',collectionTo:'2026-10-10T03:00:00Z',settingSource:'configured'};
const sample=(ref='glen-2601006796',quantity=1,status=3)=>({RefID:ref,BranchID:branch,RefDate:'2026-10-09T20:01:00+07:00',RefNo:'2601006796-synthetic',
 PaymentStatus:status,FinalAmount:100,ModifiedDate:'2026-10-09T20:01:15+07:00',
 SAInvoiceDetails:[{RefDetailID:'line-'+ref,ItemCode:'TEST',ItemName:'Synthetic Glenfiddich 15',Quantity:quantity,UnitPrice:100,Amount:100}],
 SAInvoicePayments:status===3?[{SAInvoicePaymentID:'pay-'+ref,PaymentType:1,PaymentName:'cash',Amount:100}]:[]});
const mockSource=(rows,changes={})=>({
 page:async(page,limit=2)=>({Success:true,Total:rows.length,Data:rows.slice((page-1)*limit,page*limit)}),
 detail:async ref=>({Success:true,Data:structuredClone(rows.find(row=>row.RefID===ref))}),...changes,
});
const encode=(item,w,at)=>{
 const receipt=adapter.buildReceiptRow({invoice:item.invoice,detailPayload:item.detail,businessDate:w.businessDate,syncedAt:at});
 receipt.ref_id=item.refId;receipt.branch_id=branch;
 return {contentHash:item.hash,receipt,lines:adapter.getDetailsFromInvoicePayload(item.detail).map((detail,i)=>adapter.buildLineRow({receiptId:null,receiptRefId:item.refId,detail,businessDate:w.businessDate,refDate:receipt.ref_date,paymentStatus:receipt.payment_status,isCanceled:receipt.is_canceled,sortOrder:i+1,syncedAt:at})),
 payments:adapter.getPaymentsFromInvoicePayload(item.detail).map(p=>adapter.buildPaymentRow({receiptId:null,receiptRefId:item.refId,businessDate:w.businessDate,refDate:receipt.ref_date,payment:p,syncedAt:at}))};
};
const scan=(source,options={})=>collection.collectStableInvoices({branchId:branch,from:window.collectionFrom,to:window.collectionTo,limit:2,...source,...options});
test('all pages, unfiltered Total and two count/amount/hash manifests agree',async()=>{
 const rows=[sample('a'),sample('b'),sample('c')];rows[2].RefDate='2026-10-12T20:00:00+07:00';
 const calls=[];const source=mockSource(rows);const first=source.page;
 source.page=async n=>{calls.push(n);return first(n);};
 const result=await scan(source);assert.deepEqual(calls,[1,2,1,2]);assert.equal(result.first.total,3);assert.equal(result.first.count,3);
 assert.equal(result.first.amount,300);assert.equal(result.first.hash,result.second.hash);assert.equal(result.automaticConfirmation,false);
 const empty=await scan(mockSource([]));assert.equal(empty.first.total,0);assert.equal(empty.first.pages,1);
});
test('middle-page failure, duplicates, repeated page, changing Total and missing identity fail closed',async()=>{
 for(const mode of ['failure','duplicate','total','short','identity']){
  const source=mockSource([sample('a'),sample('b'),sample('c')]);const original=source.page;
  source.page=async n=>{const r=await original(n);if(n===2){if(mode==='failure')throw Error('synthetic timeout');if(mode==='duplicate')r.Data=[sample('a')];if(mode==='total')r.Total=4;if(mode==='short')r.Data=[];if(mode==='identity')delete r.Data[0].RefID;}return r;};
  await assert.rejects(scan(source));
 }
});
test('detail mismatch, absent lines/payments, offsetless time, unstable same-count content are not complete',async()=>{
 for(const mode of ['identity','line','payment','time','changed']){
  const row=sample('a');const source=mockSource([row]);let call=0;
  source.detail=async()=>{const detail=structuredClone(row);call++;if(mode==='identity')detail.RefID='other';if(mode==='line')delete detail.SAInvoiceDetails;if(mode==='payment')delete detail.SAInvoicePayments;if(mode==='changed'&&call===2)detail.SAInvoiceDetails[0].Quantity=2;return {Success:true,Data:detail};};
  if(mode==='time')row.RefDate='2026-10-09T20:01:00';await assert.rejects(scan(source));
 }
});
test('documented child-only detail uses verified child RefIDs and list TotalAmount',async()=>{
 const row=sample('child-only');row.TotalAmount=row.FinalAmount;delete row.FinalAmount;
 const detail={SAInvoiceDetails:row.SAInvoiceDetails.map(l=>({...l,RefID:row.RefID})),SAInvoicePayments:row.SAInvoicePayments.map(p=>({...p,RefID:row.RefID}))};
 const result=await scan(mockSource([row],{detail:async()=>({Success:true,Data:detail})}));assert.equal(result.first.amount,100);
 assert.equal(encode(result.second.invoices[0],window,'2026-10-12T12:00:00Z').receipt.final_amount,100);
 detail.SAInvoicePayments[0].RefID='other';await assert.rejects(scan(mockSource([row],{detail:async()=>({Success:true,Data:detail})})),e=>e.code==='detail_identity_mismatch');
});
test('recovery covers recent seven business dates plus older outage gaps, with no inferred deletion',()=>{
 const dates=collection.recoveryBusinessDates('2026-11-02',7,['2026-10-09','2026-10-09']);
 assert.equal(dates.length,8);assert.equal(dates[0],'2026-10-09');assert.equal(dates.at(-1),'2026-11-02');
 for(const args of [['2026-02-30'],['2026-11-02',15],['2026-11-02',7,['2026-11-03']]])assert.throws(()=>collection.recoveryBusinessDates(...args));
});
test('network deadline and HTTP failures expose no provider payload',async()=>{
 const original=global.fetch;
 try{
  global.fetch=async(_url,init)=>{assert.ok(init.signal);throw new DOMException('synthetic token secret','TimeoutError');};
  await assert.rejects(ingestion.fetchCollectionJson('https://example.invalid',{},1),e=>e.code==='provider_timeout_or_response_failure'&&!e.message.includes('secret'));
  global.fetch=async()=>new Response('sensitive upstream body',{status:500});
  await assert.rejects(ingestion.fetchCollectionJson('https://example.invalid',{}),e=>e.code==='provider_http_failure');
 }finally{global.fetch=original;}
});
test('admin resolution API uses authenticated actor, stays disabled by default, and hides SQL details',async()=>{
 const previous=process.env.POS_CUKCUK_RELIABLE_INGESTION;let allowed=true,calls=[],fail=false;
 const route=load('app/api/admin/sales/ingestion/route.ts',{
  'next/server':{NextResponse:{json:(body,options)=>Response.json(body,options)}},
  '@/lib/auth/server-auth':{requireRole:async roles=>{assert.deepEqual(roles,['owner','master']);return allowed?{ok:true,actor:{id:1}}:{ok:false,code:'FORBIDDEN',status:403};}},
  '@/lib/supabase/server':{supabaseServer:{rpc:async(name,args)=>{calls.push({name,args});return fail?{error:{code:'40001',details:'secret SQL row'}}:{data:{status:'resolved'}};}}},
 });
 const request=body=>route.POST(new Request('http://localhost/api/admin/sales/ingestion',{method:'POST',body:JSON.stringify(body)}));
 const body={action:'resolve',snapshotId:1,expectedHead:null,expectedCanonicalHash:'a'.repeat(32),evidence:'synthetic authoritative snapshot',actorId:999};
 try{
  delete process.env.POS_CUKCUK_RELIABLE_INGESTION;assert.equal((await request(body)).status,409);assert.equal(calls.length,0);
  process.env.POS_CUKCUK_RELIABLE_INGESTION='enabled';allowed=false;assert.equal((await request(body)).status,403);allowed=true;
  assert.equal((await request({...body,expectedCanonicalHash:'bad'})).status,400);
  assert.equal((await request(body)).status,200);assert.equal(calls[0].args.p_actor_id,1);
  fail=true;const error=await request(body);assert.equal(error.status,409);assert.doesNotMatch(JSON.stringify(await error.json()),/secret SQL/);
 }finally{if(previous===undefined)delete process.env.POS_CUKCUK_RELIABLE_INGESTION;else process.env.POS_CUKCUK_RELIABLE_INGESTION=previous;}
});
test('server adapter resolves configured business date, serial recovery dates, and actual paging/detail contract',async()=>{
 const runs=[],http=[];let fail=false;
 const server=load('lib/pos/cukcuk/reliable-ingestion-server.ts',{
  'server-only':{},'node:crypto':{createHash},'next/server':{NextResponse:{json:(body,options)=>Response.json(body,options)}},
  '@/lib/pos/cukcuk/auth':{loginCukcuk:async()=>({accessToken:'synthetic-noncredential',companyCode:'synthetic-company'})},
  '@/lib/supabase/server':{supabaseServer:{rpc:async()=>({data:{}})}},
  '@/lib/pos/cukcuk/sales-receipt-sync':adapter,'./reliable-collection':collection,
  './reliable-ingestion':{...ingestion,fetchCollectionJson:async(url,init)=>{http.push({url,init});return {Success:true,Data:[]};},runReliableIngestion:async(input,deps)=>{
   runs.push(input);if(fail)throw new collection.CollectionError('page_total_changed');
   await deps.page(2,50,input.window.collectionFrom);await deps.detail('ref-ID');
   const row=sample(),encoded=deps.encode({refId:row.RefID,invoice:row,detail:row,hash:'b'.repeat(64)},input.window,'2026-10-12T12:00:00Z');
   assert.equal(encoded.receipt.ref_id,row.RefID);assert.equal(encoded.sourceMetadata.providerSequenceVerified,false);
   return {status:'committed',syncRunId:123,businessDate:input.window.businessDate};
  }},
 });
 const resolve=async date=>({...window,businessDate:date||'2026-11-02'});
 const call=body=>server.handleReliableSalesSync(new Request('http://localhost/sync',{method:'POST',body:JSON.stringify(body)}),resolve);
 const normal=await call({branchId:branch});assert.equal(normal.status,200);assert.equal((await normal.json()).ok,true);assert.equal(runs[0].window.businessDate,'2026-11-02');
 assert.equal(JSON.parse(http[0].init.body).Page,2);assert.equal(JSON.parse(http[0].init.body).Limit,50);assert.match(http[1].url,/\/api\/v1\/sainvoices\/detail\/ref-ID$/);
 runs.length=0;await call({branchId:branch,recover:true,recentDays:2,gapDates:['2026-10-09']});assert.deepEqual(runs.map(r=>r.window.businessDate),['2026-10-09','2026-11-01','2026-11-02']);
 fail=true;const response=await call({branchId:branch});assert.equal(response.status,502);assert.equal((await response.json()).code,'page_total_changed');
});
test('existing sync entry point checks POS secret before dispatching the enabled engine',async()=>{
 const previous=process.env.POS_CUKCUK_RELIABLE_INGESTION;let blocked=true,calls=0;
 const route=load('app/api/pos/cukcuk/sainvoices/sync-to-sales/route.ts',{
  'next/server':{NextResponse:{json:(b,o)=>Response.json(b,o)}},'@/lib/pos/cukcuk/auth':{},
  '@/lib/pos/api-guard':{requirePosAdminSecret:()=>blocked?new Response(null,{status:401}):null},
  '@/lib/common/business-time':{},'@/lib/store-settings/business-time-adapter':{},'@/lib/store-settings/business-time-adapter-core':{},
  '@/lib/supabase/server':{},'@/lib/pos/cukcuk/sales-receipt-sync':{},'@/lib/pos/cukcuk/sales-sync-completeness':{},'@/lib/ledger/pos-sales':{},
  '@/lib/pos/cukcuk/reliable-ingestion-server':{handleReliableSalesSync:async(_req,resolve)=>{calls++;assert.equal(typeof resolve,'function');return Response.json({ok:true});}},
 });
 try{process.env.POS_CUKCUK_RELIABLE_INGESTION='enabled';assert.equal((await route.POST(new Request('http://localhost/sync',{method:'POST'}))).status,401);assert.equal(calls,0);
  blocked=false;assert.equal((await route.POST(new Request('http://localhost/sync',{method:'POST'}))).status,200);assert.equal(calls,1);
 }finally{if(previous===undefined)delete process.env.POS_CUKCUK_RELIABLE_INGESTION;else process.env.POS_CUKCUK_RELIABLE_INGESTION=previous;}
});

test('reliable intake on disposable PostgreSQL: atomicity, fencing, observations, recovery',{timeout:120000},async t=>{
 const rt=await nativeInventoryPostgres({testContext:t}),db=new rt.Database();
 try{
  await initializeShadow(db);
  // Add original sync-adapter columns absent from this focused historical fixture.
  await db.exec(`create sequence intake_receipt_ids start 1000;alter table pos_sales_receipts alter column id set default nextval('intake_receipt_ids');
   alter table pos_sales_receipts add column if not exists branch_id text,add column if not exists branch_code text,add column if not exists branch_name text,
    add column if not exists customer_name text,add column if not exists table_name text,add column if not exists synced_at timestamptz;
   alter table pos_sales_receipt_lines add column if not exists source text default 'cukcuk',add column if not exists ref_detail_id text,
    add column if not exists parent_ref_detail_id text,add column if not exists business_date date,add column if not exists ref_date timestamptz,
    add column if not exists sort_order integer,add column if not exists item_id text,add column if not exists unit_id text,
    add column if not exists inventory_item_type integer,add column if not exists synced_at timestamptz;
   create unique index intake_receipt_identity on pos_sales_receipts(source,ref_id);
   create unique index intake_line_identity on pos_sales_receipt_lines(source,receipt_ref_id,ref_detail_id);
   update pos_sales_receipts set branch_id='other-fixture-branch';
   create sequence intake_sync_ids start 1000;alter table pos_sales_sync_runs alter column id set default nextval('intake_sync_ids');
   alter table pos_sales_sync_runs add column branch_id text,add column request_params jsonb,
    add column receipt_count integer,add column line_count integer,add column created_count integer,add column updated_count integer,add column canceled_count integer;
  `);
  const paymentSql=readMigration('20261016180852_fix_pos_payment_snapshot_replacement.sql');
  // Payment RPC already has independent production-definition preflight tests;
  // this fixture installs just its final reviewed function body, not migration history.
  await db.exec(paymentSql.slice(paymentSql.indexOf('create or replace function')));
  const protectedState=async()=>{
   const state={};for(const table of ['inventory','inventory_logs','pos_inventory_deductions','pos_inventory_deduction_receipts','pos_inventory_deduction_batches','pos_sales_receipt_modifications'])state[table]=(await db.query('select to_jsonb(t) r from '+table+' t order by id')).rows;
   state.functions=(await db.query("select oid,prosrc,proacl::text from pg_proc where proname in ('guard_pos_inventory_stock_check_boundary','reprocess_modified_sales_inventory_deduction_receipt','apply_sales_inventory_deduction_batch','rollback_canceled_sales_inventory_deduction_receipt') order by oid")).rows;
   return state;
  };
  const before=await protectedState();await db.exec(readMigration('20261102113150_pos_reliable_cukcuk_ingestion.sql'));assert.deepEqual(await protectedState(),before);
  const rpcFor=client=>async(name,args)=>{
   const entries=Object.entries(args);return (await client.query('select public.'+name+'('+entries.map(([key],i)=>key+'=> $'+(i+1)).join(',')+') r',entries.map(([,v])=>typeof v==='object'&&v!==null?JSON.stringify(v):v))).rows[0].r;
  };
  const rpc=rpcFor(db),run=(rows,extra={},dependencies={})=>ingestion.runReliableIngestion({scope,branchId:branch,window,limit:2,...extra},{...mockSource(rows),rpc,encode,...dependencies});
  const inspect=async()=>rpc('pos_ingest_inspect',{p_scope:scope,p_since:'2026-10-01'});
  const canonical=async ref=>(await db.query('select r.*, (select jsonb_agg(l order by id) from pos_sales_receipt_lines l where l.receipt_id=r.id) lines from pos_sales_receipts r where ref_id=$1',[ref])).rows[0];
  await t.test('full snapshot and completion commit together; same receipt received 55 times has one version',async()=>{
   const row=sample();const r=await run([row]);assert.equal(r.acceptedCount,1);assert.equal(r.projectionComplete,true);assert.equal(r.sourceComplete,false);assert.equal(r.shadowSourceComplete,false);
   const original=await canonical(row.RefID);
   for(let i=0;i<55;i++){const duplicate=await run([row]);assert.equal(duplicate.duplicateCount,1);}
   assert.deepEqual(await canonical(row.RefID),original);
   assert.equal((await db.query('select count(*) n from pos_ingest_private.snapshots')).rows[0].n,'1');
   assert.equal((await db.query('select count(*) n from pos_inventory_deduction_batches')).rows[0].n,'0');
  });
  await t.test('Glenfiddich shot-to-bottle edit repeated 55 times retains one pending version and no preview batch',async()=>{
   const original=sample('glen-modified-55',0.0714);await run([original]);const beforeEdit=await canonical(original.RefID);
   const bottle=sample(original.RefID,1);
   for(let i=0;i<55;i++){const result=await run([bottle]);assert.equal(result.uncertainCount,1);assert.equal(result.acceptedCount,0);}
   assert.deepEqual(await canonical(original.RefID),beforeEdit);
   assert.equal((await db.query('select count(*) n from pos_ingest_private.snapshots where ref_id=$1',[original.RefID])).rows[0].n,'2');
   assert.equal((await db.query('select count(*) n from pos_inventory_deduction_batches')).rows[0].n,'0');
   const candidate=(await inspect()).holds.find(h=>h.refId===original.RefID);
   await rpc('pos_ingest_resolve',{p_snapshot_id:candidate.snapshotId,p_expected_head:candidate.expectedHead,p_expected_canonical_hash:candidate.expectedCanonicalHash,p_actor_id:1,p_evidence:'synthetic Oct 9 authoritative export: bottle sale replaces shot'});
   assert.equal((await canonical(original.RefID)).lines[0].quantity,1);
   assert.equal(Number((await db.query('select quantity from inventory where id=1')).rows[0].quantity),0.03);
  });
  await t.test('payment failure rolls back header, lines, observations and completion, then retry succeeds',async()=>{
   const row=sample('rollback');row.SAInvoicePayments[0].Amount=99;
   await assert.rejects(run([row]),e=>e.code==='persistence_failed');assert.equal(await canonical(row.RefID),undefined);
   assert.equal((await db.query("select count(*) n from pos_ingest_private.snapshots where ref_id='rollback'")).rows[0].n,'0');
   const history=await inspect();assert.ok(history.runs.some(r=>r.status==='failed'&&r.failureCode==='persistence_failed'));
   row.SAInvoicePayments[0].Amount=100;assert.equal((await run([row])).acceptedCount,1);
  });
  await t.test('last receipt failure rolls back earlier receipts in the same run',async()=>{
   const good=sample('batch-good'),bad=sample('batch-invalid');bad.SAInvoicePayments[0].Amount=1;
   await assert.rejects(run([good,bad]));assert.equal(await canonical(good.RefID),undefined);assert.equal(await canonical(bad.RefID),undefined);
  });
  await t.test('middle page failure has no partial records and a later full rescan recovers the missed day',async()=>{
   const rows=[sample('recovery-a'),sample('recovery-b'),sample('recovery-c')];
   await assert.rejects(run(rows,{}, {page:async n=>{if(n===2)throw Error('synthetic outage');return {Success:true,Total:3,Data:rows.slice(0,2)};}}));
   assert.equal(await canonical('recovery-a'),undefined);assert.equal((await run(rows)).acceptedCount,3);
  });
  await t.test('late old response, edit/cancel reversal and same-count edits remain observed holds until CAS confirmation',async()=>{
   const row=sample('ordering');await run([row]);const original=await canonical(row.RefID);
   const cancel=sample(row.RefID,2,4);cancel.ModifiedDate='2025-01-01T00:00:00Z';
   for(const value of [cancel,sample(row.RefID,3),cancel]){const r=await run([value]);assert.equal(r.uncertainCount,1);assert.equal(r.sourceComplete,false);}
   assert.deepEqual(await canonical(row.RefID),original);
   let state=await inspect();const hold=state.holds.find(h=>h.refId===row.RefID&&h.contentHash===collection.contentHash({invoice:cancel,detail:cancel}));assert.ok(hold);
   const args={p_snapshot_id:hold.snapshotId,p_expected_head:hold.expectedHead,p_expected_canonical_hash:hold.expectedCanonicalHash,p_actor_id:1,p_evidence:'synthetic provider export reviewed as current cancellation'};
   const resolved=await rpc('pos_ingest_resolve',args);assert.deepEqual(await rpc('pos_ingest_resolve',args),resolved);
   assert.equal((await canonical(row.RefID)).payment_status,4);
   await run([row]);assert.equal((await canonical(row.RefID)).payment_status,4);
   state=await inspect();const stale=state.holds.find(h=>h.refId===row.RefID&&h.contentHash===collection.contentHash({invoice:row,detail:row}));
   await assert.rejects(rpc('pos_ingest_resolve',{...args,p_snapshot_id:stale.snapshotId}),e=>e.code==='40001');
  });
  await t.test('local admin modification, notes and prior canonical change defeat stale approval',async()=>{
   const row=sample('admin');await run([row]);const changed=sample('admin',5);await run([changed]);
   const h=(await inspect()).holds.find(h=>h.refId==='admin');const id=(await canonical('admin')).id;
   await db.query('update pos_sales_receipts set is_modified=true,revision=revision+1 where id=$1',[id]);
   const baseline=await canonical('admin');assert.equal((await run([changed])).uncertainCount,1);assert.deepEqual(await canonical('admin'),baseline);
   await assert.rejects(rpc('pos_ingest_resolve',{p_snapshot_id:h.snapshotId,p_expected_head:h.expectedHead,p_expected_canonical_hash:h.expectedCanonicalHash,p_actor_id:1,p_evidence:'synthetic confirmed snapshot'}),e=>e.code==='40001');
   const current=(await inspect()).holds.find(x=>x.snapshotId===h.snapshotId);
   await assert.rejects(rpc('pos_ingest_resolve',{p_snapshot_id:h.snapshotId,p_expected_head:current.expectedHead,p_expected_canonical_hash:current.expectedCanonicalHash,p_actor_id:1,p_evidence:'synthetic confirmed snapshot'}),e=>e.code==='55000');
  });
  await t.test('response loss replays one committed result and cannot turn completion into failure',async()=>{
   let lost=false;const row=sample('response-loss');const result=await run([row],{}, {rpc:async(name,args)=>{const r=await rpc(name,args);if(name==='pos_ingest_commit'&&!lost){lost=true;throw Error('lost response');}return r;}});
   assert.equal(result.acceptedCount,1);assert.equal((await inspect()).runs.find(r=>r.runId===result.runId).status,'committed');
  });
  await t.test('committed immutable request rejects a different payload, and failure callback preserves success',async()=>{
   let commitArgs;const result=await run([sample('immutable')],{}, {rpc:async(name,args)=>{if(name==='pos_ingest_commit')commitArgs=structuredClone(args);return rpc(name,args);}});
   assert.deepEqual(await rpc('pos_ingest_commit',commitArgs),result);
   await assert.rejects(rpc('pos_ingest_commit',{...commitArgs,p_snapshots:[]}),e=>e.code==='22023');
   await rpc('pos_ingest_fail',{p_run_id:commitArgs.p_run_id,p_owner_token:commitArgs.p_owner_token,p_code:'persistence_failed'});
   assert.equal((await inspect()).runs.find(r=>r.runId===result.runId).status,'committed');
   assert.equal((await db.query('select source_complete from pos_sales_sync_runs where id=$1',[result.syncRunId])).rows[0].source_complete,false);
  });
  await t.test('missing previously collected IDs are reported without cancellation or deletion',async()=>{
   const row=await canonical('immutable'),result=await run([sample('replacement')]);assert.ok(result.localMissingCount>0);assert.equal(result.projectionComplete,false);
   const state=await inspect(),r=state.runs.find(r=>r.runId===result.runId);assert.ok(r.manifest.localMissingReceiptIds.includes(Number(row.id)));
   assert.deepEqual(await canonical('immutable'),row);
  });
  await t.test('legacy baseline is captured, existing identities/exclusions remain intact on confirmed correction',async()=>{
   const row=sample('LEGACY'),s=encode({invoice:row,detail:row,refId:'legacy',hash:collection.contentHash({invoice:row,detail:row})},window,'2026-10-09T13:01:20Z');
   // Simulate the existing engine's unversioned canonical receipt, including a
   // case-variant external identity and a manual line exclusion.
   const id=(await db.query("select pos_ingest_private.publish($1,null) id",[JSON.stringify({...s,receipt:{...s.receipt,ref_id:'LEGACY'},lines:s.lines.map(l=>({...l,receipt_ref_id:'LEGACY'})),payments:s.payments.map(p=>({...p,receipt_ref_id:'LEGACY'}))})])).rows[0].id;
   await db.query('update pos_sales_receipt_lines set is_excluded=true where receipt_id=$1',[id]);
   row.RefID='legacy';row.SAInvoiceDetails[0].Quantity=2;const r=await run([row]);assert.equal(r.uncertainCount,1);
   const baseline=(await db.query('select snapshot from pos_ingest_private.baselines where receipt_id=$1',[id])).rows[0].snapshot;
   assert.equal(baseline.receipt.ref_id,'LEGACY');assert.equal(baseline.lines[0].quantity,1);
   const h=(await inspect()).holds.find(h=>h.refId==='legacy');await rpc('pos_ingest_resolve',{p_snapshot_id:h.snapshotId,p_expected_head:null,p_expected_canonical_hash:h.expectedCanonicalHash,p_actor_id:1,p_evidence:'synthetic current export including line identity confirmed'});
   const current=await canonical('LEGACY');assert.equal(current.ref_id,'LEGACY');assert.equal(current.lines[0].quantity,2);assert.equal(current.lines[0].is_excluded,true);
   assert.deepEqual((await db.query('select snapshot from pos_ingest_private.baselines where receipt_id=$1',[id])).rows[0].snapshot,baseline);
  });
  await t.test('exact legacy projection bootstraps without a manual review or canonical/eligibility writes',async()=>{
   const row=sample('legacy-exact'),s=encode({invoice:row,detail:row,refId:row.RefID,hash:collection.contentHash({invoice:row,detail:row})},window,'2026-10-09T13:01:20Z');
   await db.query('select pos_ingest_private.publish($1,null)',[JSON.stringify(s)]);
   const prior=await canonical(row.RefID);row.ModifiedDate='2026-10-12T19:00:00+07:00';
   const result=await run([row]);assert.equal(result.uncertainCount,0);assert.equal(result.duplicateCount,1);assert.deepEqual(await canonical(row.RefID),prior);
   const evidence=await rpc('pos_ingest_shadow_evidence',{p_receipt_id:prior.id});assert.equal(evidence.sourceComplete,false);assert.equal(evidence.automaticConfirmation,false);assert.equal(evidence.sourceSequence,null);assert.ok(evidence.observedVersion);
  });
  await t.test('legacy deduction cron bookkeeping does not create a new POS version or reset eligibility',async()=>{
   const row=sample('cron-bookkeeping');await run([row]);const id=(await canonical(row.RefID)).id;
   await db.query("update pos_sales_receipts set inventory_deduction_auto_eligible_at=null,inventory_deduction_last_checked_at=clock_timestamp(),inventory_deduction_pending_status='insufficient_stock' where id=$1",[id]);
   const prior=await canonical(row.RefID),result=await run([row]);assert.equal(result.duplicateCount,1);assert.equal(result.uncertainCount,0);assert.deepEqual(await canonical(row.RefID),prior);
  });
  await t.test('simultaneous workers share one scope lease; expired worker cannot publish',async()=>{
   const other=await rt.connect(db.name),otherRpc=rpcFor(other);
   const claimArgs={p_run_id:randomUUID(),p_owner_token:randomUUID(),p_scope:scope,p_branch_id:branch,p_business_date:window.businessDate,p_from:window.collectionFrom,p_to:window.collectionTo};
   const competing={...claimArgs,p_run_id:randomUUID(),p_owner_token:randomUUID()};
   const results=await Promise.all([rpc('pos_ingest_claim',claimArgs),otherRpc('pos_ingest_claim',competing)]);
   assert.deepEqual(results.map(r=>r.status).sort(),['busy','collecting']);
   const owned=results[0].status==='collecting'?claimArgs:competing;
   await db.query("update pos_ingest_private.runs set lease_until=clock_timestamp()-interval '1 second' where id=$1",[owned.p_run_id]);
   assert.equal((await run([sample('new-generation')])).acceptedCount,1);
   await assert.rejects(rpc('pos_ingest_commit',{p_run_id:owned.p_run_id,p_owner_token:owned.p_owner_token,p_manifest:{},p_snapshots:[]}),e=>e.code==='55000');
   await other.end();
  });
  await t.test('same external receipt in a different company namespace cannot merge or overwrite',async()=>{
   const prior=await canonical('immutable');await assert.rejects(run([sample('immutable')],{scope:'b'.repeat(64)+':'+branch}));assert.deepEqual(await canonical('immutable'),prior);
  });
  await t.test('private data and RPCs reject anonymous/authenticated roles; no stock/audit or P0 changes',async()=>{
   assert.equal((await db.query("select has_function_privilege('anon','public.pos_ingest_commit(uuid,uuid,jsonb,jsonb)','execute') ok")).rows[0].ok,false);
   assert.equal((await db.query("select has_function_privilege('authenticated','public.pos_ingest_resolve(bigint,bigint,text,bigint,text)','execute') ok")).rows[0].ok,false);
   assert.equal((await db.query("select has_schema_privilege('service_role','pos_ingest_private','usage') ok")).rows[0].ok,false);
   assert.deepEqual(await protectedState(),before);
  });
  await (await rt.connect('postgres')).query('checkpoint');
 }finally{await db.close();}
});
