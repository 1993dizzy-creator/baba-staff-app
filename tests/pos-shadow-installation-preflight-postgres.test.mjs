// New P1-3A scope: exact full migration order and installation/business isolation.
// Existing P1 unit/scenario PASS is reused, not rerun here.
import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeInventoryPostgres} from './helpers/inventory-native-postgres.mjs';
import {writerFixture,rows as q} from './helpers/inventory-writer-integration-fixture.mjs';
import {readMigration,operatingSnapshot,capture,claim} from './helpers/pos-shadow-fixture.mjs';
async function allBusinessRows(db){
 const snapshot={};
 for(const {name} of await q(db,"select relname name from pg_class where relnamespace='public'::regnamespace and relkind='r' order by relname"))
  snapshot[name]=(await q(db,`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]') rows from public."${name.replaceAll('"','""')}" t`))[0].rows;
 return snapshot;
}
const chain=[
 '20261102101859_pos_reprocess_failure_persistence_and_dedup.sql',
 '20261102103506_pos_shadow_sale_versions_and_jobs.sql',
 '20261102103822_pos_shadow_temporal_settlement.sql',
 '20261102110828_pos_shadow_writer_contract_and_order.sql',
 '20261102113150_pos_reliable_cukcuk_ingestion.sql',
 '20261102120035_inventory_writer_event_journal.sql',
 '20261102120303_inventory_writer_shadow_integration.sql',
 '20261102142849_pos_signed_projection_epochs_and_handoff.sql',
 '20261102144000_pos_writer_least_privilege_and_day_reconciliation.sql',
];
test('P1-3A full dependency order and observation isolation',{timeout:120000},async t=>{
 const rt=await nativeInventoryPostgres({testContext:t}),db=new rt.Database();
 try{
  // Reuse only base schema construction; intercept ALL P1 migration installation.
  // This creates no production connection and never loads environment files.
  const texts=new Set(chain.map(readMigration));
  const base=new Proxy(db,{get(target,name){if(name==='exec')return async sql=>{if(!texts.has(sql))return target.exec(sql);};const v=target[name];return typeof v==='function'?v.bind(target):v;}});
  await writerFixture(base);
  assert.equal((await q(db,"select to_regnamespace('pos_inventory_shadow') n"))[0].n,null);
  const before=await operatingSnapshot(db),business=await allBusinessRows(db),p0=(await q(db,"select prosrc from pg_proc where oid='guard_pos_inventory_stock_check_boundary()'::regprocedure"))[0].prosrc;
  for(const name of chain){await db.exec(readMigration(name));t.diagnostic('installed '+name);}
  assert.deepEqual(await operatingSnapshot(db),before,'installation must not backfill business rows');
  assert.deepEqual(await allBusinessRows(db),business,'installation must preserve all fixture business tables, including payments and ledger');
  assert.equal((await q(db,"select prosrc from pg_proc where oid='guard_pos_inventory_stock_check_boundary()'::regprocedure"))[0].prosrc,p0);
  assert.equal((await q(db,'select count(*) n from pos_signed_private.handoffs'))[0].n,'0');
  const captured=await capture(db,{key:'p1-3a-observation',seq:null,evidence:{timeBasis:'historical_correction',proof:'synthetic preflight only',blockingReason:'source_snapshot_incomplete'}});
  assert.ok(captured);const job=await claim(db);
  if(job.result==='leased')await q(db,"select pos_shadow_settle($1,$2,'owner')",[job.jobId,job.token]);
  await q(db,"select pos_signed_compare(1,'owner')");await q(db,"select inventory_writer_inspect('owner')");
  assert.deepEqual(await operatingSnapshot(db),before,'observation writes must be private-only');
  assert.deepEqual(await allBusinessRows(db),business,'observation must preserve payments, ledger and every public fixture table');
  // Installation DOES alter existing writer behavior even with no Shadow flag.
  await assert.rejects(db.exec('delete from inventory where id=2'),/IMMUTABLE/);
  await assert.rejects(db.exec('update inventory set quantity=21 where id=2'),e=>e.code==='42501');
  t.diagnostic('private observation isolation PASS; transparent installation compatibility BLOCKED by unconditional fences');
 }finally{await db.close();const c=await rt.connect('postgres');await c.query('checkpoint');await c.end();}
});
