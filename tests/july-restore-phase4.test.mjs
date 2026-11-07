// Isolated in-memory PostgreSQL. Never loads env files, keys or a production client.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {phase4Plan,renderPhase4,contracts4,READY,FUNDS} from '../scripts/ledger/july-restore-phase4-plan.mjs';
import {sha} from '../scripts/ledger/july-restore-phase2.mjs';
import {parseCsv} from '../scripts/ledger/july-restore-source-review.mjs';
import {renderPhase3} from '../scripts/ledger/july-restore-phase3-plan.mjs';
const root=process.env.JULY_PHASE4_INPUT_DIR;
const opts={skip:!root};
const read=p=>readFileSync(p,'utf8'),load=p=>JSON.parse(read(join(root,p)));
function evidence(){const capture=load('phase4-runtime-20261107-r2/runtime-readonly.json'),prior=load('phase3-final-20261107-r2/remaining-312.json'),phase3=load('phase3-final-20261107-r2/bundle.json'),target=read(join(root,'july_2026_daily_targets.csv'));return {capture,prior,phase3,target,result:phase4Plan(prior,phase3,capture,target)};}
function approved(p){return renderPhase4(p).replaceAll('__ACTOR_USER_ID__','2').replaceAll('__OWNER_APPROVAL__','APPROVED:'+sha(JSON.stringify(p)));}
const tables=['ledger_transactions','ledger_movements','ledger_audit_logs','ledger_candidates','ledger_payables','ledger_payable_allocations','ledger_card_reconciliations','ledger_card_reconciliation_lines','ledger_card_fee_closures','ledger_card_fee_allocation_lines','ledger_fund_accounts','ledger_month_closures','ledger_month_closure_history','ledger_rent_contracts','ledger_rent_contract_payments','ledger_recurring_expense_plans','ledger_owner_participants','ledger_owner_investments','payroll_monthly_adjustments','payroll_payment_batches'];
async function dump(db){const r={};for(const t of tables)r[t]=(await db.query(`select * from ${t} order by id`)).rows;return JSON.stringify(r);}
async function fixture(){
 const {PGlite}=createRequire(process.env.JULY_QA_PACKAGE_JSON||import.meta.url)('@electric-sql/pglite'),db=new PGlite(),{capture,result}=evidence(),t=capture.tables;
 await db.exec(read('tests/ledger-july-opening-oneoff-db.test.mjs').match(/const FIXTURE = `([\s\S]*?)`;/)[1]);
 await db.exec(`alter table users add column name text,add column full_name text,add column username text,add column is_system_account boolean default false,add column payroll_eligible_override boolean;
 update users set username='fixture-'||id;
 alter table ledger_categories add column kind text default 'expense',add column is_active boolean default true;
 create table ledger_candidates(id bigint primary key,status text);
 create table ledger_payables(id bigint primary key,expense_transaction_id bigint,status text);
 create table ledger_payable_allocations(id bigint primary key,payable_id bigint,payment_transaction_id bigint,allocated_amount numeric);
 insert into ledger_payables values(1830,3804,'paid');insert into ledger_payable_allocations values(1,1830,1796,15426000);
 create table ledger_card_reconciliations(id bigint primary key,status text);insert into ledger_card_reconciliations select id,'matched' from generate_series(1,69) id;
 create table ledger_card_reconciliation_lines(id bigint primary key,transaction_id bigint);insert into ledger_card_reconciliation_lines values(1,1190);
 create table ledger_card_fee_closures(id bigint primary key);create table ledger_card_fee_allocation_lines(id bigint primary key);
 create table ledger_month_closure_history(id bigint primary key,month date,snapshot_hash text);
 create table ledger_owner_participants(id bigint primary key,proof jsonb);
 create table ledger_owner_investments(id bigint primary key,proof jsonb);
 create table ledger_recurring_expense_plans(id bigint primary key,name text);insert into ledger_recurring_expense_plans values(3,'existing monthly rent');
 create table ledger_reserve_plans(id bigint primary key);insert into ledger_reserve_plans values(1);
 create table payroll_payment_batches(id bigint primary key,payroll_month date,status text);
 `);
 const advanceTest=read('tests/ledger-payroll-advance-db.test.mjs'),advanceSchema=advanceTest.match(/const schema = `([\s\S]*?)`;/)[1];
 const a=advanceSchema.indexOf('  create table public.payroll_monthly_adjustments'),b=advanceSchema.indexOf('  create table public.ledger_transactions');
 await db.exec(advanceSchema.slice(a,b));
 const rent=read('supabase/migrations/20261028140000_add_rent_contracts.sql');
 await db.exec(rent.slice(rent.indexOf('create table public.ledger_rent_contracts'),rent.indexOf('alter table public.ledger_rent_contracts enable')));
 async function insertData(table,rows){const cols=(await db.query("select column_name,data_type from information_schema.columns where table_schema='public' and table_name=$1",[table])).rows;
  for(const r of rows){const fields=cols.filter(c=>Object.hasOwn(r,c.column_name));await db.query(`insert into ${table}(${fields.map(c=>c.column_name).join(',')}) values(${fields.map((_,i)=>'$'+(i+1)).join(',')})`,fields.map(c=>c.data_type==='jsonb'&&r[c.column_name]!==null?JSON.stringify(r[c.column_name]):r[c.column_name]));}}
 for(const c of t.categories)await db.query('insert into ledger_categories values($1,$2,$3,$4) on conflict(id) do update set name=excluded.name,kind=excluded.kind,is_active=excluded.is_active',[c.id,c.name,c.kind,c.is_active]);
 for(const id of new Set(t.julyTransactions.map(x=>x.party_id).filter(x=>x!==null)))await db.query("insert into ledger_parties values($1,'existing party fixture') on conflict(id) do nothing",[id]);
 for(const u of t.relevantUsers){await db.query('delete from users where id=$1 AND id NOT IN(1,2)',[u.id]);if(u.id!==1&&u.id!==2)await insertData('users',[u]);}
 // Old phases are loaded only as evidence data. Their SQL is never imported or executed.
 await db.exec("delete from ledger_movements where transaction_id in(select id from ledger_transactions where business_date<'2026-08-01');delete from ledger_transactions where business_date<'2026-08-01';");
 await insertData('ledger_transactions',t.julyTransactions.map(x=>({...x,created_by:2,confirmed_by:2})));
 await insertData('ledger_movements',t.movements);
 await insertData('ledger_audit_logs',t.julyAudits.map(x=>({...x,actor_user_id:2,entity_type:'transaction'})));
 // Actual protected August rent payment #1304, and the exact current rent metadata.
 // Assemble past fixture data before closing its months, then restore closure state.
 await db.exec("update ledger_month_closures set status='reopened';");
 const late=t.relatedLaterTransactions.find(x=>x.id===1304);
 await insertData('ledger_transactions',[{...late,operation_id:'00000000-0000-0000-0000-000000001304',occurred_at:'2026-08-11T05:00:00Z',source_fingerprint:'fixture-rent',source_synced_at:'2026-08-11T05:00:00Z',created_by:2,confirmed_by:2}]);
 await db.exec('alter table ledger_movements alter column id restart with 20000;insert into ledger_movements(transaction_id,fund_account_id,amount) values(1304,2,-300000000);');
 await insertData('ledger_rent_contracts',t.rentContracts);
 await insertData('ledger_rent_contract_payments',t.rentPayments);
 await db.exec("update ledger_month_closures set status='closed';");
 for(const x of t.ownerParticipants)await db.query('insert into ledger_owner_participants values($1,$2)',[x.id,JSON.stringify(x)]);
 for(const x of t.ownerInvestments)await db.query('insert into ledger_owner_investments values($1,$2)',[x.id,JSON.stringify(x)]);
 for(const c of Object.values(contracts4()))await db.exec(c.sql);
 await db.exec("alter table ledger_transactions alter column id restart with 6000;alter table ledger_audit_logs alter column id restart with 10000;");
 return {db,payload:result.payload};
}
async function execute(db,sql){try{return await db.exec(sql);}catch(e){const pos=Number(e.position||0);throw Error(e.message+(pos?' near '+sql.slice(Math.max(0,pos-100),pos+100):'')+(e.where?' '+e.where:''));}}
async function rollbackFailure(db,sql,pattern){const before=await dump(db);await assert.rejects(execute(db,sql),pattern);await db.exec('ROLLBACK');assert.equal(await dump(db),before);}

