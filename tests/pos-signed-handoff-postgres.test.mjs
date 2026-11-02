import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {nativeInventoryPostgres} from './helpers/inventory-native-postgres.mjs';
import {writerFixture,save,item,rows as q,posCandidate,applyPos,apply} from './helpers/inventory-writer-integration-fixture.mjs';
import {readMigration} from './helpers/pos-shadow-fixture.mjs';
const migration='20261102142849_pos_signed_projection_epochs_and_handoff.sql';
const proof='Synthetic signed source evidence, not production';
const rpc=async(db,name,args)=>(await q(db,`select ${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) r`,args.map(a=>Array.isArray(a)?JSON.stringify(a):a)))[0].r;
const epoch=(db,id=1,from='2026-10-01T00:00:00Z',expected=null,factors={ml:{numerator:1,denominator:1},bottle:{numerator:700,denominator:1},glass:{numerator:50,denominator:1}},request=randomUUID())=>rpc(db,'pos_signed_define_epoch',[id,from,'ml',factors,expected,proof,request,'owner']);
const revise=(db,e,ep,at,expected=null,request=randomUUID(),timing=null)=>rpc(db,'pos_signed_revise_event',[e.id,ep,e.unit,at,expected,proof,request,'owner',timing]);
const receipt=async db=>(await q(db,'select to_jsonb(r) r from pos_sales_receipts r where id=10'))[0].r;
const latest=async db=>(await q(db,'select * from inventory_writer_private.events order by ordinal desc limit 1'))[0];
const compare=db=>rpc(db,'pos_signed_compare',[1,'owner']);
const audit=db=>q(db,'select to_jsonb(l) l from inventory_logs l order by id');
const target=(ep,quantity,at='2026-10-12T10:00:00Z',unit='bottle')=>({effectKey:'receipt-10/item-1',itemId:1,epochId:ep,quantity,unit,effectiveAt:at});
const observe=async(db,ep,quantity,parent=null,at,kind='correction',request=randomUUID(),unit='bottle')=>rpc(db,'pos_signed_observe_sale',[10,parent,kind,kind==='cancel'?[]:[target(ep,quantity,at,unit)],(await receipt(db)).updated_at,proof,request,'owner']);

