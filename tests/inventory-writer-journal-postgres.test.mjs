import assert from 'node:assert/strict';
import test from 'node:test';
import {nativeInventoryPostgres} from './helpers/inventory-native-postgres.mjs';
import {initializeShadow,readMigration} from './helpers/pos-shadow-fixture.mjs';
const sql='20261102120035_inventory_writer_event_journal.sql';
const q=async(db,s,a=[])=>(await db.query(s,a)).rows;
export async function installWriterJournal(db){
 await db.exec('alter table inventory add column package_content_quantity numeric,add column package_content_unit text');
 await db.exec(readMigration('20261102103822_pos_shadow_temporal_settlement.sql'));
 await db.exec(readMigration('20261102110828_pos_shadow_writer_contract_and_order.sql'));
 await db.exec(readMigration(sql));
}
test('all quantity writers are captured and require atomic audit',{timeout:120000},async t=>{
 const rt=await nativeInventoryPostgres({testContext:t}),db=new rt.Database();
 try{
  await initializeShadow(db);const p0=await q(db,"select prosrc,proacl::text from pg_proc where oid='guard_pos_inventory_stock_check_boundary()'::regprocedure");
  await installWriterJournal(db);
  const state=async()=>({inventory:await q(db,'select id,quantity,unit from inventory order by id'),logs:await q(db,'select * from inventory_logs order by id'),events:await q(db,'select * from inventory_writer_private.events order by ordinal')});
  const move=async({source='edit_form',reason='other',delta=1,context={}}={})=>{
   await db.exec('begin');try{
    await db.query("select set_config('baba.inventory_writer_context',$1,true)",[JSON.stringify(context)]);
    const item=(await q(db,'select quantity from inventory where id=1 for update'))[0];
    await db.query('update inventory set quantity=quantity+$1 where id=1',[delta]);
    await db.query('insert into inventory_logs(item_id,source,reason,prev_quantity,new_quantity,change_quantity) values(1,$1,$2,$3::numeric,$3::numeric+$4::numeric,$4::numeric)',[source,reason,item.quantity,delta]);
    await db.exec('commit');
   }catch(e){await db.exec('rollback');throw e;}
  };
  await t.test('raw DML cannot commit quantity without its audit; rollback restores all tables',async()=>{
   const before=await state();await db.exec('begin;update inventory set quantity=9 where id=1');
   await assert.rejects(db.exec('commit'),e=>e.code==='23514');await db.exec('rollback');assert.deepEqual(await state(),before);
  });
  await t.test('unknown administrator/batch writes are captured, not silently assigned an effective time',async()=>{
   await move();const events=await q(db,'select * from inventory_writer_private.events');assert.equal(events.length,1);
   assert.equal(events[0].effective_at,null);assert.equal(events[0].blocking_reason,'physical_effective_at_unproven');
   assert.equal((await q(db,'select count(*) n from inventory_writer_private.links'))[0].n,'1');
  });
  await t.test('new correction log can be finalized in its transaction; committed audit cannot be rewritten',async()=>{
   await db.exec('begin');await db.exec("insert into inventory_logs(item_id,source,reason,prev_quantity,new_quantity,change_quantity) values(1,'edit_form','other',1.03,1.03,0)");
   const id=(await q(db,'select max(id) id from inventory_logs'))[0].id;await db.query("update inventory_logs set reason='purchase' where id=$1",[id]);await db.exec('commit');
   assert.equal((await q(db,'select kind from inventory_writer_private.events where log_id=$1',[id]))[0].kind,'purchase');
   const before=await state();await assert.rejects(db.query("update inventory_logs set reason='other' where id=$1",[id]),e=>e.code==='55000');assert.deepEqual(await state(),before);
  });
  await t.test('proved movement retains physical and observed clocks separately',async()=>{
   await move({context:{event:{effectiveAt:'2026-10-12T12:00:00Z',proof:'synthetic actual delivery note'}}});
   const event=(await q(db,'select * from inventory_writer_private.events order by ordinal desc limit 1'))[0];
   assert.equal(event.effective_at.toISOString(),'2026-10-12T12:00:00.000Z');assert.ok(event.observed_at>event.effective_at);assert.equal(event.blocking_reason,null);
  });
  await t.test('inventory/log DELETE/TRUNCATE and unit change without audit fail before loss',async()=>{
   const before=await state();for(const sql of ['delete from inventory_logs','truncate inventory_logs cascade','delete from inventory where id=1','truncate inventory cascade'])await assert.rejects(db.exec(sql),e=>e.code==='55000');
   await db.exec("begin;update inventory set unit='ml' where id=1");await assert.rejects(db.exec('commit'),e=>e.code==='23514');await db.exec('rollback');assert.deepEqual(await state(),before);
  });
  await t.test('original P0 still rolls back a delayed POS write across a stock check',async()=>{
   await db.exec("insert into inventory_logs(item_id,source,reason,prev_quantity,new_quantity,change_quantity,created_at) values(1,'edit_form','stock_check',2.03,2.03,0,'2026-10-11T00:00:00Z')");
   const before=await state();await db.exec('begin');await db.exec('update inventory set quantity=quantity-1 where id=1');
   await assert.rejects(db.exec("insert into inventory_logs(item_id,source,reason,prev_quantity,new_quantity,change_quantity,related_receipt_id) values(1,'pos_sales','sale_deduction',2.03,1.03,-1,10)"),e=>e.code==='P0S01');
   await db.exec('rollback');assert.deepEqual(await state(),before);assert.deepEqual(await q(db,"select prosrc,proacl::text from pg_proc where oid='guard_pos_inventory_stock_check_boundary()'::regprocedure"),p0);
  });
  await t.test('unregistered callers retry rather than deadlock after acquiring a different row first',async()=>{
   const a=await rt.connect(db.name),b=await rt.connect(db.name);try{
    await a.query('begin');await b.query('begin');await b.query('select id from inventory where id=1 for update');
    await a.query('select inventory_writer_private.enter(true)');
    await assert.rejects(b.query('update inventory set quantity=quantity+1 where id=1'),e=>e.code==='40001');
   }finally{await b.query('rollback');await a.query('rollback');await a.end();await b.end();}
  });
  assert.equal((await q(db,"select has_schema_privilege('service_role','inventory_writer_private','usage') ok"))[0].ok,false);
  await (await rt.connect('postgres')).query('checkpoint');
 }finally{await db.close();}
});
