// Synthetic sources only. Does not read credentials or connect to a remote DB.
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {planJulyRestore,JULY_SHEET,JULY_TAB,CLASS_COUNTS,OPENING,CLOSING,FUNDS,rowKey} from '../lib/ledger/july-restore-plan.ts';
import {renderJulyBatch} from '../scripts/ledger/july-restore-dry-run.mjs';
const require=createRequire(process.env.JULY_QA_PACKAGE_JSON||import.meta.url);
const {PGlite}=require('@electric-sql/pglite');

function bundle() {
  const rows=[];let n=10;
  for(const [classification,count]of Object.entries(CLASS_COUNTS))for(let i=0;i<count;i++)rows.push({sheetId:JULY_SHEET,tabId:JULY_TAB,row:n++,date:'2026-07-31',classification,amount:'0',effects:[],mappingReference:'SYNTHETIC ONLY',sourceRefs:[]});
  for(const [kind,total]of [['meal','10050000'],['pos_card','223562820'],['card_deposit','225970967']])rows.find(r=>r.classification===kind).amount=total;
  const expense=rows.find(r=>r.classification==='manual_candidate');expense.amount='100';expense.effects=[{account:'store_cash',amount:'-100'}];
  const balance=rows.find(r=>r.classification==='other');
  balance.effects=FUNDS.map(account=>({account,amount:String(BigInt(CLOSING[account])-BigInt(OPENING[account])+(account==='store_cash'?100n:0n))}));
  const actions=rows.map(r=>({key:`synthetic-row-${r.row}`,rowNumbers:[r.row],kind:r===expense?'expense':'hold',costBasis:r===expense?'verified_non_inventory':undefined,
    date:r.date,amount:r.amount==='0'?'1':r.amount,effects:r.effects,evidence:'SYNTHETIC ONLY',economicKey:`synthetic-economic-${r.row}`,categoryId:r===expense?8:undefined}));
  return {version:1,sheetId:JULY_SHEET,tabId:JULY_TAB,mappingReference:'SYNTHETIC ONLY',capturedAt:'2026-11-07T00:00:00Z',rows,actions,
    openings:[['store_cash',4207],['vuong_personal_custody',4208],['cho_personal_custody',4209],['baba_corporate_bank',4210]].map(([account,id])=>({account,id,amount:OPENING[account]})),
    dailyTargets:Array.from({length:31},(_,i)=>({date:`2026-07-${String(i+1).padStart(2,'0')}`,closing:i===30?CLOSING:OPENING}))};
}
const expenseAction=b=>b.actions.find(a=>a.kind==='expense');
test('395 synthetic rows, category controls and all 124 daily balances; missing real targets fail closed',()=>{
 const b=bundle(),p=planJulyRestore(b);assert.equal(p.status,'REVIEWABLE');assert.equal(p.daily.filter(d=>d.matches).length,124);assert.equal(p.counts.ready,1);assert.equal(p.counts.held,394);assert.equal(p.fullRestoreReady,false);
 b.dailyTargets.pop();assert.ok(planJulyRestore(b).blockers.includes('EXPECTED_31_DAILY_TARGETS'));
 b.rows.pop();assert.ok(planJulyRestore(b).blockers.includes('EXPECTED_395_ROWS'));
});
test('stable row identity, reused rows and changed costs cannot become automatic expenses',()=>{
 const b=bundle(),a=expenseAction(b);assert.ok(rowKey(b.rows[0]).endsWith(':row:10'));
 a.rowNumbers.push(a.rowNumbers[0]);assert.equal(planJulyRestore(b).decisions.find(d=>d.key===a.key).status,'risk');
 a.rowNumbers.pop();b.rows.find(r=>r.row===a.rowNumbers[0]).sourceRefs=['inventory_log:710'];
 assert.ok(planJulyRestore(b).decisions.find(d=>d.key===a.key).reasons.includes('EXISTING_COST_SOURCE_MUST_NOT_BE_EXPENSE'));
});
test('POS group cannot manufacture duplicate revenue or recreate #1190; deposit stays zero profit',()=>{
 const b=bundle();const row=b.rows.find(r=>r.classification==='pos_card');row.effects=[{account:'card_clearing',amount:row.amount}];row.sourceRefs=['synthetic-pos'];
 const a=b.actions.find(a=>a.rowNumbers[0]===row.row);Object.assign(a,{kind:'pos',bucket:'card',categoryId:7,effects:row.effects});
 assert.ok(planJulyRestore(b).decisions.find(d=>d.key===a.key).reasons.includes('LINK_EXISTING_1190'));
 a.date=row.date='2026-07-12';assert.ok(planJulyRestore(b).decisions.find(d=>d.key===a.key).reasons.includes('KNOWN_POS_DIFFERENCE_REQUIRES_REVIEW'));
 const deposit=b.actions.find(a=>b.rows.find(r=>r.row===a.rowNumbers[0]).classification==='card_deposit');deposit.kind='expense';deposit.costBasis='verified_non_inventory';
 assert.equal(planJulyRestore(b).decisions.find(d=>d.key===deposit.key).status,'risk');
 const e=expenseAction(b);b.actions.find(a=>a!==e).economicKey=e.economicKey;
 assert.ok(planJulyRestore(b).decisions.some(d=>d.reasons.includes('DUPLICATE_OR_MISSING_ECONOMIC_KEY')));
});
test('payable payment needs explicit allocations, exact amount and a known source',()=>{
 const b=bundle(),a=expenseAction(b);a.kind='payable_payment';a.partyId=9;a.allocations=[{payableId:5,allocatedAmount:'100'}];b.rows.find(r=>r.row===a.rowNumbers[0]).sourceRefs=['existing-cost:123'];
 assert.equal(planJulyRestore(b).decisions.find(d=>d.key===a.key).status,'ready');
 a.allocations[0].allocatedAmount='99';assert.equal(planJulyRestore(b).decisions.find(d=>d.key===a.key).status,'risk');
});