test('P1-2F signed handoff, immutable units/time interpretation and locks',{timeout:120000},async t=>{
 const rt=await nativeInventoryPostgres({testContext:t}),db=new rt.Database();
 try{
  await writerFixture(db);await db.exec(readMigration(migration));
  let ep,adoption,version,anchorEvent,anchorRevision;
  await t.test('successor contracts preserve OIDs/ACLs and drift detection',async()=>{
   assert.equal((await q(db,'select count(*) n from pos_signed_private.rpc_successors'))[0].n,'4');
   const r=await rpc(db,'inventory_writer_inspect',['owner']);assert.ok(r.writers.every(w=>!w.drift));
   await db.exec('begin');
   const f=(await q(db,"select pg_get_functiondef('rollback_canceled_sales_inventory_deduction_receipt(bigint,text,timestamptz,text)'::regprocedure) d"))[0].d;
   await db.exec(f.replace('-- SIGNED_ROUTE_FENCE','-- tampered SIGNED_ROUTE_FENCE'));
   assert.ok((await rpc(db,'inventory_writer_inspect',['owner'])).writers.some(w=>w.drift));await db.exec('rollback');
  });
  await t.test('Glenfiddich initial glass deduction is preserved in adoption baseline',async()=>{
   await save(db,.10,{reason:'other'});const c=await posCandidate(db);await applyPos(db,c);
   assert.equal((await item(db)).quantity,.03);
   ep=(await epoch(db)).epochId;
   const d=(await q(db,"select * from pos_inventory_deductions where status='applied'"))[0];
   const baseline=[{...target(ep,Number(d.deduct_quantity_total),'2026-10-09T13:01:00Z'),deductionId:Number(d.id)}];
   const before=await audit(db);adoption=randomUUID();
   const result=await rpc(db,'pos_signed_adopt_receipt',[10,(await receipt(db)).updated_at,baseline,proof,adoption,'owner']);
   assert.equal(result.inventoryWritten,false);assert.deepEqual(await audit(db),before);
   assert.equal((await q(db,"select baseline->0->>'baseQuantity' q from pos_signed_private.receipts where receipt_id=10"))[0].q,'49.9800000000000000');
  });
  await t.test('verified count on Oct11 and delayed Oct12 purchase are separate from saved timestamps',async()=>{
   await save(db,2);anchorEvent=await latest(db);anchorRevision=await revise(db,anchorEvent,ep,'2026-10-11T04:00:00Z');
   await save(db,5,{reason:'purchase'});const e=await latest(db);await revise(db,e,ep,'2026-10-12T12:00:00Z');
   assert.notEqual(e.recorded_at,'2026-10-12T12:00:00Z');
   version=await observe(db,ep,1,null,'2026-10-09T13:01:00Z');
   assert.equal((await compare(db)).bookQuantity,3500); // count 1400 + arrival2100; prior sale absorbed
  });
  await t.test('after-count edits replace prior target; mixed glass and bottle conversion is exact',async()=>{
   version=await observe(db,ep,1,version.versionId);assert.equal((await compare(db)).bookQuantity,2800);
   version=await observe(db,ep,2,version.versionId);assert.equal((await compare(db)).bookQuantity,2100);
   version=await observe(db,ep,1,version.versionId,undefined,'correction',randomUUID(),'glass');assert.equal((await compare(db)).bookQuantity,3450);
   assert.equal(await rpc(db,'pos_signed_compare',[1,'owner']).then(r=>r.baseUnit),'ml');
  });
  await t.test('shortage remains signed and delayed arrival recovers once without stock projection writes',async()=>{
   version=await observe(db,ep,8,version.versionId);
   let r=await compare(db);assert.equal(r.bookQuantity,-2100);assert.equal(r.shortage,2100);assert.equal((await item(db)).quantity,5);
   await save(db,9,{reason:'purchase'});await revise(db,await latest(db),ep,'2026-10-13T00:00:00Z');
   r=await compare(db);assert.equal(r.bookQuantity,700);assert.equal(r.shortage,0);
   for(let i=0;i<55;i++)assert.deepEqual(await compare(db),r);
  });
  await t.test('legacy reprocess, cancellation, and initial batch never restore/deduct adopted receipt',async()=>{
   const before=await audit(db),stock=await item(db),count=(await q(db,'select count(*) n from pos_inventory_deduction_batches'))[0].n;
   const d=(await q(db,'select batch_receipt_id from pos_inventory_deductions where receipt_id=10 limit 1'))[0];
   const r=await receipt(db);
   const prep=[10,'owner',r.updated_at,'changed','hash',{},[]];
   for(let i=0;i<55;i++)assert.equal((await rpc(db,'prepare_and_apply_sales_inventory_reprocess',prep)).result,'signed_routed');
   assert.equal((await rpc(db,'reprocess_modified_sales_inventory_deduction_receipt',[d.batch_receipt_id,'owner',r.updated_at,'changed','hash'])).result,'signed_routed');
   assert.equal((await rpc(db,'rollback_canceled_sales_inventory_deduction_receipt',[10,'owner',r.updated_at,'cancel'])).result,'signed_routed');
   assert.equal((await q(db,'select count(*) n from pos_inventory_deduction_batches'))[0].n,count);
   const c=await posCandidate(db);assert.equal((await applyPos(db,c)).result,'signed_batch_held');
   assert.deepEqual(await audit(db),before);assert.deepEqual(await item(db),stock);
   // Generic journal dispatcher also recognizes successor body.
   const routed=await apply(db,'rollback_canceled_sales_inventory_deduction_receipt',{p_receipt_id:10,p_actor_username:'owner',p_expected_receipt_updated_at:r.updated_at,p_expected_receipt_content_fingerprint:'cancel'});
   assert.equal(routed.result,'signed_routed');
  });
  await t.test('economic cancellation retains physical consumption; return is separate, replay survives newer versions',async()=>{
   await db.exec('update pos_sales_receipts set is_canceled=true,updated_at=clock_timestamp() where id=10');
   const id=randomUUID(),parent=version.versionId;version=await observe(db,ep,0,parent,undefined,'cancel',id);
   assert.equal((await compare(db)).bookQuantity,700);
   await save(db,10,{reason:'other',event:{kind:'physical_return',physicalEventRef:'returned-item-1',proof}});
   await revise(db,await latest(db),ep,'2026-10-13T01:00:00Z');assert.equal((await compare(db)).bookQuantity,1400);
   const replay=await observe(db,ep,0,parent,undefined,'cancel',id);assert.equal(replay.versionId,version.versionId);
   await assert.rejects(observe(db,ep,1,null),/SIGNED_SALE_PARENT_CONFLICT/);
  });
  await t.test('retroactive purchase correction is absorbed by count and source audit stays immutable',async()=>{
   const e=(await q(db,"select * from inventory_writer_private.events where kind='purchase' order by ordinal limit 1"))[0];
   const rev=(await q(db,'select id from pos_signed_private.event_revisions where event_id=$1 order by id desc limit 1',[e.id]))[0];
   const before=await audit(db);await revise(db,e,ep,'2026-10-10T12:00:00Z',rev.id);
   assert.equal((await compare(db)).bookQuantity,-700);assert.deepEqual(await audit(db),before);
   await assert.rejects(revise(db,e,ep,'2026-10-10T11:00:00Z',rev.id),e=>e.code==='40001');
  });
  await t.test('time, unit, nonexact ratio and epoch reinterpretation fail closed',async()=>{
   await assert.rejects(revise(db,anchorEvent,ep,'2026-10-11'),/SIGNED_PHYSICAL_TIME_UNPROVEN/);
   await assert.rejects(observe(db,ep,1,version.versionId,undefined,'correction',randomUUID(),'unknown'),/SIGNED_UNIT_CONVERSION_UNPROVEN/);
   await assert.rejects(epoch(db,1,'2026-10-12T00:00:00Z',ep),/SIGNED_EPOCH_WOULD_REINTERPRET_HISTORY/);
   await epoch(db,2,'2026-10-01T00:00:00Z',null,{ml:{numerator:1,denominator:1},bottle:{numerator:1,denominator:3}});
   await assert.rejects(q(db,"select pos_signed_private.convert((select id from pos_signed_private.epochs where item_id=2),'bottle',1,'2026-10-12Z')"),/SIGNED_UNIT_PRECISION_UNSUPPORTED/);
   assert.equal((await compare(db)).automaticConfirmation,false);
   await assert.rejects(db.exec("update inventory_logs set change_quantity=999"),/IMMUTABLE/);
  });
  await t.test('same-item event revision uses CAS under concurrent ownership and count races serialize',async()=>{
   const other=await rt.connect(db.name);try{
    const old=(await q(db,'select id from pos_signed_private.event_revisions where event_id=$1 order by id desc limit 1',[anchorEvent.id]))[0].id;
    const a=await Promise.allSettled([revise(db,anchorEvent,ep,'2026-10-11T04:01:00Z',old),revise(other,anchorEvent,ep,'2026-10-11T04:02:00Z',old)]);
    assert.equal(a.filter(r=>r.status==='fulfilled').length,1);assert.equal(a.find(r=>r.status==='rejected').reason.code,'40001');
    const expected=await item(db);const b=await Promise.all([save(db,11,{expected}),save(other,12,{expected})]);
    assert.deepEqual(b.map(r=>r.status).sort(),['inventory_conflict','ok']);
    const c=await compare(db);assert.ok(c.pendingPhysicalEvents>0);assert.equal(c.sourceComplete,false);
   }finally{await other.end();}
  });
  await t.test('keg 30L to 20L needs a new count; timing correction appends interpretation without altering log',async()=>{
   const k=new rt.Database();await writerFixture(k);await k.exec(readMigration(migration));try{
    const change=async payload=>apply(k,'inventory_update_with_audit_v1',{p_item_id:1,p_expected_item:await item(k),p_payload:payload,p_business_date:'2026-10-12',p_actor_user_id:1,p_reason:'stock_check',p_source:'edit_form',p_price_business_date:'2026-10-12'});
    await change({quantity:2,unit:'Keg',package_content_quantity:30000,package_content_unit:'ml'});
    const a=await epoch(k,1,'2026-10-01T00:00:00Z',null,{ml:{numerator:1,denominator:1},keg:{numerator:30000,denominator:1}});
    await revise(k,await latest(k),a.epochId,'2026-10-11T00:00:00Z');assert.equal((await compare(k)).bookQuantity,60000);
    const b=await epoch(k,1,'2026-10-12T00:00:00Z',a.epochId,{ml:{numerator:1,denominator:1},keg:{numerator:20000,denominator:1}});
    assert.equal((await compare(k)).reason,'new_unit_epoch_requires_verified_count');
    await change({quantity:2,package_content_quantity:20000});await revise(k,await latest(k),b.epochId,'2026-10-12T01:00:00Z');
    assert.equal((await compare(k)).bookQuantity,40000);
    await k.exec("insert into pos_products(id,pos_item_id,item_code,item_name,unit_name) values(999,'KEG-TEST','KEG-TEST','Synthetic beer','glass');insert into inventory_keg_tracking_mappings(inventory_item_id,target_type,pos_product_id,quantity_per_pos_unit,is_active) values(1,'product',999,330,true)");
    const preview=await rpc(k,'inventory_preview_keg_change',['replace',1,null,'2026-10-12T12:00:00Z','2026-10-12','owner',2]);
    const args={p_action:'replace',p_item_id:1,p_session_id:null,p_at:'2026-10-12T12:00:00Z',p_business_date:'2026-10-12',p_actor_username:'owner',p_expected_quantity:2,p_preview_token:preview.previewToken,p_request_id:randomUUID(),p_reason:proof,p_confirm:true};
    await apply(k,'inventory_apply_keg_change',args);const physical=(await q(k,"select * from inventory_writer_private.events where kind='keg_replace'"))[0];
    const original=await revise(k,physical,b.epochId,'2026-10-12T12:00:00Z');
    const session=(await q(k,"select id from inventory_keg_sessions where status='active'"))[0].id;
    const edit=await rpc(k,'inventory_preview_keg_change',['edit-start',null,session,'2026-10-12T12:01:00Z','2026-10-12','owner',1]);
    await apply(k,'inventory_apply_keg_change',{...args,p_action:'edit-start',p_item_id:null,p_session_id:session,p_at:'2026-10-12T12:01:00Z',p_expected_quantity:1,p_preview_token:edit.previewToken,p_request_id:randomUUID()});
    const timing=(await q(k,"select * from inventory_writer_private.events where kind='keg_timing'"))[0],before=await audit(k);
    assert.equal((await compare(k)).pendingPhysicalEvents,1);
    await revise(k,physical,b.epochId,'2026-10-12T12:01:00Z',original.revisionId,randomUUID(),timing.id);
    assert.equal((await compare(k)).pendingPhysicalEvents,0);assert.deepEqual(await audit(k),before);
    assert.equal((await compare(k)).bookQuantity,20000);
   }finally{await k.close();}
  });
  await t.test('unadopted legacy shortage/recovery/cancel behavior matches before F and ambiguous historic reversal cannot be silently adopted',async()=>{
   const output=[];
   for(const install of [false,true]){
    const p=new rt.Database();await writerFixture(p);if(install)await p.exec(readMigration(migration));
    try{
     await save(p,.10,{reason:'other'});const c=await posCandidate(p);await applyPos(p,c);
     await p.exec('update pos_sales_receipts set updated_at=clock_timestamp(),inventory_deduction_reprocess_required=true where id=10');
     const r=await receipt(p),line=(await q(p,'select id from pos_sales_receipt_lines where receipt_id=10'))[0].id;
     const candidates=[{invoice_ref_id:'ref-10',ref_detail_id:'detail',pos_item_code:'TEST',pos_item_name:'Synthetic Glenfiddich',pos_quantity:1,mapping_type:'direct',inventory_item_id:1,deduct_quantity:1,receipt_line_id:line,mapping_id:1,mapping_snapshot:{mappingVersion:1},quantity_sold:1,deduct_quantity_per_unit:1,deduct_quantity_total:1}];
     const run=()=>rpc(p,'prepare_and_apply_sales_inventory_reprocess',[10,'owner',r.updated_at,'recoverable','hash',{amount_hash:'amount',line_summary:{hashVersion:2}},candidates]);
     assert.match(JSON.stringify(await run()),/insufficient/);await save(p,2.03,{reason:'purchase'});assert.match(JSON.stringify(await run()),/applied/);
     const deducted=(await item(p)).quantity;assert.equal(deducted,1.10);
     await p.exec('update pos_sales_receipts set is_canceled=true,updated_at=clock_timestamp() where id=10');
     const result=await rpc(p,'rollback_canceled_sales_inventory_deduction_receipt',[10,'owner',(await receipt(p)).updated_at,'cancel-version']);
     assert.match(JSON.stringify(result),/rolled_back|applied/);
     const restored=(await item(p)).quantity,logs=await audit(p);
     await rpc(p,'rollback_canceled_sales_inventory_deduction_receipt',[10,'owner',(await receipt(p)).updated_at,'cancel-version']);assert.deepEqual(await audit(p),logs);
     output.push({deducted,restored,effects:await q(p,'select status,operation_type,deduct_quantity_total from pos_inventory_deductions order by id')});
     if(install){await epoch(p);await assert.rejects(rpc(p,'pos_signed_adopt_receipt',[10,(await receipt(p)).updated_at,[],proof,randomUUID(),'owner']),/SIGNED_HISTORIC_REVERSAL_REQUIRES_PHYSICAL_RECONCILIATION/);}
    }finally{await p.close();}
   }
   assert.deepEqual(output[0],output[1]);
  });
 }finally{await db.close();const c=await rt.connect('postgres');await c.query('checkpoint');await c.end();}
});
