// Isolated DB fixture. Applied phases1-4 are loaded as DATA, never executed.
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {julyCashManifest,migrationSource} from '../../scripts/ledger/cash-import-batch.mjs';
export const protectedTables=['ledger_transactions','ledger_movements','ledger_audit_logs','ledger_fund_accounts','ledger_candidates','ledger_payables','ledger_payable_allocations','ledger_card_reconciliations','ledger_card_reconciliation_lines','ledger_card_fee_closures','ledger_card_fee_allocation_lines','ledger_month_closures','ledger_month_closure_history','ledger_rent_contracts','ledger_rent_contract_payments','ledger_owner_investments','payroll_monthly_adjustments','payroll_payment_batches','inventory','inventory_logs','pos_sales_receipt_payments'];
export async function dump(db,tables=protectedTables){const x={};for(const t of tables)x[t]=(await db.query(`select * from ${t} order by id`)).rows;return x;}
export async function fixture(root,{crlf=false}={}){
 const {PGlite}=createRequire(process.env.JULY_QA_PACKAGE_JSON||import.meta.url)('@electric-sql/pglite'),db=new PGlite();
 const read=p=>readFileSync(p,'utf8'),load=p=>JSON.parse(read(join(root,p))),capture=load('phase4-runtime-20261107-r2/runtime-readonly.json').tables,bundle=julyCashManifest(root),p4=load('phase4-final-20261107-r2/bundle.json');
 await db.exec(read('tests/ledger-july-opening-oneoff-db.test.mjs').match(/const FIXTURE = `([\s\S]*?)`;/)[1]);
 await db.exec(`alter table ledger_categories add column kind text default 'expense',add column is_active boolean default true;
 create table ledger_candidates(id bigint primary key,status text);insert into ledger_candidates values(1,'confirmed');
 create table ledger_payables(id bigint primary key,expense_transaction_id bigint,status text);insert into ledger_payables values(1830,3804,'paid');
 create table ledger_payable_allocations(id bigint primary key,payable_id bigint,payment_transaction_id bigint,allocated_amount numeric);insert into ledger_payable_allocations values(1,1830,1796,15426000);
 create table ledger_card_reconciliations(id bigint primary key,status text);insert into ledger_card_reconciliations select id,'matched' from generate_series(1,69) id;
 create table ledger_card_reconciliation_lines(id bigint primary key,transaction_id bigint);insert into ledger_card_reconciliation_lines values(1,1190);
 create table ledger_card_fee_closures(id bigint primary key);create table ledger_card_fee_allocation_lines(id bigint primary key);
 create table ledger_month_closure_history(id bigint primary key,month date,snapshot_hash text);
 create table ledger_rent_contracts(id bigint primary key,proof jsonb);create table ledger_rent_contract_payments(id bigint primary key,proof jsonb);
 create table ledger_owner_investments(id bigint primary key,proof jsonb);
 create table payroll_monthly_adjustments(id bigint primary key,proof jsonb);insert into payroll_monthly_adjustments values(1,'{"kind":"advance","amount":1000000}'),(2,'{"kind":"advance","amount":2000000}');
 create table payroll_payment_batches(id bigint primary key,status text);
 create table inventory(id bigint primary key,quantity numeric);insert into inventory values(1,100);
 create table inventory_logs(id bigint primary key,item_id bigint,change_quantity numeric);insert into inventory_logs values(5563,1,20);
 create table pos_sales_receipts(id bigint primary key);insert into pos_sales_receipts values(6772);
 create table pos_sales_receipt_payments(id bigint primary key,receipt_id bigint);insert into pos_sales_receipt_payments select id,6772 from unnest(array[6904,6906,6907,6908,6909,6918]) id;`);
 for(const c of capture.categories)await db.query('insert into ledger_categories values($1,$2,$3,$4) on conflict(id) do update set name=excluded.name,kind=excluded.kind,is_active=excluded.is_active',[c.id,c.name,c.kind,c.is_active]);
 for(const id of new Set(capture.julyTransactions.map(x=>x.party_id).filter(x=>x!==null)))await db.query("insert into ledger_parties values($1,'existing party fixture') on conflict(id) do nothing",[id]);
 async function insert(table,rows){const cols=(await db.query("select column_name,data_type from information_schema.columns where table_schema='public' and table_name=$1",[table])).rows;for(const r of rows){const f=cols.filter(c=>Object.hasOwn(r,c.column_name));await db.query(`insert into ${table}(${f.map(c=>c.column_name).join(',')}) values(${f.map((_,i)=>'$'+(i+1)).join(',')})`,f.map(c=>c.data_type==='jsonb'&&r[c.column_name]!==null?JSON.stringify(r[c.column_name]):r[c.column_name]));}}
 await db.exec("delete from ledger_movements where transaction_id in(select id from ledger_transactions where business_date<'2026-08-01');delete from ledger_transactions where business_date<'2026-08-01';");
 await insert('ledger_transactions',capture.julyTransactions.map(r=>({...r,created_by:2,confirmed_by:2})));
 await insert('ledger_movements',capture.movements);
 await insert('ledger_audit_logs',capture.julyAudits.map(r=>({...r,actor_user_id:2,entity_type:'transaction'})));
 await db.exec('alter table ledger_movements alter column id restart with 20000;alter table ledger_audit_logs alter column id restart with 20000;');
 const account=new Map(capture.accounts.map(a=>[a.code,a.id]));
 // The owner supplied phase4 completion, not its live ID range. IDs7000+ are
 // deliberately synthetic fixture IDs, resolved by the REAL audit/key contract.
 for(const [i,a] of p4.bundle.actions.entries()){
  const id=7000+i,type=a.kind==='rent_preledger_conversion'?'prepaid_expense_payment':a.kind==='payroll_advance'?'payroll_payment':a.kind;
  await insert('ledger_transactions',[{id,operation_id:randomUUID(),type,status:'confirmed',business_date:a.date,occurred_at:a.date+'T12:00:00+07:00',recognition_month:a.kind==='expense'?'2026-07-01':null,amount:a.amount,category_id:a.categoryId,source_type:a.kind==='rent_preledger_conversion'?'legacy_sheet_detail':'manual',source_key:a.sourceKey,source_snapshot:{fixtureAppliedPhase4:true},source_fingerprint:a.kind==='rent_preledger_conversion'?a.actionHash:null,source_synced_at:a.kind==='rent_preledger_conversion'?'2026-11-07T00:00:00Z':null,created_by:2,confirmed_by:2}]);
  for(const e of a.effects)await db.query('insert into ledger_movements(transaction_id,fund_account_id,amount) values($1,$2,$3)',[id,account.get(e.account),e.amount]);
  await db.query("insert into ledger_audit_logs(actor_user_id,action,entity_type,entity_id,after_snapshot,reason) values(2,'july_restore_row','transaction',$1,$2,$3)",[id,JSON.stringify({actionHash:a.actionHash,bundleDigest:p4.bundleDigest,transactionIds:[id]}),a.key]);
 }
 for(const [table,rows] of [['ledger_rent_contracts',capture.rentContracts],['ledger_rent_contract_payments',capture.rentPayments],['ledger_owner_investments',capture.ownerInvestments]])for(const r of rows)await db.query(`insert into ${table} values($1,$2)`,[r.id,JSON.stringify(r)]);
 for(const r of bundle.manifest.rows)for(const claim of r.sourceClaims)await db.query('insert into inventory_logs values($1,1,1) on conflict(id) do nothing',[Number(claim.id)]);
 await db.exec('alter table ledger_transactions alter column id restart with 9000;');
 await db.exec(crlf?migrationSource().replaceAll('\n','\r\n'):migrationSource());
 return {db,bundle};
}
