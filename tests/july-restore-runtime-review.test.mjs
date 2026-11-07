// Offline cached observations only. Never loads production env or calls a DB API.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {reviewJulyRuntime} from '../lib/ledger/july-restore-runtime-review.mjs';
import {renderJulyBatch} from '../scripts/ledger/july-restore-dry-run.mjs';
import {digest,stable} from '../lib/ledger/july-restore-plan.ts';
const root=process.env.JULY_INPUT_DIR;
const enabled=Boolean(root);
const read=path=>JSON.parse(readFileSync(path,'utf8'));
function inputs(){return {baseline:read(root+'/dry-run-20261107-v2/395-row-dry-run.json'),snapshot:read(root+'/runtime-20261107-r1/runtime-readonly.json'),extra:read(root+'/runtime-20261107-r1/runtime-extra.json').rows,labels:read(root+'/runtime-20261107-r1/pos-receipt-labels.json').rows};}
const run=x=>reviewJulyRuntime(x.baseline,x.snapshot,x.extra,x.labels);

test('cached observations: 49 safe, 28 card blocked, five economic questions, 61 unique source links',{skip:!enabled},()=>{
 const r=run(inputs());assert.equal(r.summary.baselineReconciliation,'REUSED_WITHOUT_RERUN');
 assert.deepEqual(r.summary.candidate82.statuses,{ready:49,card_blocked:28,needs_confirmation:5});
 assert.deepEqual(r.summary.candidate82.deltas,{store_cash:'-15650800',vuong_personal_custody:'-50000',cho_personal_custody:'4570800',baba_corporate_bank:'-94655'});
 assert.equal(r.summary.links148.sourceLinked,61);assert.equal(r.summary.links148.fullyLinkedNoncardRows,10);
 assert.ok(r.links.every(l=>l.postingStatus==='GROUP_REQUIRED'));assert.equal(r.summary.card.batchStatus,'BLOCKED');
});
test('category drift, already-used row and pending meal never become executable',{skip:!enabled},()=>{
 const x=inputs();x.snapshot.tables.categories.find(c=>c.id===6).is_active=false;
 assert.equal(run(x).summary.candidate82.statuses.ready,18);
 const y=inputs(),r=run(y),ready=r.candidates.filter(c=>c.status==='ready');
 y.extra.rowAudits.push({reason:ready[0].key});
 const meal=ready.find(c=>c.kind==='meal'&&c.row!==ready[0].row);
 y.snapshot.tables.julyCandidates.push({status:'pending',candidate_type:'employee_meal',business_date:meal.date,proposed_amount:meal.amount,proposed_category_id:6});
 assert.equal(run(y).summary.candidate82.statuses.ready,47);
});
test('same-amount POS is insufficient: table mismatch, ambiguous payment or duplicate ID stays unlinked',{skip:!enabled},()=>{
 const x=inputs(),r=run(x),link=r.links.find(l=>l.kind==='pos_receipt_payment');
 const label=x.labels.find(l=>l.id===link.receiptIds[0]);label.table_name='999';
 assert.ok(!run(x).links.some(l=>l.row===link.row));
 const y=inputs(),original=y.snapshot.tables.posPaymentsJuneJuly.find(p=>p.id===link.paymentIds[0]);
 y.snapshot.tables.posPaymentsJuneJuly.push({...original,id:99999999});
 assert.ok(!run(y).links.some(l=>l.row===link.row));
 y.snapshot.tables.posPaymentsJuneJuly.push({...original});assert.throws(()=>run(y),/DUPLICATE_POS_SOURCE_ID/);
});
test('69 reconciliations include four cancelled: never count cancelled principal or infer June carryover',{skip:!enabled},()=>{
 const x=inputs(),r=run(x);assert.equal(r.summary.card.activeReconciliations,65);assert.equal(r.summary.card.cancelledReconciliations,4);
 assert.equal(r.summary.card.juneOriginalSales,'280147660');assert.equal(r.summary.card.juneCarryoverConfirmed,false);
 assert.equal(r.summary.card.currentBalance,'21441362');assert.equal(r.summary.card.projectedIfUnblocked,'15339015');
 assert.equal(r.summary.card.knownSheetSourceDifferences,'3397000');assert.equal(r.summary.card.remainingWithOriginalPos,'-2705347');
 const cancelled=x.snapshot.tables.cardReconciliations.find(c=>c.status==='cancelled'),line=x.snapshot.tables.cardAllocationLines.find(l=>l.reconciliation_id===cancelled.id);
 assert.ok(line);line.allocated_gross_amount=999999999;
 const next=run(x);assert.deepEqual(next.summary.card.activeAllocationPeriods,r.summary.card.activeAllocationPeriods);assert.notEqual(next.summary.card.protectedFingerprint,r.summary.card.protectedFingerprint);
});