test('250-row route conservation, prior33 preserved, no capital/card guess, exact 124 target cells',opts,()=>{
 const {result,prior,phase3,capture,target}=evidence();
 assert.deepEqual(result.summary.readyRows,READY);assert.equal(result.rows.length,250);
 assert.deepEqual(Object.fromEntries(Object.entries(result.summary.totals).map(([k,v])=>[k,v.count])),{ready:9,pos_card:174,payable:19,held:48});
 assert.equal(result.summary.totals.ready.amount,324100000);
 assert.deepEqual(result.summary.totals.ready.fundDelta,{store_cash:-10100000,vuong_personal_custody:-5000000,cho_personal_custody:11800000,baba_corporate_bank:-300000000});
 for(const f of FUNDS)assert.equal(Object.values(result.summary.totals).reduce((s,t)=>s+t.fundDelta[f],0),result.summary.residualBefore[f]);
 assert.equal(result.daily.length,124);assert.equal(result.summary.matchingBefore,3);assert.equal(result.summary.matchingAfter,3);
 assert.equal(result.rows.filter(r=>r.state!=='hold').length,33);assert.ok(result.rows.filter(r=>r.state!=='hold').every(r=>!r.executable));
 assert.ok(result.rows.filter(r=>[184,267].includes(r.row)||r.phase4Route==='card').every(r=>!r.executable));
 const corrupt=structuredClone(capture);corrupt.tables.rentPayments[0].amount=1;assert.throws(()=>phase4Plan(prior,phase3,corrupt,target),/RENT_EVIDENCE/);
});
test('single batch: nine rows,14 movements, one menu cost; rent replacement, advances and all old rows protected; exact replay no writes',opts,async()=>{
 const {db,payload}=await fixture();try{
  const before=JSON.parse(await dump(db));await execute(db,approved(payload));
  const after=JSON.parse(await dump(db));
  assert.equal(after.ledger_transactions.length-before.ledger_transactions.length,9);
  assert.equal(after.ledger_movements.length-before.ledger_movements.length,14);
  for(const name of tables.filter(n=>!['ledger_rent_contract_payments'].includes(n)))for(const old of before[name])assert.deepEqual(after[name].find(r=>r.id===old.id),old,name+':'+old.id);
  assert.equal(after.payroll_monthly_adjustments.length,2);assert.equal(after.ledger_owner_investments.length,before.ledger_owner_investments.length);
  assert.equal(after.ledger_rent_contract_payments.length,2);assert.equal(after.ledger_rent_contract_payments[0].source,'ledger');
  assert.equal(after.ledger_rent_contract_payments.reduce((s,p)=>s+Number(p.amount),0),600000000);
  const fresh=after.ledger_transactions.filter(x=>x.id>=6000);assert.equal(fresh.filter(x=>x.type==='expense').length,1);assert.equal(fresh.filter(x=>x.recognition_month!==null).length,1);
  assert.equal(fresh.filter(x=>x.type==='transfer').length,5);assert.equal(fresh.filter(x=>x.type==='payroll_payment').length,2);
  assert.equal(fresh.find(x=>x.type==='prepaid_expense_payment').recognition_month,null);
  const applied=await dump(db);await execute(db,approved(payload));assert.equal(await dump(db),applied);
 }finally{await db.close();}
});
test('approval placeholders, changed action/bundle/hash/scope and unauthorized actor fail before mutation',opts,async()=>{
 const {db,payload}=await fixture();try{
  assert.match(renderPhase4(payload),/__ACTOR_USER_ID__/);assert.match(renderPhase4(payload),/__OWNER_APPROVAL__/);
  await rollbackFailure(db,renderPhase4(payload),/JULY_PHASE4_APPROVAL/);
  await rollbackFailure(db,approved(payload).replace("baba.july_phase4_actor='2'","baba.july_phase4_actor='3'"),/JULY_PHASE4_OWNER/);
  const bad=structuredClone(payload);bad.bundle.actions[0].effects[0].amount='-1';
  await rollbackFailure(db,approved(bad),/JULY_PHASE4_APPROVAL/);
  const duplicate=structuredClone(payload);duplicate.bundle.actions[1]=duplicate.bundle.actions[0];duplicate.bundleCanonical=JSON.stringify(duplicate.bundle);duplicate.bundleDigest=sha(duplicate.bundle);
  await rollbackFailure(db,approved(duplicate),/JULY_PHASE4_SCOPE/);
  const changed=structuredClone(payload);changed.bundle.rpcContracts.manual.hash='0'.repeat(64);changed.bundleCanonical=JSON.stringify(changed.bundle);changed.bundleDigest=sha(changed.bundle);
  await rollbackFailure(db,approved(changed),/JULY_PHASE4_RPC_CONTRACT/);
 }finally{await db.close();}
});
test('late row failure rolls back prior rent conversion, native movements and payroll adjustments; closed July blocks',opts,async()=>{
 const {db,payload}=await fixture();try{
  // Inject failure at LAST row after rent and both advances have already executed.
  await db.exec("create function public.phase4_qa_fail() returns trigger language plpgsql as $$begin if new.source_key like '%row:299' then raise exception 'QA_LAST_ROW_FAILURE';end if;return new;end$$;create trigger qa_phase4 before insert on ledger_transactions for each row execute function phase4_qa_fail();");
  await rollbackFailure(db,approved(payload),/QA_LAST_ROW_FAILURE/);
  await db.exec("drop trigger qa_phase4 on ledger_transactions;insert into ledger_month_closures(month,closed_by,summary_snapshot,snapshot_hash) values('2026-07-01',2,'{}',repeat('a',64));");
  await rollbackFailure(db,approved(payload),/LEDGER_MONTH_CLOSED/);
 }finally{await db.close();}
});
test('external payroll adjustment and rent evidence drift are fail-closed',opts,async()=>{
 const {db,payload}=await fixture();try{
  await db.exec("insert into payroll_monthly_adjustments(user_id,payroll_month,kind,category,amount,business_date,reason,source_key,created_by) values(4,'2026-07-01','advance','advance',1000000,'2026-07-20','existing','different-proof',2);");
  await rollbackFailure(db,approved(payload),/JULY_PHASE4_ADVANCE_OVERLAP/);
  await db.exec("delete from payroll_monthly_adjustments;update ledger_rent_contract_payments set memo='new evidence' where id=1;");
  await rollbackFailure(db,approved(payload),/JULY_PHASE4_RENT_PAYMENT_DRIFT/);
 }finally{await db.close();}
});
test('account/category drift and source collision block; protected allocation mutation rolls back the whole batch',opts,async()=>{
 const {db,payload}=await fixture();try{
  await db.exec("update ledger_fund_accounts set active_from='2026-07-01' where id=1;");
  await rollbackFailure(db,approved(payload),/JULY_PHASE4_ACCOUNT_DRIFT/);
  await db.exec("update ledger_fund_accounts set active_from='2026-08-01' where id=1;update ledger_categories set name='changed category' where id=70;");
  await rollbackFailure(db,approved(payload),/JULY_PHASE4_CATEGORY_DRIFT/);
  await db.query('update ledger_categories set name=$1 where id=70',[payload.bundle.category.name]);
  await db.query("select ledger_create_manual_transaction_v1('transfer','2026-07-03T12:00:00+07',null,1300000,null,null,1,3,'preexisting','proof',2,$1)",[payload.bundle.actions[0].sourceKey]);
  await rollbackFailure(db,approved(payload),/JULY_PHASE4_SOURCE_COLLISION/);
  // The fixture-added source collision is removed locally, never in production.
  await db.exec("delete from ledger_audit_logs where entity_id>=6000;delete from ledger_movements where transaction_id>=6000;delete from ledger_transactions where id>=6000;");
  await db.exec("create function phase4_qa_allocation_mutation() returns trigger language plpgsql as $$begin if new.source_key like '%row:299' then update ledger_payable_allocations set allocated_amount=allocated_amount+1;end if;return new;end$$;create trigger qa_allocation after insert on ledger_transactions for each row execute function phase4_qa_allocation_mutation();");
  await rollbackFailure(db,approved(payload),/JULY_PHASE4_PROTECTED_CHANGED/);
 }finally{await db.close();}
});
test('phase3 archive blocks CLI rendering; phase4 SQL has no inventory/POS scan, migration or public function install',opts,()=>{
 const guard=read('scripts/ledger/july-restore-phase3-plan.mjs');assert.match(guard,/PHASE3_ALREADY_APPLIED_DO_NOT_RENDER/);
 assert.throws(()=>renderPhase3({}),/PHASE3_ALREADY_APPLIED_DO_NOT_RENDER/);
 assert.ok(read(join(root,'phase3-final-20261107-r2/README-APPLIED-DO-NOT-RERUN.md')).includes('4327'));
 const sql=renderPhase4(evidence().result.payload);assert.doesNotMatch(sql,/\b(?:from|update|into|table)\s+(?:public\.)?(?:inventory_logs|inventory|pos_sales)\b/i);
 assert.doesNotMatch(sql,/create (?:or replace )?function public\./i);assert.match(sql,/statement_timeout='90s'/);
});
test('final artifacts match exact SQL renderer, raw text SHA-256, canonical approval and CSV fund effects',opts,()=>{
 const out=join(root,'phase4-final-20261107-r2'),p=JSON.parse(read(join(out,'bundle.json'))),verification=JSON.parse(read(join(out,'verification.json')));
 assert.equal(read(join(out,'next-batch-REQUIRES-OWNER-DB-APPROVAL.sql')),renderPhase4(p));
 assert.equal(verification.payloadSha,sha(JSON.stringify(p)));assert.equal(p.bundleDigest,sha(p.bundleCanonical));
 for(const [n,h] of Object.entries(verification.files))assert.equal(sha(read(join(out,n))),h,n);
 const ready=parseCsv(read(join(out,'ready-9.csv')));assert.equal(ready.length,9);
 for(const r of ready)assert.deepEqual(JSON.parse(r.effects),p.bundle.actions.find(a=>a.row===Number(r.row)).effects);
 assert.equal(parseCsv(read(join(out,'remaining-250.csv'))).length,250);
 assert.equal(parseCsv(read(join(out,'daily-124-impact.csv'))).length,124);
});
