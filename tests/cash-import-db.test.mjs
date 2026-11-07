import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,dump} from './helpers/cash-import-fixture.mjs';
import {renderCashBatch} from '../scripts/ledger/cash-import-batch.mjs';
import {normalizeFundMovementRows,fundOpeningBoundaries,fundMovementInScope,buildFundAccountView} from '../lib/ledger/fund-account-view.ts';
import {computeDashboardFundFlows} from '../lib/ledger/dashboard-cash-report.ts';
const root=process.env.JULY_PHASE4_INPUT_DIR,opts={skip:!root};
const approved=b=>renderCashBatch(b).replaceAll('__ACTOR_USER_ID__','2').replaceAll('__OWNER_APPROVAL__','APPROVED:'+b.digest);
async function execute(db,sql){try{return await db.exec(sql);}catch(e){throw Error(e.message+(e.where?' '+e.where:'')+(e.position?' near '+sql.slice(Math.max(0,Number(e.position)-80),Number(e.position)+80):''));}}
async function failure(db,sql,pattern){const before=JSON.stringify(await dump(db));await assert.rejects(execute(db,sql),pattern);await db.exec('rollback');assert.equal(JSON.stringify(await dump(db)),before);}
async function apply(db,b){return execute(db,approved(b));}
test('structure + actual 241 batch: 211 cash,278 legs,30 refs,154 old anchors preserved,124 cells,zero-write replay',opts,async()=>{
 const {db,bundle}=await fixture(root);try{
  const before=await dump(db);
  const pre=(await db.query('select ledger_preflight_cash_import_v1($1,$2,2) r',[bundle.canonical,bundle.digest])).rows[0].r;assert.equal(pre.matchedCells,124);assert.equal(pre.status,'ready');
  await apply(db,bundle);
  const state=(await db.query("select ledger_cash_import_status_v1('2026-07-01',2) r")).rows[0].r;assert.deepEqual(state,{rows:395,cashReconciled:true,economicClosed:false,economicPending:241});
  const after=await dump(db);assert.equal(after.ledger_transactions.length-before.ledger_transactions.length,211);assert.equal(after.ledger_movements.length-before.ledger_movements.length,278);
  for(const table of Object.keys(before))for(const old of before[table])assert.deepEqual(after[table].find(x=>x.id===old.id),old,table+':'+old.id);
  assert.equal((await db.query("select count(*)::int n from ledger_import_rows where cash_status='reference_only'")).rows[0].n,30);
  assert.equal((await db.query('select count(*)::int n from ledger_import_source_claims')).rows[0].n,bundle.manifest.bootstrapClaims);
  assert.equal((await db.query("select count(*)::int n from ledger_transactions where type='historical_cash_event' and (category_id is not null or recognition_month is not null)")).rows[0].n,0);
  const snapshot=JSON.stringify(await dump(db));const registry=(await db.query('select * from ledger_import_rows order by source_key')).rows;
  await apply(db,bundle);assert.equal(JSON.stringify(await dump(db)),snapshot);assert.deepEqual((await db.query('select * from ledger_import_rows order by source_key')).rows,registry);
  await execute(db,renderCashBatch(bundle,'postflight').replaceAll('__ACTOR_USER_ID__','2'));
  assert.equal(JSON.stringify(await dump(db)),snapshot);
 }finally{await db.close();}
});
test('owner/approval gates and last-target mismatch roll back all registry/cash writes',opts,async()=>{
 const {db,bundle}=await fixture(root);try{
  await failure(db,renderCashBatch(bundle).replaceAll('__ACTOR_USER_ID__','2'),/CASH_IMPORT_APPROVAL/);
  await failure(db,approved(bundle).replace("cash_import_actor='2'","cash_import_actor='3'"),/CASH_IMPORT_OWNER_REQUIRED/);
  // Approval is valid but the final target is wrong; all earlier395 rows must roll back.
  const {sha}=await import('../scripts/ledger/july-restore-phase2.mjs');const bad=structuredClone(bundle);bad.manifest.targets.at(-1).target='1';bad.canonical=JSON.stringify(bad.manifest);bad.digest=sha(bad.canonical);
  await failure(db,approved(bad),/CASH_IMPORT_DAILY_TARGET/);
  assert.equal((await db.query('select count(*)::int n from ledger_import_rows')).rows[0].n,0);
  assert.equal((await db.query('select count(*)::int n from ledger_import_source_claims')).rows[0].n,0);
  const wrong=structuredClone(bundle);wrong.contracts[0].hash='0'.repeat(64);await failure(db,approved(wrong),/CASH_IMPORT_ENGINE_CONTRACT/);
  const duplicate=structuredClone(bundle);duplicate.manifest.rows[1]=duplicate.manifest.rows[0];duplicate.canonical=JSON.stringify(duplicate.manifest);duplicate.digest=sha(duplicate.canonical);await failure(db,approved(duplicate),/CASH_IMPORT_SCOPE/);
  const cutoff=structuredClone(bundle);cutoff.manifest.cutoff='2026-09-01';cutoff.canonical=JSON.stringify(cutoff.manifest);cutoff.digest=sha(cutoff.canonical);await failure(db,approved(cutoff),/CASH_IMPORT_REAL_CUTOFF_OPENING_REQUIRED/);
 }finally{await db.close();}
});
test('rendered READ ONLY preflight normalizes actual CRLF prosrc and makes no writes',opts,async()=>{
 const {db,bundle}=await fixture(root,{crlf:true});try{
  const before=JSON.stringify(await dump(db));
  await execute(db,renderCashBatch(bundle,'preflight').replaceAll('__ACTOR_USER_ID__','2'));
  assert.equal(JSON.stringify(await dump(db)),before);
  assert.equal((await db.query('select count(*)::int n from ledger_import_rows')).rows[0].n,0);
 }finally{await db.close();}
});
test('actual cash rows drive July UI300353642; August+ live/snapshots/card unchanged and no income/expense classification',opts,async()=>{
 const {db,bundle}=await fixture(root);try{
  const accounts=(await db.query('select * from ledger_fund_accounts order by id')).rows;
  const rows=async()=>(await db.query("select m.fund_account_id,m.amount,jsonb_build_object('business_date',t.business_date,'type',t.type) transaction from ledger_movements m join ledger_transactions t on t.id=m.transaction_id where t.status='confirmed' order by m.id")).rows;
  const view=(raw,month,mode='provisional',closeSummary=null)=>{
   const normalized=normalizeFundMovementRows(raw).filter(m=>m.transaction.business_date.slice(0,7)<=month),boundaries=fundOpeningBoundaries(normalized,month),codes=new Map(accounts.map(f=>[f.id,f.code]));
   return buildFundAccountView({accounts,openingMovements:normalized.filter(m=>m.transaction.type==='opening'&&m.transaction.business_date===month+'-01'),movements:normalized.filter(m=>fundMovementInScope(codes.get(m.fund_account_id),m.transaction.business_date,month,boundaries.get(m.fund_account_id))),reservePlans:[],groupReserves:()=>new Map(),mode,closeSummary});
  };
  const before=await rows(),live=view(before,'2026-11','live');await apply(db,bundle);const after=await rows();
  assert.deepEqual(view(after,'2026-11','live'),live);
  const july=view(after,'2026-07');assert.equal(july.filter(a=>a.code!=='card_clearing').reduce((s,a)=>s+a.balance,0),300353642);
  assert.deepEqual(july.filter(a=>a.code!=='card_clearing').map(a=>a.balance),[95464986,104186605,95470741,5231310]);
  for(const month of ['2026-08','2026-09','2026-10']){
   const snapshot={funds:{accounts:accounts.map(f=>({id:f.id,code:f.code,balance:12345+f.id}))}};
   assert.deepEqual(view(after,month,'closed_snapshot',snapshot),view(before,month,'closed_snapshot',snapshot));
  }
  const transactions=(await db.query("select t.*,coalesce(jsonb_agg(jsonb_build_object('amount',m.amount,'fund_account',jsonb_build_object('id',f.id,'code',f.code,'type',f.type))) filter(where m.id is not null),'[]') movements from ledger_transactions t left join ledger_movements m on m.transaction_id=t.id left join ledger_fund_accounts f on f.id=m.fund_account_id where t.source_type='sheet_cash_import' group by t.id")).rows;
  const flow=computeDashboardFundFlows(transactions,new Set([1,2,3,5]),'2026-07');
  assert.equal(flow.unclassifiedCashMovement,84991822);assert.equal(flow.actualCashOutflowMovement,0);assert.equal(flow.operatingIncomeMovement,0);assert.equal(flow.investmentCashFlow,0);assert.equal(flow.otherFundAdjustment,0);
 }finally{await db.close();}
});
test('source claims reuse cash, group shares do not double post; sealed native movements and financial close blocked',opts,async()=>{
 const {db,bundle}=await fixture(root);try{
  await apply(db,bundle);
  const key=n=>bundle.manifest.rows.find(r=>r.row===n).key;
  const cashBefore=JSON.stringify((await db.query('select * from ledger_movements order by id')).rows);
  const link=async(row,anchor)=>(await db.query('select ledger_link_import_source_v1($1,$2,$3,$4,null,2) r',[key(row),'pos_payment','6904',key(anchor)])).rows[0].r;
  assert.equal((await link(364,364)).status,'linked');assert.equal((await link(369,364)).status,'linked');
  const linked=JSON.stringify(await dump(db));assert.equal((await link(369,364)).status,'duplicate');assert.equal(JSON.stringify(await dump(db)),linked);
  await assert.rejects(link(12,12),/CASH_IMPORT_SOURCE_ALREADY_CLAIMED/);
  const occupied=(await db.query("select source_id,anchor_key from ledger_import_source_claims where source_kind='inventory_log' limit 1")).rows[0];
  await assert.rejects(db.query('select ledger_link_import_source_v1($1,$2,$3,$1,null,2)',[key(5),'inventory_log',occupied.source_id]),/CASH_IMPORT_SOURCE_ALREADY_CLAIMED/);
  assert.equal(JSON.stringify((await db.query('select * from ledger_movements order by id')).rows),cashBefore);
  const {sha}=await import('../scripts/ledger/july-restore-phase2.mjs');
  const incomeCategory=(await db.query("select id from ledger_categories where kind='income' and is_active order by id limit 1")).rows[0].id;
  const approval={anchorKey:key(364),type:'sales',amount:8907800,categoryId:incomeCategory,businessDate:'2026-07-29',recognitionMonth:'2026-07-01',reason:'Isolated QA explicit economic approval of identified group'};
  const canonical=JSON.stringify(approval),digest=sha(canonical);
  await assert.rejects(db.query('select ledger_recognize_import_group_v1($1,$2,$3,2)',[canonical,digest,'not-approved']),/CASH_IMPORT_ECONOMIC_APPROVAL/);
  const recognize=async(c=canonical,d=digest)=>(await db.query('select ledger_recognize_import_group_v1($1,$2,$3,2) r',[c,d,'APPROVED_ECONOMICS:'+d])).rows[0].r;
  assert.equal((await recognize()).status,'recognized');const economicState=JSON.stringify(await dump(db));assert.equal((await recognize()).status,'duplicate');assert.equal(JSON.stringify(await dump(db)),economicState);
  assert.equal(JSON.stringify((await db.query('select * from ledger_movements order by id')).rows),cashBefore);
  await db.query("select ledger_link_import_source_v1($1,'document','isolated-card-proof',$1,null,2)",[key(4)]);
  const badEconomic=JSON.stringify({...approval,anchorKey:key(4)});await assert.rejects(recognize(badEconomic,sha(badEconomic)),/CASH_IMPORT_ECONOMIC_EVIDENCE_REQUIRED/);
  const afterLinks=JSON.stringify(await dump(db));await apply(db,bundle);assert.equal(JSON.stringify(await dump(db)),afterLinks);
  const tx=(await db.query("select cash_transaction_id id from ledger_import_rows where source_key=$1",[key(364)])).rows[0].id;
  const {contracts4}=await import('../scripts/ledger/july-restore-phase4-plan.mjs');await db.exec(contracts4().manual.sql);
  await assert.rejects(db.query("select ledger_create_manual_transaction_v1('expense','2026-07-29T12:00:00+07','2026-07-01',1,70,null,1,null,'native retry','QA',2,'different-key')"),/CASH_IMPORT_PERIOD_SEALED/);
  await assert.rejects(db.query('insert into ledger_movements(transaction_id,fund_account_id,amount) values($1,5,1)',[tx]),/CASH_IMPORT_PERIOD_SEALED/);
  await assert.rejects(db.query("update ledger_transactions set status='cancelled' where id=$1",[tx]),/CASH_IMPORT_PERIOD_SEALED/);
  await assert.rejects(db.exec("insert into ledger_month_closures(month,closed_by,summary_snapshot,snapshot_hash) values('2026-07-01',2,'{}',repeat('a',64))"),/CASH_RECONCILED_NOT_ECONOMIC_CLOSED/);
  const perms=(await db.query("select has_table_privilege('service_role','public.ledger_import_rows','INSERT') can_insert,has_function_privilege('anon','public.ledger_import_cash_v1(text,text,text,bigint)','EXECUTE') anon_exec")).rows[0];assert.deepEqual(perms,{can_insert:false,anon_exec:false});
  // Synthetic already-imported June partial-payment fixture; not a source rescan.
  const juneKey='sheet:fixture:tab:june:row:1';
  const juneTx=(await db.query("insert into ledger_transactions(operation_id,type,occurred_at,business_date,amount,status,source_type,source_key,source_snapshot,source_fingerprint,source_synced_at,created_by,confirmed_by) values(gen_random_uuid(),'historical_cash_event','2026-06-20T12:00:00+07','2026-06-20',1,'confirmed','sheet_cash_import',$1,'{}',repeat('a',64),now(),2,2) returning id",['sheet-cash:'+juneKey])).rows[0].id;
  await db.query('insert into ledger_movements(transaction_id,fund_account_id,amount) values($1,1,-1)',[juneTx]);
  await db.query("insert into ledger_import_rows(source_key,profile_key,period,business_date,source_row,source_canonical,source_snapshot,source_fingerprint,cash_effects,reference_effects,source_role,cash_status,cash_transaction_id,economic_status,batch_digest,cash_sealed,created_by) values($1,'june-fixture','2026-06-01','2026-06-20',1,'{}','{}',repeat('a',64),'[{\"account\":\"store_cash\",\"amount\":\"-1\"}]','[]','inventory_combined','recorded',$2,'unclassified',repeat('b',64),true,2)",[juneKey,juneTx]);
  const crossBefore=JSON.stringify((await db.query('select * from ledger_movements order by id')).rows);
  await db.query("select ledger_link_import_source_v1($1,'document','cross-month-partial-invoice',$1,null,2)",[juneKey]);
  await db.query("select ledger_link_import_source_v1($1,'document','cross-month-partial-invoice',$2,null,2)",[key(35),juneKey]);
  assert.equal(JSON.stringify((await db.query('select * from ledger_movements order by id')).rows),crossBefore);
 }finally{await db.close();}
});