async function fixture(observations){
 const {PGlite}=createRequire(process.env.JULY_QA_PACKAGE_JSON||import.meta.url)('@electric-sql/pglite');const db=new PGlite();
 const original=readFileSync('tests/ledger-july-opening-oneoff-db.test.mjs','utf8');
 await db.exec(original.match(/const FIXTURE = `([\s\S]*?)`;/)[1]);
 await db.exec('alter table ledger_transactions alter column id restart with 4207');
 await db.exec(readFileSync('scripts/ledger/july-opening-4funds-20261106-ONE-OFF.sql','utf8').replaceAll('__ACTOR_USER_ID__','2').replaceAll('__OWNER_APPROVAL__','APPROVED:july-opening-4funds-20261106'));
 await db.exec(`alter table ledger_categories add column kind text;alter table ledger_categories add column is_active boolean default true;
 create schema supabase_migrations;create table supabase_migrations.schema_migrations(version text primary key);insert into supabase_migrations.schema_migrations values('20261105153442');
 create table ledger_candidates(id bigint primary key,status text,business_date date,resolved_transaction_id bigint,source_snapshot jsonb,source_fingerprint text);
 create table ledger_payables(id bigint primary key,expense_transaction_id bigint,party_id bigint,status text);
 create table ledger_payable_allocations(id bigint primary key,payable_id bigint,payment_transaction_id bigint,allocated_amount numeric);
 create table ledger_card_reconciliations(id bigint primary key,deposit_transaction_id bigint,deposit_date date,status text);
 create table ledger_card_reconciliation_lines(id bigint primary key,reconciliation_id bigint,pos_card_transaction_id bigint,allocated_gross_amount numeric);
 create table ledger_month_closure_history(id bigint primary key,month date,snapshot_hash text);
 create table inventory_logs(id bigint primary key,quantity numeric);create table inventory(id bigint primary key,quantity numeric);
 create table pos_sales_receipts(id bigint primary key);create table pos_sales_receipt_lines(id bigint primary key);create table pos_sales_receipt_payments(id bigint primary key);
 insert into inventory values(1,100);insert into inventory_logs values(710,10);
 insert into ledger_card_reconciliations values(1,200,'2026-08-02','matched');insert into ledger_card_reconciliation_lines values(1,1,1190,10000);`);
 for(const c of observations.tables.categories)await db.query('insert into ledger_categories(id,name,kind,is_active) values($1,$2,$3,$4) on conflict(id) do update set name=excluded.name,kind=excluded.kind,is_active=excluded.is_active',[c.id,c.name,c.kind,c.is_active]);
 // Match the six observed transaction identities and five July movements. The
 // fixture's unrelated later-month history remains synthetic and protected.
 for(const t of observations.tables.julyTransactions)await db.query('update ledger_transactions set type=$2,status=$3,business_date=$4,recognition_month=$5,amount=$6,category_id=$7,source_type=$8,source_key=$9 where id=$1',[t.id,t.type,t.status,t.business_date,t.recognition_month,t.amount,t.category_id,t.source_type,t.source_key]);
 await db.exec("delete from ledger_movements where transaction_id in(1190,4207,4208,4209,4210)");
 for(const m of observations.tables.julyMovements)await db.query('insert into ledger_movements(id,transaction_id,fund_account_id,amount) values($1,$2,$3,$4)',[m.id,m.transaction_id,m.fund_account_id,m.amount]);
 await db.exec("select setval(pg_get_serial_sequence('ledger_movements','id'),(select max(id)+100 from ledger_movements))");
 const sql=readFileSync('supabase/migrations/20261031070537_meal_adjustment_original_business_date.sql','utf8');
 await db.exec(sql.match(/create or replace function public\.ledger_create_manual_transaction_v1\([\s\S]*?end \$\$;/i)[0]);
 return db;
}
const snapshotDb=async db=>(await db.query(`select jsonb_build_object('tx',(select jsonb_agg(to_jsonb(t) order by id) from ledger_transactions t),'mov',(select jsonb_agg(to_jsonb(m) order by id) from ledger_movements m),'audit',(select jsonb_agg(to_jsonb(a) order by id) from ledger_audit_logs a),'links',(select jsonb_agg(to_jsonb(l) order by id) from ledger_card_reconciliation_lines l)) x`)).rows[0].x;
const payloadHash=sql=>/encode\(sha256[\s\S]*?<>'([a-f0-9]{64})'/.exec(sql)?.[1];
const approved=raw=>{
 const bundleHash=/manifest->>'bundleDigest' IS DISTINCT FROM '([a-f0-9]{64})'/.exec(raw)?.[1];
 return raw.replaceAll('__ACTOR_USER_ID__','2').replaceAll('__OWNER_APPROVAL__',`APPROVED:july-restore:${bundleHash}:${payloadHash(raw)}`);
};
test('49-row rendered subset: exact expected fund changes, replay no-op, injected failure rolls all 49 back',{skip:!enabled},async()=>{
 const output=process.env.JULY_REVIEW_DIR||root+'/runtime-review-20261107-final';
 const observations=inputs(),summary=read(root+'/runtime-review-20261107-final/runtime-summary.json');
 const raw=readFileSync(output+'/safe-subset-REQUIRES-SEPARATE-DB-APPROVAL.sql','utf8');
 assert.ok(raw.includes('"runtimePreflight"'));
 const sql=payloadHash(raw)?approved(raw):raw.replaceAll('__ACTOR_USER_ID__','2').replaceAll('__OWNER_APPROVAL__','APPROVED:july-restore:'+summary.readyManifestDigest);
 const db=await fixture(observations.snapshot);
 try{
   const before=await snapshotDb(db);
   await assert.rejects(db.exec(sql.replace('IF pg_temp.july_protected()',"RAISE EXCEPTION 'SUBSET_INJECTED_FAILURE'; IF pg_temp.july_protected()")),/SUBSET_INJECTED_FAILURE/);
   await db.exec('ROLLBACK');assert.deepEqual(await snapshotDb(db),before);
   await db.exec(sql);const after=await snapshotDb(db);assert.equal(after.tx.length-before.tx.length,49);
   const movement=(await db.query("select f.code,sum(m.amount)::text delta from ledger_movements m join ledger_transactions t on t.id=m.transaction_id join ledger_fund_accounts f on f.id=m.fund_account_id where t.source_key like 'july-restore:sheet-row-%' group by f.code")).rows;
   for(const r of movement)assert.equal(String(BigInt(r.delta)),summary.candidate82.deltas[r.code]);
   await db.exec(sql);assert.deepEqual(await snapshotDb(db),after);
   assert.equal(after.tx.filter(t=>t.source_key?.startsWith('july-restore:sheet-row-')&&t.type==='expense').length,46);
   assert.equal(after.tx.filter(t=>t.source_key?.startsWith('july-restore:sheet-row-')&&t.type==='income').length,1);
   await db.exec("insert into ledger_candidates(id,status,business_date) values(1,'pending','2026-07-01')");
   const pending=await snapshotDb(db);
   await assert.rejects(db.exec(sql),/JULY_RUNTIME_CANDIDATE_DRIFT/);await db.exec('ROLLBACK');assert.deepEqual(await snapshotDb(db),pending);
   await db.exec('delete from ledger_candidates where id=1');
   await db.exec("insert into ledger_transactions(operation_id,type,status,business_date,occurred_at,recognition_month,amount,category_id,source_type,source_key,created_by,confirmed_by) values(gen_random_uuid(),'expense','confirmed','2026-07-31','2026-07-31T03:00:00+07:00','2026-07-01',100,25,'manual','another-writer',2,2)");
   const changed=await snapshotDb(db);
   await assert.rejects(db.exec(sql),/JULY_RUNTIME_TRANSACTION_DRIFT/);await db.exec('ROLLBACK');assert.deepEqual(await snapshotDb(db),changed);
 }finally{await db.close();}
});

const controlFile=()=>readFileSync(process.env.JULY_REVIEW_DIR+'/safe-subset-REQUIRES-SEPARATE-DB-APPROVAL.sql','utf8');
const insertPattern=/INSERT INTO july_restore_input VALUES \('((?:[^']|'')*)'::jsonb,'((?:[^']|'')*)'\);/;
const getPayload=sql=>JSON.parse(insertPattern.exec(sql)[1].replaceAll("''","'"));
function altered(sql,change,{rebind=false}={}){
 const payload=getPayload(sql);change(payload);const canonical=stable(payload),quote=s=>"'"+s.replaceAll("'","''")+"'";
 const previous=payloadHash(sql);
 let next=sql.replace(insertPattern,()=>`INSERT INTO july_restore_input VALUES (${quote(canonical)}::jsonb,${quote(canonical)});`);
 if(rebind)next=next.replaceAll(previous,digest(payload));return next;
}
async function rejectedUnchanged(db,raw,pattern){const before=await snapshotDb(db);await assert.rejects(db.exec(approved(raw)),pattern);await db.exec('ROLLBACK');assert.deepEqual(await snapshotDb(db),before);}

test('49 safeguards: reviewed bundle/payload binding, exact rows and unique submission keys',{skip:!enabled},async()=>{
 const raw=controlFile(),db=await fixture(inputs().snapshot);
 try{
  await rejectedUnchanged(db,altered(raw,p=>p.actions[0].date='2026-07-02'),/JULY_APPROVED_PAYLOAD_MISMATCH/);
  await rejectedUnchanged(db,altered(raw,p=>p.bundleDigest='f'.repeat(64),{rebind:true}),/JULY_APPROVED_PAYLOAD_MISMATCH/);
  await rejectedUnchanged(db,altered(raw,p=>p.actions.pop(),{rebind:true}),/JULY_BATCH_49_REQUIRED/);
  await rejectedUnchanged(db,altered(raw,p=>p.actions.push(p.actions[0]),{rebind:true}),/JULY_BATCH_49_REQUIRED/);
  await rejectedUnchanged(db,altered(raw,p=>{p.actions[1].rows=p.actions[0].rows;p.actions[1].rowNumbers=p.actions[0].rowNumbers;},{rebind:true}),/JULY_BATCH_ROW_OR_SUBMISSION_DUPLICATE/);
  await rejectedUnchanged(db,altered(raw,p=>p.actions[1].key=p.actions[0].key,{rebind:true}),/JULY_BATCH_ROW_OR_SUBMISSION_DUPLICATE/);
  await rejectedUnchanged(db,altered(raw,p=>p.actions[0].effects[0].amount='-1',{rebind:true}),/JULY_BATCH_APPROVED_DELTA_MISMATCH/);
  const bundle=read(root+'/runtime-review-20261107-final/safe-subset-bundle.json'),oldDigest=digest(bundle);
  bundle.actions.find(a=>a.kind==='meal').amount='1';
  assert.throws(()=>renderJulyBatch(bundle,{status:'REVIEWABLE',digest:oldDigest}),/BUNDLE_DIGEST_MISMATCH/);
  assert.throws(()=>renderJulyBatch(bundle,{status:'REVIEWABLE',digest:digest(bundle)}),/REVIEWED_49_BUNDLE_REQUIRED/);
 }finally{await db.close();}
});

test('49 safeguards: batch-level fund changes catch an unexpected July movement and roll back',{skip:!enabled},async()=>{
 const db=await fixture(inputs().snapshot);try{
  const injection=`INSERT INTO public.ledger_transactions(operation_id,type,status,business_date,occurred_at,amount,source_type,source_key,created_by,confirmed_by)
    VALUES(gen_random_uuid(),'transfer','confirmed','2026-07-31','2026-07-31T03:00:00+07:00',1,'manual','test-extra-transfer',2,2) RETURNING id INTO account_id;
    INSERT INTO public.ledger_movements(transaction_id,fund_account_id,amount) VALUES(account_id,1,-1),(account_id,3,1);
  `;
  const sql=controlFile().replace('IF created_count+unchanged_count<>49',injection+'IF created_count+unchanged_count<>49');
  await rejectedUnchanged(db,sql,/JULY_BATCH_FUND_DELTA_MISMATCH/);
 }finally{await db.close();}
});

test('49 safeguards: no operational-source scan/extra write locks; closures and card allocation stay protected',{skip:!enabled},async()=>{
 const db=await fixture(inputs().snapshot);try{
  await db.exec('drop table pos_sales_receipt_payments,pos_sales_receipt_lines,pos_sales_receipts,inventory_logs,inventory');
  const raw=controlFile();
  const lockCheck=`IF EXISTS(SELECT 1 FROM pg_locks l JOIN pg_class c ON c.oid=l.relation WHERE c.relname IN('ledger_payables','ledger_payable_allocations','ledger_card_reconciliations','ledger_card_reconciliation_lines','ledger_candidates') AND l.mode='ShareRowExclusiveLock') THEN RAISE EXCEPTION 'UNNEEDED_WRITE_LOCK'; END IF; `;
  await db.exec(approved(raw.replace('before_state:=pg_temp.july_protected();',lockCheck+'before_state:=pg_temp.july_protected();')));
  const before=await snapshotDb(db);await db.exec(approved(raw));assert.deepEqual(await snapshotDb(db),before);
  await rejectedUnchanged(db,raw.replace('IF pg_temp.july_protected()',"UPDATE ledger_month_closures SET summary_snapshot='{}' WHERE month='2026-08-01'; IF pg_temp.july_protected()"),/JULY_PROTECTED_STATE_CHANGED/);
  await rejectedUnchanged(db,raw.replace('IF pg_temp.july_protected()',"UPDATE ledger_card_reconciliation_lines SET allocated_gross_amount=allocated_gross_amount+1; IF pg_temp.july_protected()"),/JULY_PROTECTED_STATE_CHANGED/);
 }finally{await db.close();}
});
