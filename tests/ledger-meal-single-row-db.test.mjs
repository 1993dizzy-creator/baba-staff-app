import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {nativeInventoryPostgres} from './helpers/inventory-native-postgres.mjs';
import {install,approvedSql,applySql,snapshot,daily} from './helpers/ledger-meal-consolidation-fixture.mjs';
import {installEvidence,evidenceFreshManifest,expectedPairs,expectedDaily,accountEvidence} from './helpers/ledger-meal-evidence.mjs';
const require=createRequire(import.meta.url);
const {buildLedgerEntries}=require('../lib/ledger/entries.ts');
const one=async(db,sql,args=[]) => (await db.query(sql,args)).rows[0];
const save=async(db,amount,actor=1) => (await one(db,'select ledger_adjust_open_meal_transaction_v1(6001,$1,$2,$3) r',[amount,'현금 및 시트 검산',actor])).r;
async function entries(db){const sources=(await db.query('select * from ledger_candidates')).rows.map(c=>({resolvedTransactionId:Number(c.resolved_transaction_id),sourceSnapshot:c.source_snapshot,sourceDriftSnapshot:c.source_drift_snapshot,sourceDriftFingerprint:c.source_drift_fingerprint}));return buildLedgerEntries((await db.query(`select t.*,business_date::text business_date,occurred_at::text occurred_at,
  jsonb_build_object('id',category_id,'name',c.name) category from ledger_transactions t left join ledger_categories c on c.id=t.category_id where status='confirmed'
  and business_date between '2026-10-01' and '2026-10-31'`)).rows,[],new Map(),sources);}