async function dbFixture() {
 const db=new PGlite();
 const original=readFileSync('tests/ledger-july-opening-oneoff-db.test.mjs','utf8');
 await db.exec(original.match(/const FIXTURE = `([\s\S]*?)`;/)[1]);
 // Reuse prior PASS fixture and actual seed/RPC bodies; no production data fetch.
 await db.exec('alter table ledger_transactions alter column id restart with 4207');
 await db.exec(readFileSync('scripts/ledger/july-opening-4funds-20261106-ONE-OFF.sql','utf8').replaceAll('__ACTOR_USER_ID__','2').replaceAll('__OWNER_APPROVAL__','APPROVED:july-opening-4funds-20261106'));
 await db.exec(`alter table ledger_categories add column kind text;alter table ledger_categories add column is_active boolean default true;
 alter table ledger_parties add column is_active boolean default true;
 create schema supabase_migrations;create table supabase_migrations.schema_migrations(version text primary key);insert into supabase_migrations.schema_migrations values('20261105153442');
 update ledger_categories set kind=case when id=7 then 'income' else 'expense' end;
 update ledger_categories set name='POS 매출' where id=7;
 create table ledger_payables(id bigint primary key,expense_transaction_id bigint,party_id bigint,status text);
 create table ledger_payable_allocations(id bigint primary key,payable_id bigint,payment_transaction_id bigint,allocated_amount numeric);
 create table ledger_card_reconciliations(id bigint generated by default as identity primary key,deposit_transaction_id bigint,deposit_date date,destination_fund_account_id bigint,deposit_amount numeric,memo text);
 create table ledger_card_reconciliation_lines(id bigint primary key,reconciliation_id bigint,pos_card_transaction_id bigint,allocated_gross_amount numeric);
 create table ledger_month_closure_history(id bigint primary key,month date,snapshot_hash text);
 create table inventory_logs(id bigint primary key,quantity numeric);create table inventory(id bigint primary key,quantity numeric);
 create table pos_sales_receipts(id bigint primary key);create table pos_sales_receipt_lines(id bigint primary key);create table pos_sales_receipt_payments(id bigint primary key);
 insert into inventory values(1,100);insert into inventory_logs values(710,10);
 insert into ledger_card_reconciliations(deposit_transaction_id,deposit_date,deposit_amount) values(200,'2026-08-02',500000);
 insert into ledger_card_reconciliation_lines values(1,1,1190,10000);`);
 const sql=readFileSync('supabase/migrations/20261031070537_meal_adjustment_original_business_date.sql','utf8');
 await db.exec(sql.match(/create or replace function public\.ledger_create_manual_transaction_v1\([\s\S]*?end \$\$;/i)[0]);
 const inventory=readFileSync('supabase/migrations/202608210003_add_inventory_purchase_candidates.sql','utf8');
 await db.exec(inventory.match(/create table public\.ledger_candidates\([\s\S]*?\n\);/i)[0]);
 await db.exec(inventory.match(/create or replace function public\.ledger_resolve_inventory_candidate_v1\([\s\S]*?end \$\$;/i)[0]);
 return db;
}
function script(b,patch=s=>s) {return patch(renderJulyBatch(b,planJulyRestore(b))).replaceAll('__ACTOR_USER_ID__','2').replaceAll('__OWNER_APPROVAL__','APPROVED:july-restore:'+planJulyRestore(b).digest);}
async function snapshot(db){return JSON.stringify((await db.query(`select jsonb_build_object('tx',(select jsonb_agg(to_jsonb(t) order by id) from ledger_transactions t),'mov',(select jsonb_agg(to_jsonb(m) order by id) from ledger_movements m),'audit',(select jsonb_agg(to_jsonb(a) order by id) from ledger_audit_logs a),'stock',(select jsonb_agg(to_jsonb(i)) from inventory i),'links',(select jsonb_agg(to_jsonb(l)) from ledger_card_reconciliation_lines l)) x`)).rows[0].x);}
async function fail(db,sql,pattern){await assert.rejects(db.exec(sql),pattern);await db.exec('ROLLBACK');}

test('SQL: manual batch replays without duplicates; changed row payload fails and rolls back',async()=>{
 const db=await dbFixture();try{
 const b=bundle();await db.exec(script(b));const after=await snapshot(db);await db.exec(script(b));assert.equal(await snapshot(db),after);
 expenseAction(b).evidence='changed';await fail(db,script(b),/JULY_REPLAY_CONFLICT/);assert.equal(await snapshot(db),after);
 }finally{await db.close();}
});
test('SQL: mid-batch error and injected protected-stock modification atomically roll back',async()=>{
 const db=await dbFixture();try{
 const b=bundle(),before=await snapshot(db);
 await fail(db,script(b,s=>s.replace('IF pg_temp.july_protected()',"RAISE EXCEPTION 'INJECTED_AFTER_WRITE'; IF pg_temp.july_protected()")),/INJECTED_AFTER_WRITE/);assert.equal(await snapshot(db),before);
 await fail(db,script(b,s=>s.replace('IF pg_temp.july_protected()',"UPDATE public.inventory SET quantity=0; IF pg_temp.july_protected()")),/JULY_PROTECTED_STATE_CHANGED/);assert.equal(await snapshot(db),before);
 await fail(db,script(b,s=>s.replaceAll('__OWNER_APPROVAL__', 'WRONG:')),/JULY_SEPARATE_APPROVAL_REQUIRED/);assert.equal(await snapshot(db),before);
 }finally{await db.close();}
});
test('SQL: new POS and unmatched deposits do not change existing card links, P&L or later funds',async()=>{
 const db=await dbFixture();try{
 const b=bundle();const row=b.rows.find(r=>r.classification==='pos_daily_split');const a=b.actions.find(a=>a.rowNumbers[0]===row.row);
 Object.assign(row,{date:'2026-07-01',amount:'225970967',effects:[{account:'card_clearing',amount:'225970967'}],sourceRefs:['synthetic-pos:1']});
 Object.assign(a,{date:row.date,kind:'pos',bucket:'card',amount:row.amount,effects:row.effects,categoryId:7});
 const deposit=b.rows.find(r=>r.classification==='card_deposit'),da=b.actions.find(a=>a.rowNumbers[0]===deposit.row);
 Object.assign(deposit,{effects:[{account:'card_clearing',amount:'-'+deposit.amount},{account:'baba_corporate_bank',amount:deposit.amount}]});Object.assign(da,{kind:'card_deposit',effects:deposit.effects});
 // Adjust only synthetic closing targets/other row effects to keep authoritative controls.
 const bal=b.rows.find(r=>r.classification==='other');bal.effects.find(e=>e.account==='baba_corporate_bank').amount=String(BigInt(bal.effects.find(e=>e.account==='baba_corporate_bank').amount)-BigInt(deposit.amount));
 assert.equal(planJulyRestore(b).status,'REVIEWABLE');await db.exec(script(b));
 assert.equal((await db.query("select count(*)::int n from ledger_transactions where type='sales' and business_date<'2026-08-01'")).rows[0].n,2);
 assert.equal((await db.query("select count(*)::int n from ledger_transactions where type='card_settlement_deposit' and recognition_month is null and category_id is null")).rows[0].n,1);
 assert.equal((await db.query('select count(*)::int n from ledger_card_reconciliation_lines')).rows[0].n,1);
 const state=await snapshot(db);await db.exec(script(b));assert.equal(await snapshot(db),state);
 }finally{await db.close();}
});
test('SQL: mapped inventory candidate creates one expense and payment; cost mismatch stays under review',async()=>{
 const db=await dbFixture();try{
 await db.exec(`insert into ledger_candidates(id,candidate_type,source_type,source_key,business_date,proposed_amount,proposed_recognition_month,source_snapshot,source_fingerprint)
 values(71,'inventory_purchase','inventory_purchase_log','inventory-log:710','2026-07-31',200,'2026-07-01','{"inventory_log_id":710}',repeat('a',64));`);
 const b=bundle(),r=b.rows.find(r=>r.classification==='inventory_original'),a=b.actions.find(a=>a.rowNumbers[0]===r.row);
 Object.assign(r,{amount:'200',effects:[{account:'store_cash',amount:'-200'}],sourceRefs:['inventory-log:710']});
 Object.assign(a,{kind:'inventory',amount:'200',effects:r.effects,categoryId:8,candidateId:71,candidateSnapshot:(await db.query('select to_jsonb(c) c from ledger_candidates c where id=71')).rows[0].c});
 const balance=b.rows.find(r=>r.classification==='other');balance.effects.find(e=>e.account==='store_cash').amount=String(BigInt(balance.effects.find(e=>e.account==='store_cash').amount)+200n);
 assert.equal(planJulyRestore(b).decisions.find(d=>d.key===a.key).status,'ready');
 await db.exec(script(b));const state=await snapshot(db);await db.exec(script(b));assert.equal(await snapshot(db),state);
 assert.equal((await db.query("select count(*)::int n from ledger_transactions where source_type='inventory_purchase_candidate'")).rows[0].n,1);
 assert.equal((await db.query('select quantity from inventory')).rows[0].quantity,'100');
 a.amount='201';assert.equal(planJulyRestore(b).decisions.find(d=>d.key===a.key).status,'risk');
 }finally{await db.close();}
});
test('SQL: historical card clearing drift is blocked without changing the previous card chain',async()=>{
 const db=await dbFixture();try{
 const b=bundle(),r=b.rows.find(r=>r.classification==='pos_daily_split'),a=b.actions.find(a=>a.rowNumbers[0]===r.row);
 Object.assign(r,{date:'2026-07-01',amount:'500',effects:[{account:'card_clearing',amount:'500'}],sourceRefs:['synthetic-pos']});
 Object.assign(a,{date:r.date,kind:'pos',bucket:'card',amount:r.amount,effects:r.effects,categoryId:7});
 const before=await snapshot(db);await fail(db,script(b),/JULY_CURRENT_CARD_CLEARING_CHANGED/);assert.equal(await snapshot(db),before);
 }finally{await db.close();}
});
test('SQL: full-restore claim requires all 124 APP closing targets, not just source equality',async()=>{
 const db=await dbFixture();try{
 const b=bundle(),before=await snapshot(db);
 await fail(db,script(b,s=>s.replace('"fullRestoreReady":false','"fullRestoreReady":true')),/JULY_DAILY_CLOSING_MISMATCH/);assert.equal(await snapshot(db),before);
 await db.exec("delete from supabase_migrations.schema_migrations where version='20261105153442'");
 await fail(db,script(b),/JULY_BOUNDARY_MIGRATION_REQUIRED/);assert.equal(await snapshot(db),before);
 }finally{await db.close();}
});
