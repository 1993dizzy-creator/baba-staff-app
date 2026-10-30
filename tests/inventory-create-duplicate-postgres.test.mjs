import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {nativeInventoryPostgres} from './helpers/inventory-native-postgres.mjs';
import {billedFixture} from './helpers/inventory-billed-amount-fixture.mjs';
const one=async(db,sql,args=[])=>(await db.query(sql,args)).rows[0];
const migration='supabase/migrations/20261030170000_inventory_create_with_receipt.sql';
const orange={item_name:'오렌지',item_name_vi:'Cam sành',part:'kitchen',category:'Drinks',quantity:3.57,unit:'kg',purchase_price:85000,
 supplier:'Won Mart',supplier_partner_id:10,code:'OR',billed_amount_mode:'manual',billed_amount:303000};
const create=(db,payload)=>one(db,'select inventory_create_with_receipt_v1($1::jsonb,$2,$3::date,$4) as r',[JSON.stringify(payload),'purchase','2026-10-11',1]).then(row=>row.r);
async function fixture(Database){
 const db=await billedFixture(Database);
 await db.exec("create sequence fixture_inventory_id_seq start 500; alter table inventory alter column id set default nextval('fixture_inventory_id_seq')");
 await db.exec(readFileSync(migration,'utf8'));
 return db;
}
const totals=async db=>one(db,`select (select count(*) from inventory where code='OR')::int as items,
 (select count(*) from inventory_logs l join inventory i on i.id=l.item_id where i.code='OR' and l.source='create')::int as receipts,
 (select count(*) from ledger_candidates where source_key in (select 'inventory-log:'||l.id from inventory_logs l join inventory i on i.id=l.item_id where i.code='OR'))::int as candidates`);

// Real lock waits in native PostgreSQL: a double submit (two requests that both passed the app's
// duplicate pre-check) and a retry after a lost HTTP response must leave one item and one receipt.
test('native PostgreSQL: double submit and lost-response retry never create a duplicate item or receipt',{skip:!process.env.QA_POSTGRES_BIN,timeout:120000},async t=>{
 const runtime=await nativeInventoryPostgres({testContext:t});
 try{
  await t.test('two concurrent creates of the same item',async()=>{
   const db=await fixture(runtime.Database),a=await runtime.connect(db.name),b=await runtime.connect(db.name);let pending;
   try{
    await a.query("set statement_timeout='10s';begin");await b.query("set statement_timeout='10s';set deadlock_timeout='100ms'");
    const first=await create(a,orange);assert.equal(first.status,'ok');
    const pid=(await one(b,'select pg_backend_pid() as pid')).pid;
    pending=create(b,{...orange,item_name:'  오렌지 ',item_name_vi:'CAM SANH',code:'or'});pending.catch(()=>{});
    let waited=false;for(let i=0;i<100;i++){if((await one(db,'select cardinality(pg_blocking_pids($1)) as n',[pid])).n>0){waited=true;break;}await delay(20);}
    await a.query('commit');
    const second=await pending;
    console.log(JSON.stringify({secondWaitedForFirst:waited,second:second.status}));
    assert.equal(second.status,'duplicate',JSON.stringify(second));assert.equal(Number(second.duplicateItemId),Number(first.item.id));
    assert.deepEqual(second.matchedFields,['item_name','item_name_vi']);
    assert.deepEqual(await totals(db),{items:1,receipts:1,candidates:1});
    assert.equal(Number((await one(db,'select deadlocks from pg_stat_database where datname=current_database()')).deadlocks),0);
   }finally{await a.query('rollback').catch(()=>{});await b.query('rollback').catch(()=>{});if(pending)await pending.catch(()=>{});await a.end();await b.end();await db.close();}
  });
  await t.test('retry after the first create committed but its response was lost',async()=>{
   const db=await fixture(runtime.Database);
   try{
    assert.equal((await create(db,orange)).status,'ok');
    const retry=await create(db,orange);assert.equal(retry.status,'duplicate');
    assert.deepEqual(await totals(db),{items:1,receipts:1,candidates:1});
    // A first attempt that rolled back leaves nothing behind, so its retry succeeds once.
    await db.exec('begin');await create(db,{...orange,code:'OR2'});await db.exec('rollback');
    assert.equal((await create(db,{...orange,code:'OR2'})).status,'ok');
    assert.equal(Number((await one(db,"select count(*) as n from inventory where code='OR2'")).n),1);
   }finally{await db.close();}
  });
 }finally{await runtime.stop();}
});