async function cases(t,Database){
  const make=async()=>{const db=new Database();await install(db);t.after(()=>db.close());return db;};
  await t.test('original day cash, repeated increases/decreases/zero and original provenance',async()=>{
    const db=await make(),before=await snapshot(db);
    for(const [amount,delta] of [[330000,30000],[310000,-20000],[0,-310000]]){
      const result=await save(db,amount);assert.equal(result.status,'created');assert.equal(Number(result.economicDelta),delta);
      const row=await one(db,'select *,business_date::text as day from ledger_transactions where id=$1',[result.adjustmentTransactionId]);
      assert.equal(row.day,'2026-10-01');assert.equal(row.source_snapshot.attributionPolicy,'original_meal_business_date');
      assert.ok(new Date(row.occurred_at).getTime()>=Date.now()-60000);
      assert.equal(Number((await one(db,'select amount from ledger_movements where transaction_id=$1',[row.id])).amount),-delta);
      const meal=(await entries(db)).filter(e=>e.transactionId===6001);assert.equal(meal.length,1);assert.equal(meal[0].amount,amount);
      assert.equal(meal[0].mealAdjustments.at(-1).reason,'현금 및 시트 검산');
    }
    const after=await snapshot(db);assert.deepEqual(after.candidates,before.candidates);assert.deepEqual(after.closures,before.closures);
    const stable=await snapshot(db);assert.equal((await save(db,0)).status,'unchanged');assert.deepEqual(await snapshot(db),stable);
    assert.equal((await save(db,3,2)).status,'forbidden');
    const root=after.transactions.find(t=>t.id===6001),old=before.transactions.find(t=>t.id===6001);
    assert.deepEqual({...root,display_snapshot:old.display_snapshot},old);
  });
  await t.test('source month, business month, dated cash, candidate link, grants and failure atomicity',async()=>{
    const db=await make();const call=sql=>db.exec(sql);
    await call("update ledger_fund_accounts set active_from='2026-10-02' where id=1");
    const before=await snapshot(db);assert.equal((await save(db,330000)).status,'store_cash_unavailable');assert.deepEqual(await snapshot(db),before);
    await call("update ledger_fund_accounts set active_from='2026-01-01' where id=1");
    await call("update ledger_candidates set resolved_transaction_id=6002 where id=6001");
    assert.equal((await save(db,330000)).status,'invalid_meal_candidate_link');
    await call('update ledger_candidates set resolved_transaction_id=6001 where id=6001');
    await call("insert into ledger_month_closures(month,status) values('2026-10-01','closed')");
    assert.equal((await save(db,330000)).status,'original_month_closed');
    for(const role of ['anon','authenticated','service_role'])assert.equal((await one(db,"select has_function_privilege($1,'ledger_adjust_open_meal_transaction_v1(bigint,numeric,text,bigint)','execute') allowed",[role])).allowed,role==='service_role');
  });
  await t.test('manual duplicate blocked on actual 03:00 business day; other days remain supported',async()=>{
    const db=await make();
    const create=async date=>(await one(db,`select ledger_create_manual_transaction_v1('expense',$1,'2026-10-01',30000,7,null,1,null,'QA',null,1,null) r`,[date])).r;
    const before=await snapshot(db);
    assert.equal((await create('2026-10-02T02:59:00+07:00')).status,'automatic_meal_requires_adjustment');assert.deepEqual(await snapshot(db),before);
    assert.equal((await create('2026-10-28T03:00:00+07:00')).status,'created');
  });
  await t.test('execution month closure does not block an open original day; original business month remains protected',async()=>{
    const db=await make();
    await db.exec("update ledger_transactions set business_date='2026-07-15',recognition_month='2026-07-01' where id=6001");
    await db.exec("insert into ledger_month_closures(month,status) values(date_trunc('month',now())::date,'closed')");
    const result=await save(db,330000);assert.equal(result.status,'created');
    assert.equal((await one(db,'select business_date::text d from ledger_transactions where id=$1',[result.adjustmentTransactionId])).d,'2026-07-15');
    await db.exec("update ledger_transactions set recognition_month='2026-06-01' where id=6001");
    await db.exec("insert into ledger_month_closures(month,status) values('2026-07-01','closed')");
    const before=await snapshot(db);assert.equal((await save(db,360000)).status,'adjustment_business_month_closed');assert.deepEqual(await snapshot(db),before);
  });
  await t.test('20 / 630000 consolidation: 108/108 daily values, P&L, 27 automatic rows, reasons, history, rerun blocked',async()=>{
    const db=await make(),before=await snapshot(db),days=await daily(db),sql=await approvedSql(db);
    assert.equal(days.length,108);assert.equal((await entries(db)).filter(e=>e.drilldown==='meal'&&e.businessDate.startsWith('2026-10')).length,27);
    await db.exec("create schema supabase_migrations; create table supabase_migrations.schema_migrations(version text,name text)");
    await db.exec(sql);const after=await snapshot(db);
    assert.deepEqual(await daily(db),days);
    assert.equal(after.transactions.filter(t=>t.status==='cancelled'&&t.id>=7001&&t.id<=7020).length,20);
    const corrections=after.transactions.filter(t=>t.source_snapshot.batch);assert.equal(corrections.length,20);
    assert.equal(corrections.reduce((s,t)=>s+Number(t.amount),0),630000);
    assert.equal(corrections.filter(t=>String(t.business_date).startsWith('2026-10-28')).length,0);
    assert.deepEqual(after.candidates,before.candidates);assert.deepEqual(after.closures,before.closures);
    for(const old of before.transactions.filter(t=>t.id<7001||t.id>7020))assert.deepEqual(after.transactions.find(t=>t.id===old.id),old);
    for(const m of before.movements)assert.deepEqual(after.movements.find(t=>t.id===m.id),m);
    const rows=(await entries(db)).filter(e=>e.businessDate.startsWith('2026-10')&&(e.drilldown==='meal'||e.categoryName==='직원 식대'));
    assert.equal(rows.length,28,'27 automatic meals plus protected TX2163 history in October');
    for(const row of rows.filter(e=>e.drilldown==='meal'))assert.equal(rows.filter(e=>e.businessDate===row.businessDate&&e.drilldown==='meal').length,1);
    assert.equal(rows.find(e=>e.transactionId===6001).mealAdjustments.length,1);
    assert.equal(rows.find(e=>e.transactionId===6002).requiresCorrection,true,'consolidation does not silently review outstanding source drift');
    assert.match(rows.find(e=>e.transactionId===6001).mealAdjustments[0].reason,/시트 식대 추가 검산/);
    assert.equal(after.audits.filter(a=>a.action==='manual_transaction_cancelled').length,20);
    assert.equal(after.audits.filter(a=>a.action==='meal_manual_consolidated').length,20);
    // Execute the actual postflight report (history table is a local fixture).
    const report=await db.exec(readFileSync('scripts/ledger/oct-meal-consolidation-postflight.sql','utf8'));
    const results=Array.isArray(report)?report:[report];const row=results.flatMap(r=>r.rows??[]).find(r=>'completed_once' in r);
    assert.ok(row);for(const key of ['completed_once','all_daily_movements_unchanged','monthly_profit_unchanged','tx2112_tx2163_unchanged','closures_unchanged','source_drift_unchanged'])assert.equal(row[key],true,key);
    assert.equal(Number(row.matching_account_days),108);
    await assert.rejects(db.exec(sql),/BATCH_ALREADY_APPLIED/);await db.exec('rollback');assert.deepEqual(await snapshot(db),after);
  });
  await t.test('late failure rolls back the ENTIRE batch including prior cancellations and audits',async()=>{
    const db=await make();let sql=await approvedSql(db);const before=await snapshot(db);
    // The last reviewed row has changed; the first nineteen must not survive.
    sql=sql.replace(/("manual_id":(?:"7020"|7020)[^}]*"manual_hash":")[a-f0-9]+"/,'$1stale"');
    await assert.rejects(db.exec(sql));await db.exec('rollback');assert.deepEqual(await snapshot(db),before);
  });
  await t.test('empty/unverified evidence, stale hashes, wrong account, September parent and closed October refuse without writes',async()=>{
    for(const mode of ['empty','evidence','nullDate','hash','account','parent','closed']){
      const db=await make();let sql=mode==='empty'?applySql():await approvedSql(db);
      if(mode==='evidence')sql=sql.replace(/"amount":"-390000"/,'"amount":"-390001"');
      if(mode==='nullDate')sql=sql.replace(/"business_date":"2026-10-01"/,'"business_date":null');
      if(mode==='hash')sql=sql.replace(/"manual_hash":"[a-f0-9]+"/,'"manual_hash":"stale"');
      if(mode==='account')await db.exec('update ledger_movements set fund_account_id=2 where transaction_id=7020');
      if(mode==='parent')sql=sql.replace(/"automatic_id":(?:"6020"|6020)/,'"automatic_id":2112');
      if(mode==='closed')await db.exec("insert into ledger_month_closures(month,status) values('2026-10-01','closed')");
      const before=await snapshot(db);await assert.rejects(db.exec(sql),undefined,mode);await db.exec('rollback');assert.deepEqual(await snapshot(db),before,mode);
    }
  });
  await t.test('supplied operating snapshot: exact 20 IDs, Oct24 +60000, 30 single rows and real 108 account-day baseline preserved',async()=>{
    const db=new Database();await installEvidence(db);t.after(()=>db.close());
    assert.equal(expectedPairs.length,20);assert.equal(expectedPairs.reduce((sum,p)=>sum+p.amount,0),630000);
    assert.equal(expectedDaily.length,108);
    assert.equal(accountEvidence.filter(e=>e.is_within_108_baseline==='True'&&e.app_minus_sheet_vnd==='0').length,108);
    assert.equal(accountEvidence.filter(e=>e.is_within_108_baseline==='False'&&e.app_minus_sheet_vnd!=='0').length,10);
    await db.exec("create schema supabase_migrations; create table supabase_migrations.schema_migrations(version text,name text)");
    const pre=await db.exec(readFileSync('scripts/ledger/oct-meal-consolidation-preflight.sql','utf8'));
    const preRows=(Array.isArray(pre)?pre:[pre]).flatMap(r=>r.rows??[]),proposal=preRows.find(r=>'proposed_count' in r);
    assert.equal(Number(proposal.proposed_count),20);assert.equal(Number(proposal.proposed_amount),630000);
    const check=async()=> (await one(db,readFileSync('scripts/ledger/evidence/20261031/preflight_108_recheck_READONLY.sql','utf8')));
    assert.deepEqual([Number((await check()).checks),Number((await check()).passed),Number((await check()).failed)],[108,108,0]);
    const before=await snapshot(db),beforeDaily=await daily(db);
    const sql=applySql().replace("v_manifest jsonb := '[]'",`v_manifest jsonb := '${JSON.stringify(await evidenceFreshManifest(db))}'`).replace('v_actor bigint := null','v_actor bigint := 1');
    await db.exec(sql);
    assert.deepEqual(await daily(db),beforeDaily);assert.equal(Number((await check()).passed),108);
    const after=await snapshot(db),rows=await entries(db),meals=rows.filter(e=>e.drilldown==='meal');assert.equal(meals.length,30);
    for(const p of expectedPairs){assert.equal(after.transactions.find(t=>t.id===p.manual_id).status,'cancelled');
      const meal=meals.find(e=>e.transactionId===p.automatic_id);assert.equal(meal.effectiveAmount,p.final_amount);assert.equal(meal.adjustmentAmount,p.amount);
      assert.equal(meals.filter(e=>e.businessDate===p.business_date).length,1);}
    assert.equal(meals.find(e=>e.transactionId===3135).adjustmentAmount,60000);
    assert.deepEqual(after.candidates,before.candidates);assert.deepEqual(after.closures,before.closures);
    for(const id of [2112,2163,3385])assert.deepEqual(after.transactions.find(t=>t.id===id),before.transactions.find(t=>t.id===id));
    for(const date of ['2026-10-28','2026-10-29','2026-10-30'])assert.equal(meals.find(e=>e.businessDate===date).adjustmentCount,0);
    assert.equal(meals.find(e=>e.transactionId===2629).requiresCorrection,true,'15th source revision still requires review');
    assert.equal(meals.find(e=>e.transactionId===3135).requiresCorrection,true,'24th source revision still requires review');
    const preserved=await snapshot(db);await assert.rejects(db.exec(sql),/BATCH_ALREADY_APPLIED/);await db.exec('rollback');assert.deepEqual(await snapshot(db),preserved);
  });
}
test('single-row meals on isolated PostgreSQL WASM',async t=>cases(t,PGlite));
test('single-row meals on native PostgreSQL',{skip:!process.env.QA_POSTGRES_BIN,timeout:180000},async t=>{
  const runtime=await nativeInventoryPostgres({testContext:t});t.diagnostic(runtime.version);await cases(t,runtime.Database);
  await t.test('two simultaneous identical adjustments serialize to exactly one cash delta',async()=>{
    const db=new runtime.Database();await install(db);await db.ready;t.after(()=>db.close());
    const peer=await runtime.connect(db.name);t.after(()=>peer.end());
    const results=await Promise.all([save(db,330000),save(peer,330000)]);
    assert.deepEqual(results.map(r=>r.status).sort(),['created','unchanged']);
    const row=await one(db,"select count(*) n,sum(amount*economic_effect_sign) amount from ledger_transactions where correction_of_id=6001");
    assert.equal(Number(row.n),1);assert.equal(Number(row.amount),30000);
    assert.equal(Number((await one(db,"select sum(m.amount) amount from ledger_movements m join ledger_transactions t on t.id=m.transaction_id where correction_of_id=6001 and business_date='2026-10-01'")).amount),-30000);
  });
});
