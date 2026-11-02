import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {nativeInventoryPostgres} from './helpers/inventory-native-postgres.mjs';
import {writerFixture,item,save,apply,rows as q,installStandaloneJournal,posCandidate,applyPos,writerMetadata} from './helpers/inventory-writer-integration-fixture.mjs';
import {capture,claim,seedReceipt} from './helpers/pos-shadow-fixture.mjs';
import {billedFixture} from './helpers/inventory-billed-amount-fixture.mjs';
import {editReceipt} from './helpers/inventory-receipt-edit-fixture.mjs';
test('writer integration, signed balance, and concurrent RPCs',{timeout:120000},async t=>{
 const rt=await nativeInventoryPostgres({testContext:t}),db=new rt.Database();
 try{
  await writerFixture(db);
  const drain=async()=>(await q(db,"select inventory_writer_shadow_drain(100,'owner') r"))[0].r;
  const compare=async(id=1)=>(await q(db,"select inventory_writer_compare($1,'owner') r",[id]))[0].r;
  const proof=(at,more={})=>({effectiveAt:at,proof:'synthetic actual physical event',...more});
  await t.test('normal stock save is atomic and response-loss replay returns its original result',async()=>{
   const before=await item(db),id=randomUUID(),event=proof('2026-10-11T04:00:00Z');
   const first=await save(db,5,{request:id,event,expected:before});assert.equal(first.status,'ok');
   assert.deepEqual(await save(db,5,{request:id,event,expected:before}),first);
   assert.equal((await q(db,'select count(*) n from inventory_writer_private.events'))[0].n,'1');
   assert.equal((await item(db)).quantity,5);const delivered=await drain();assert.equal(delivered.results[0].result.result,'recorded');
   assert.equal((await compare()).comparison.bookQuantity,5);assert.equal((await compare()).automaticConfirmation,false);
  });
  await t.test('legacy RPC and correction overloads retain OIDs/ACLs and execute only a common prelude',async()=>{
   assert.deepEqual(await writerMetadata(db),db.writerOriginalCatalog);
   const contracts=await q(db,'select c.*,p.prosrc,p.proacl::text acl from inventory_writer_private.rpc_contracts c join pg_proc p on p.oid=c.function_oid');
   assert.ok(contracts.some(c=>c.name==='replace_inventory_keg'&&c.signature.includes('numeric)')));
   assert.ok(contracts.some(c=>c.name==='prepare_and_apply_sales_inventory_reprocess'));
   assert.ok(contracts.every(c=>c.prosrc===c.installed_body));
   const p0=(await q(db,"select prosrc from pg_proc where oid='guard_pos_inventory_stock_check_boundary()'::regprocedure"))[0].prosrc;
   assert.doesNotMatch(p0,/INVENTORY_WRITER_P1_2E/);
  });
  await t.test('before-count delayed correction is absorbed, after-count edits apply only the current delta, cancel is not a return',async()=>{
   const a=await capture(db,{key:'before-count',seq:1,quantity:1,time:'2026-10-09T13:01:00Z'});assert.equal(a.result,'queued');
   let leased=await claim(db);let settled=(await q(db,"select pos_shadow_settle($1,$2,'owner') r",[leased.jobId,leased.token]))[0].r;
   assert.equal(settled.items[0].currentStockDelta,0);assert.equal(settled.items[0].bookQuantity,5);
   await q(db,"update pos_sales_receipts set ref_date='2026-10-12T00:00:00Z',updated_at=clock_timestamp() where id=10");
   await capture(db,{key:'after-count',seq:2,quantity:2,time:'2026-10-12T00:00:00Z'});leased=await claim(db);
   settled=(await q(db,"select pos_shadow_settle($1,$2,'owner') r",[leased.jobId,leased.token]))[0].r;
   assert.equal(settled.items[0].currentStockDelta,-2);assert.equal(settled.items[0].bookQuantity,3);
   await capture(db,{key:'after-edit',seq:3,quantity:3,time:'2026-10-12T00:00:00Z'});leased=await claim(db);
   settled=(await q(db,"select pos_shadow_settle($1,$2,'owner') r",[leased.jobId,leased.token]))[0].r;assert.equal(settled.items[0].currentStockDelta,-1);
   await db.exec('update pos_sales_receipts set is_canceled=true,updated_at=clock_timestamp() where id=10');
   await capture(db,{key:'cancel-only',seq:4,quantity:3,time:'2026-10-12T00:00:00Z'});leased=await claim(db);
   settled=(await q(db,"select pos_shadow_settle($1,$2,'owner') r",[leased.jobId,leased.token]))[0].r;assert.equal(settled.items[0].currentStockDelta,0);
   assert.equal((await item(db)).quantity,5);
  });
  await t.test('signed shortage persists as book debt, delayed delivery is counted once, and physical return is a separate movement',async()=>{
   await seedReceipt(db,11);await db.exec("update pos_sales_receipts set ref_date='2026-10-12T01:00:00Z' where id=11");
   await capture(db,{receipt:11,key:'shortage',seq:1,quantity:8,time:'2026-10-12T01:00:00Z'});const lease=await claim(db);
   const settled=(await q(db,"select pos_shadow_settle($1,$2,'owner') r",[lease.jobId,lease.token]))[0].r;
   assert.equal(settled.items[0].bookQuantity,-6);assert.equal(settled.items[0].shortage,6);assert.equal((await item(db)).quantity,5);
   await save(db,15,{reason:'purchase',event:proof('2026-10-12T12:00:00Z')});await drain();
   assert.equal((await compare()).comparison.bookQuantity,4);assert.equal((await compare()).comparison.shortage,0);
   await save(db,16,{reason:'other',event:proof('2026-10-12T13:00:00Z',{kind:'physical_return',physicalEventRef:'return-11'})});await drain();
   assert.equal((await compare()).comparison.bookQuantity,5);
   const first=await compare();for(let i=0;i<55;i++)assert.deepEqual(await compare(),first);
   assert.equal((await item(db)).quantity,16);
  });
  await t.test('same-item simultaneous edits serialize and CAS rejects the stale save without a second event',async()=>{
   const other=await rt.connect(db.name);try{
    const before=await item(db),n=(await q(db,'select count(*) n from inventory_writer_private.events'))[0].n;
    const result=await Promise.all([save(db,17,{expected:before,reason:'other',event:proof('2026-10-12T14:00:00Z')}),save(other,18,{expected:before,reason:'other',event:proof('2026-10-12T14:00:00Z')})]);
    assert.deepEqual(result.map(r=>r.status).sort(),['inventory_conflict','ok']);
    assert.equal(Number((await q(db,'select count(*) n from inventory_writer_private.events'))[0].n),Number(n)+1);await drain();
   }finally{await other.end();}
  });
  await t.test('missing time is held once; appended evidence recovers without a quantity or source log rewrite',async()=>{
   await save(db,20,{reason:'other'});const first=await drain();assert.ok(first.results.some(r=>r.result.reason==='physical_effective_at_unproven'));
   assert.equal((await drain()).results.length,0);
   const e=(await q(db,'select * from inventory_writer_private.events order by ordinal desc limit 1'))[0],before=await item(db);
   await q(db,"select inventory_writer_attest($1,$2,'2026-10-12T15:00:00Z',$3,'owner')",[e.id,e.source_hash,{proof:'synthetic verified movement note'}]);
   assert.equal((await drain()).results[0].result.result,'recorded');assert.deepEqual(await item(db),before);
  });
  await t.test('new item initial count uses its own audit and common event; spoofed actor and changed idempotency payload fail',async()=>{
   const request=randomUUID(),args={p_payload:{item_name:'Synthetic new item',quantity:2,unit:'bottle'},p_reason:'stock_check',p_business_date:'2026-10-12',p_actor_user_id:9999};
   const result=await apply(db,'inventory_create_with_receipt_v1',args,proof('2026-10-12T15:00:00Z'),request);assert.equal(result.status,'ok');
   await assert.rejects(apply(db,'inventory_create_with_receipt_v1',{...args,p_payload:{...args.p_payload,quantity:3}},proof('2026-10-12T15:00:00Z'),request),e=>e.code==='22023');
   assert.equal((await q(db,'select count(*) n from inventory_writer_private.events where request_id=$1',[request]))[0].n,'1');
  });
  await t.test('source coverage remains false, unchanged held deliveries do not spin, and no audit event is missing',async()=>{
   assert.equal((await compare()).sourceComplete,false);
   assert.equal((await q(db,'select count(*) n from inventory_writer_private.audit_births b left join inventory_writer_private.events e on e.log_id=b.log_id where e.id is null'))[0].n,'0');
   assert.equal((await q(db,'select count(*) n from inventory_writer_private.changes c left join inventory_writer_private.links l on l.change_id=c.id where l.change_id is null'))[0].n,'0');
  });
  await t.test('unit/package changes are captured and held instead of silently reinterpreting historical quantities',async()=>{
   const old=await item(db,2);
   const result=await apply(db,'inventory_update_with_audit_v1',{p_item_id:2,p_expected_item:old,p_payload:{package_content_quantity:700,package_content_unit:'ml'},p_business_date:'2026-10-12',p_actor_user_id:1,p_reason:'other',p_source:'edit_form',p_price_business_date:'2026-10-12'},proof('2026-10-12T15:30:00Z'));
   assert.equal(result.status,'ok');assert.ok((await drain()).results.some(r=>r.result.reason==='unit_or_package_contract_changed'));
  });
  await t.test('unregistered direct quantity DML is fenced after integration',async()=>{
   const before=await item(db);await assert.rejects(db.exec('update inventory set quantity=quantity+1 where id=1'),e=>e.code==='42501');assert.deepEqual(await item(db),before);
  });
  await t.test('same-time counts use source log order and repeated comparisons stay deterministic',async()=>{
   await save(db,6,{event:proof('2026-10-12T18:00:00Z')});await save(db,7,{event:proof('2026-10-12T18:00:00Z')});await drain();
   const first=await compare(),last=(await q(db,"select max(log_id) id from inventory_writer_private.events where kind='count' and item_id=1"))[0].id;
   assert.equal(first.comparison.bookQuantity,7);assert.equal(String(first.comparison.boundaryLogId),String(last));for(let i=0;i<55;i++)assert.deepEqual(await compare(),first);
  });
  await t.test('unchanged physical counts remain anchors, and a later time revision is held instead of rewriting a registered movement',async()=>{
   const prior=(await item(db)).quantity;await save(db,prior,{event:proof('2026-10-12T18:10:00Z')});assert.equal((await drain()).results[0].result.result,'recorded');
   const event=(await q(db,"select * from inventory_writer_private.events where item_id=1 and kind='count' order by ordinal desc limit 1"))[0];
   const result=(await q(db,"select inventory_writer_attest($1,$2,'2026-10-12T18:11:00Z',$3,'owner') r",[event.id,event.source_hash,{proof:'synthetic corrected count time'}]))[0].r;
   assert.equal(result.status,'held');assert.equal((await drain()).results[0].result.reason,'registered_movement_time_revision_requires_reconciliation');
   assert.equal((await q(db,'select effective_at from pos_inventory_shadow.movements where log_id=$1',[event.log_id]))[0].effective_at.toISOString(),'2026-10-12T18:10:00.000Z');
   assert.equal((await item(db)).quantity,prior);
  });
  await t.test('real POS apply, modified receipt reprocess and count race preserve P0 and common audit',async()=>{
   const pos=new rt.Database();await writerFixture(pos);try{
    await save(pos,0.10,{reason:'other'});const c=await posCandidate(pos);assert.equal((await applyPos(pos,c)).ok,true);
    assert.equal(Number((await item(pos)).quantity),0.03);
    await pos.exec('update pos_sales_receipts set updated_at=clock_timestamp(),inventory_deduction_auto_eligible_at=clock_timestamp(),inventory_deduction_reprocess_required=true where id=10');
    const receipt=(await q(pos,'select to_jsonb(r) r from pos_sales_receipts r where id=10'))[0].r,line=(await q(pos,'select id from pos_sales_receipt_lines where receipt_id=10'))[0].id;
    const candidates=[{invoice_ref_id:'ref-10',ref_detail_id:'detail',pos_item_code:'TEST',pos_item_name:'Synthetic Glenfiddich',pos_quantity:1,mapping_type:'direct',inventory_item_id:1,deduct_quantity:1,receipt_line_id:line,mapping_id:1,recipe_id:null,mapping_snapshot:{mappingVersion:1},quantity_sold:1,deduct_quantity_per_unit:1,deduct_quantity_total:1,current_quantity_snapshot:0.03,after_quantity_snapshot:-0.97}];
    const reprocess=async client=>(await q(client,"select prepare_and_apply_sales_inventory_reprocess(10,'owner',$1,'bottle-version','hash',$2,$3) r",[receipt.updated_at,{amount_hash:'amount',line_summary:{hashVersion:2}},JSON.stringify(candidates)]))[0].r;
    const failed=await reprocess(pos);assert.ok(JSON.stringify(failed).includes('insufficient'),JSON.stringify(failed));
    const batchCount=(await q(pos,'select count(*) n from pos_inventory_deduction_batches'))[0].n;
    for(let i=0;i<55;i++)assert.deepEqual(await reprocess(pos),failed);
    assert.equal((await q(pos,'select count(*) n from pos_inventory_deduction_batches'))[0].n,batchCount);
    // Count holds the common gate; reprocess waits and is then protected by P0.
    const counter=await rt.connect(pos.name),worker=await rt.connect(pos.name);try{
     const counterPid=(await counter.query('select pg_backend_pid() p')).rows[0].p,workerPid=(await worker.query('select pg_backend_pid() p')).rows[0].p;
     await counter.query('begin');await save(counter,0.20);await save(counter,1.20,{reason:'purchase'});let finished=false;
     const waiting=reprocess(worker).then(r=>{finished=true;return r;});
     await new Promise(resolve=>setTimeout(resolve,40));assert.equal(finished,false);
     const lock=(await q(pos,'select wait_event_type,pg_blocking_pids(pid) blockers from pg_stat_activity where pid=$1',[workerPid]))[0];assert.equal(lock.wait_event_type,'Lock');assert.ok(lock.blockers.includes(counterPid));
     await counter.query('commit');const reviewed=await waiting;assert.match(JSON.stringify(reviewed),/stock_check|review/);
     assert.equal(Number((await item(pos)).quantity),1.20);
    }finally{await counter.query('rollback');await worker.query('rollback');await counter.end();await worker.end();}
    const post=(await q(pos,"select count(*) n from inventory_writer_private.events where kind='sale_posting'"))[0].n;assert.equal(post,'1');
    const out=(await q(pos,"select inventory_writer_shadow_drain(100,'owner') r"))[0].r;assert.ok(out.results.some(r=>r.result.reason==='pos_source_completeness_unverified'));
   }finally{await pos.close();}
  });
  await t.test('real receipt correction and a concurrent deduction are atomic, with the original financial audit unchanged',async()=>{
   const financial=await billedFixture(rt.Database);try{
    const root=(await q(financial,'select to_jsonb(l) l from inventory_logs l where id=100'))[0].l;
    const oldAudit=await q(financial,'select id,to_jsonb(l) l from ledger_audit_logs l order by id');
    await financial.exec("update users set username='owner' where id=2;update users set username='staff' where id=1");
    await installStandaloneJournal(financial);
    const old=await item(financial),other=await rt.connect(financial.name);
    try{
     const results=await Promise.all([editReceipt(financial,old,{quantity:9}),save(other,9,{expected:old,reason:'sale_deduction'})]);
     assert.equal(results.filter(r=>r.status==='ok').length,1);assert.equal(Number((await item(financial)).quantity),9);
     assert.ok(results.some(r=>['inventory_conflict','quantity_conflict'].includes(r.status)));
    }finally{await other.end();}
    assert.deepEqual((await q(financial,'select to_jsonb(l) l from inventory_logs l where id=100'))[0].l,root);
    assert.equal((await q(financial,'select count(*) n from inventory_writer_private.events'))[0].n,'1');
    const correction=await editReceipt(financial,await item(financial),{quantity:8});assert.equal(correction.status,'ok');
    for(const name of ['inventory_apply_purchase_correction_v1','inventory_apply_purchase_correction_v2','inventory_apply_purchase_correction_v3']){
     const current=await item(financial),args={p_item_id:1,p_purchase_log_id:100,p_expected_quantity:current.quantity,p_payload:{quantity:Number(current.quantity)-0.1},p_business_date:'2026-10-11',p_actor_user_id:2};
     if(!name.endsWith('v1'))args.p_expected_item=current;
     assert.equal((await apply(financial,name,args,{},randomUUID(),2)).status,'ok');
    }
    const beforePrice=await item(financial),net=(await q(financial,'select sum(change_quantity) q from inventory_logs where id=100 or correction_of_inventory_log_id=100'))[0].q;
    assert.equal((await editReceipt(financial,beforePrice,{quantity:Number(net),purchase_price:21000},2)).status,'ok');assert.equal((await item(financial)).quantity,beforePrice.quantity);
    const delivered=(await q(financial,"select inventory_writer_shadow_drain(100,'owner') r"))[0].r;
    assert.ok(delivered.results.some(e=>e.result.result==='excluded'&&e.result.reason==='no_quantity_movement'));
    for(const row of oldAudit)assert.deepEqual((await q(financial,'select to_jsonb(l) l from ledger_audit_logs l where id=$1',[row.id]))[0].l,row.l);
   }finally{await financial.close();}
  });
  await t.test('real keg replacement and POS apply on the same item serialize, replay once, and retain timing corrections',async()=>{
   const keg=new rt.Database();await writerFixture(keg);try{
    await apply(keg,'inventory_update_with_audit_v1',{p_item_id:1,p_expected_item:await item(keg),p_payload:{quantity:10,unit:'Keg',package_content_quantity:30000,package_content_unit:'ml'},p_business_date:'2026-10-12',p_actor_user_id:1,p_reason:'other',p_source:'edit_form',p_price_business_date:'2026-10-12'});
    await keg.exec("insert into pos_products(id,pos_item_id,item_code,item_name,unit_name) values(999,'KEG-TEST','KEG-TEST','Synthetic beer','glass');insert into inventory_keg_tracking_mappings(inventory_item_id,target_type,pos_product_id,quantity_per_pos_unit,is_active) values(1,'product',999,330,true)");
    const preview=(await q(keg,"select inventory_preview_keg_change('replace',1,null,'2026-10-12T12:00:00Z','2026-10-12','owner',10) r"))[0].r;
    const key=randomUUID(),args={p_action:'replace',p_item_id:1,p_session_id:null,p_at:'2026-10-12T12:00:00Z',p_business_date:'2026-10-12',p_actor_username:'owner',p_expected_quantity:10,p_preview_token:preview.previewToken,p_request_id:key,p_reason:'synthetic physical keg replacement confirmed',p_confirm:true};
    const c=await posCandidate(keg,1),other=await rt.connect(keg.name);let first;
    try{
     const otherPid=(await other.query('select pg_backend_pid() p')).rows[0].p;
     await keg.exec('begin');first=await apply(keg,'inventory_apply_keg_change',args,{effectiveAt:args.p_at,proof:'synthetic actual replacement',physicalEventRef:key},key);
     let complete=false;const waiting=applyPos(other,c).then(r=>{complete=true;return r;});await new Promise(r=>setTimeout(r,40));assert.equal(complete,false);
     assert.equal((await q(keg,'select wait_event_type from pg_stat_activity where pid=$1',[otherPid]))[0].wait_event_type,'Lock');
     await keg.exec('commit');assert.equal((await waiting).ok,true);
    }finally{await keg.exec('rollback');await other.end();}
    assert.equal(Number((await item(keg)).quantity),8);assert.deepEqual(await apply(keg,'inventory_apply_keg_change',args,{effectiveAt:args.p_at,proof:'synthetic actual replacement',physicalEventRef:key},key),first);
    assert.equal((await q(keg,"select count(*) n from inventory_writer_private.events where kind='keg_replace'"))[0].n,'1');
    assert.equal((await q(keg,"select count(*) n from inventory_writer_private.events where kind='sale_posting'"))[0].n,'1');
    const active=(await q(keg,"select id from inventory_keg_sessions where inventory_item_id=1 and status='active'"))[0].id;
    const beforeQty=(await item(keg)).quantity;
    const editPreview=(await q(keg,"select inventory_preview_keg_change('edit-start',null,$1,'2026-10-12T12:01:00Z','2026-10-12','owner',8) r",[active]))[0].r;
    await apply(keg,'inventory_apply_keg_change',{...args,p_action:'edit-start',p_item_id:null,p_session_id:active,p_at:'2026-10-12T12:01:00Z',p_expected_quantity:8,p_preview_token:editPreview.previewToken,p_request_id:randomUUID()});
    assert.equal((await item(keg)).quantity,beforeQty);assert.equal((await q(keg,"select count(*) n from inventory_writer_private.events where kind='keg_timing'"))[0].n,'1');
    const drain=(await q(keg,"select inventory_writer_shadow_drain(100,'owner') r"))[0].r;
    assert.ok(drain.results.some(e=>e.result.reason==='keg_timing_revision_requires_reconciliation'));
    await assert.rejects(keg.exec("update inventory_keg_sessions set started_at=started_at+interval '1 minute'"),e=>e.code==='42501');
   }finally{await keg.close();}
  });
  await t.test('legacy shortage retry recovers after delivery; cancellation posting stays separate from physical return',async()=>{
   const pos=new rt.Database();await writerFixture(pos);try{
    await save(pos,0.10,{reason:'other'});const c=await posCandidate(pos);await applyPos(pos,c);
    await pos.exec('update pos_sales_receipts set updated_at=clock_timestamp(),inventory_deduction_reprocess_required=true where id=10');
    const r=(await q(pos,'select to_jsonb(r) r from pos_sales_receipts r where id=10'))[0].r,line=(await q(pos,'select id from pos_sales_receipt_lines where receipt_id=10'))[0].id;
    const candidates=[{invoice_ref_id:'ref-10',ref_detail_id:'detail',pos_item_code:'TEST',pos_item_name:'Synthetic Glenfiddich',pos_quantity:1,mapping_type:'direct',inventory_item_id:1,deduct_quantity:1,receipt_line_id:line,mapping_id:1,mapping_snapshot:{mappingVersion:1},quantity_sold:1,deduct_quantity_per_unit:1,deduct_quantity_total:1}];
    const run=async()=>(await q(pos,"select prepare_and_apply_sales_inventory_reprocess(10,'owner',$1,'recoverable','hash',$2,$3) r",[r.updated_at,{amount_hash:'amount',line_summary:{hashVersion:2}},JSON.stringify(candidates)]))[0].r;
    assert.match(JSON.stringify(await run()),/insufficient/);await save(pos,2.03,{reason:'purchase'});const recovered=await run();assert.match(JSON.stringify(recovered),/applied/);
    assert.equal(Number((await item(pos)).quantity),1.10);
    await pos.exec('update pos_sales_receipts set is_canceled=true,updated_at=clock_timestamp() where id=10');
    const receipt=(await q(pos,'select to_jsonb(r) r from pos_sales_receipts r where id=10'))[0].r;
    const rollback=(await q(pos,"select rollback_canceled_sales_inventory_deduction_receipt(10,'owner',$1,'cancel-version') r",[receipt.updated_at]))[0].r;
    assert.match(JSON.stringify(rollback),/rolled_back|applied/);
    // Legacy quantity rollback is preserved for compatibility; it is not
    // asserted to be a physical receipt by the new journal/Shadow engine.
    assert.equal((await q(pos,"select count(*) n from inventory_writer_private.events where kind='physical_return'"))[0].n,'0');
    assert.equal((await q(pos,'select count(*) n from inventory_writer_private.changes c left join inventory_writer_private.links l on l.change_id=c.id where l.change_id is null'))[0].n,'0');
   }finally{await pos.close();}
  });
  await t.test('new journal RPCs and private tables cannot be called directly by anonymous/authenticated clients',async()=>{
   const grants=await q(db,"select proname,has_function_privilege('anon',oid,'execute') a,has_function_privilege('authenticated',oid,'execute') u,has_function_privilege('service_role',oid,'execute') s from pg_proc where pronamespace='public'::regnamespace and proname like 'inventory_writer_%'");
   assert.equal(grants.length,5);assert.ok(grants.every(g=>!g.a&&!g.u&&g.s));
   assert.equal((await q(db,"select has_schema_privilege('service_role','inventory_writer_private','usage') ok"))[0].ok,false);
  });
  await (await rt.connect('postgres')).query('checkpoint');
 }finally{await db.close();}
});
