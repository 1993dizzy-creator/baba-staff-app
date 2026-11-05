// Focused local PostgreSQL fixture. No Production connection or credentials.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const read=name=>readFileSync('supabase/migrations/'+name,'utf8').replaceAll('\r\n','\n');
const migration=read('20261105153442_protect_august_opening_fund_boundary.sql');
const definitions=[
 ['20260916161512_add_ledger_month_reopen.sql','ledger_owner_financial_capacity_v1'],
 ['20260916150709_separate_owner_capital_recovery.sql','ledger_owner_recovery_capacity_v1'],
 ['20260916150709_separate_owner_capital_recovery.sql','ledger_pay_owner_allocation_v1'],
 ['202608210009_add_owner_settlements.sql','ledger_owner_payment_fund_guard_v1'],
 ['202608270001_link_reserve_plans_to_fund_accounts.sql','ledger_create_reserve_entry_v1'],
 ['20261028140100_reserve_allocation_kinds_v2.sql','ledger_reserve_insert_entry_v2'],
 ['20260927122430_add_owner_investment_cash_event.sql','ledger_create_owner_investment_cash_event_v1'],
];
function definition(file,name){const sql=read(file),match=sql.match(new RegExp(`create (?:or replace )?function public\\.${name}\\([\\s\\S]*?\\$\\$;`,'i'));assert.ok(match,name);return match[0];}
const one=async(db,sql,args=[]) => (await db.query(sql,args)).rows[0];
const call=async(db,name,args=[]) => (await one(db,`select ${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) result`,args)).result;

test('existing seven DB sums isolate July, preserve cash/rows/snapshot hashes, ACLs and payment limits',async()=>{
 const db=new PGlite();
 try {
  await db.exec(`create role service_role;
   create table users(id bigint primary key,role text,is_active boolean,app_login_enabled boolean);
   insert into users values(1,'owner',true,true);
   create table ledger_fund_accounts(id bigint primary key,code text,type text,is_active boolean,is_business_fund boolean,active_from date);
   insert into ledger_fund_accounts values(1,'store_cash','cash',true,true,'2026-08-01'),(2,'baba_corporate_bank','bank',true,true,'2026-08-01'),
    (3,'cho_personal_custody','personal_custody',true,true,'2026-08-01'),(5,'vuong_personal_custody','personal_custody',true,true,'2026-08-01'),(4,'card_clearing','card_clearing',true,false,'2026-08-01');
   create table ledger_transactions(id bigserial primary key,operation_id uuid,type text,business_date date,occurred_at timestamptz,amount numeric,status text,party_id bigint,source_type text,source_snapshot jsonb,memo text,created_by bigint,confirmed_by bigint);
   create table ledger_movements(id bigserial primary key,transaction_id bigint,fund_account_id bigint,amount numeric);
   create table ledger_payables(id bigint primary key,original_amount numeric,status text);
   create table ledger_payable_allocations(id bigint primary key,payable_id bigint,allocated_amount numeric);
   create table ledger_month_closures(month date,status text,revision int,snapshot_hash text,summary_snapshot jsonb);
   insert into ledger_month_closures values
    ('2026-08-01','closed',5,'298a9a2f878b2db001ab6b7e503b26f11577adfaca068e8ed3e4e4ace47d874b','{"funds":{"liquidFunds":327538240}}'),
    ('2026-09-01','closed',5,'04cba0449139a034a4a0c93d646eae1be0fa32cb824d60eca011178ce6e04a0e','{"funds":{"liquidFunds":338845642}}'),
    ('2026-10-01','closed',1,'936d932e251fde1ca2ecebd10611ba3b541821bfcd4fd836fe91661a49b3fed3','{"funds":{"liquidFunds":314195186}}');
   create table ledger_owner_profit_settings(singleton boolean,profit_tracking_start_month date,opening_undistributed_profit numeric);
   insert into ledger_owner_profit_settings values(true,'2026-08-01',2000000000);
   create table ledger_owner_participants(id bigint,user_id bigint,effective_from date,effective_to date,is_eligible boolean);
   insert into ledger_owner_participants values(1,1,'2026-01-01',null,true);
   create table ledger_owner_investments(id bigint,participant_id bigint,signed_amount numeric,occurred_at timestamptz);
   insert into ledger_owner_investments values(1,1,2000000000,'2026-08-01');
   create table ledger_owner_settlements(id bigint,status text,settlement_type text,through_month date,confirmed_pool numeric);
   insert into ledger_owner_settlements values(1,'confirmed','capital_recovery','2026-11-01',200000000);
   create table ledger_owner_settlement_allocations(id bigint,settlement_id bigint,participant_id bigint,assigned_amount numeric,paid_amount numeric,recovery_amount numeric,recovery_paid_amount numeric,pure_profit_paid_amount numeric);
   insert into ledger_owner_settlement_allocations values(1,1,1,200000000,0,200000000,0,0);
   alter table ledger_owner_settlement_allocations add column updated_at timestamptz;
   alter table ledger_owner_settlements add column updated_at timestamptz;
   create table ledger_reserve_plans(id bigint primary key,fund_account_id bigint,is_active boolean);
   insert into ledger_reserve_plans values(1,1,true);
   create table ledger_reserve_entries(id bigserial,reserve_plan_id bigint,entry_type text,amount numeric,occurred_at timestamptz,memo text,created_by bigint,allocation_kind text,restores_entry_id bigint,attribution_month date,request_key uuid);
   create table ledger_audit_logs(id bigserial,actor_user_id bigint,action text,entity_type text,entity_id bigint,before_snapshot jsonb,after_snapshot jsonb,reason text);
   create table ledger_card_reconciliations(id bigint,deposit_date date);
   create table ledger_card_reconciliation_lines(id bigint,reconciliation_id bigint,pos_card_transaction_id bigint,allocated_gross_amount numeric);
   insert into ledger_card_reconciliations values(1,'2026-08-03');
   insert into ledger_card_reconciliation_lines values(1,1,1190,3694200);
   create function ledger_owner_role_v1(bigint) returns boolean language sql as $$select exists(select 1 from public.users where id=$1 and role='owner')$$;
   create function ledger_month_is_closed_v1(date) returns boolean language sql as $$select exists(select 1 from public.ledger_month_closures where month=$1 and status='closed')$$;
   create function ledger_assert_month_open_v1(date) returns void language plpgsql as $$begin if ledger_month_is_closed_v1($1) then raise exception 'LEDGER_MONTH_CLOSED';end if;end$$;
  `);
  for(const [index,[file,name]] of definitions.entries()) {
   const sql=definition(file,name);
   await db.exec(index%2 ? sql.replaceAll('\n','\r\n') : sql);
  }
  await db.exec('create trigger owner_fund_guard before insert on ledger_movements for each row execute function ledger_owner_payment_fund_guard_v1();');
  await db.exec('grant execute on function ledger_owner_financial_capacity_v1(date) to service_role;');
  const cash=[95_479_906,191_189_037,59_922_781,1_245_710];
  const opening=[95_464_986,104_186_605,95_470_741,5_231_310];
  const movement=async(id,date,amount,account,type='income')=>{
   await db.query("insert into ledger_transactions(id,type,business_date,occurred_at,amount,status,source_type) values($1,$2,$3,$3::date+time'12:00',abs($4),'confirmed','manual')",[id,type,date,amount]);
   await db.query('insert into ledger_movements(transaction_id,fund_account_id,amount) values($1,$2,$3)',[id,account,amount]);
  };
  for(let i=0;i<4;i++) {
   await movement(i+1,'2026-08-01',opening[i],[1,2,3,5][i],'opening');
   // Synthetic intervening activity reaches the supplied same-set November baseline.
   await movement(i+10,'2026-11-01',cash[i]-opening[i],[1,2,3,5][i]);
  }
  await movement(1190,'2026-07-31',3_694_200,4,'sales');
  await movement(1200,'2026-08-03',-3_694_200,4,'card_settlement_deposit');
  await movement(1210,'2026-11-01',10_393_978,4,'sales');
  await db.exec('select setval(\'ledger_transactions_id_seq\',5000)');
  const protectedTables=['ledger_transactions','ledger_movements','ledger_month_closures','ledger_payables','ledger_payable_allocations','ledger_card_reconciliations','ledger_card_reconciliation_lines','ledger_fund_accounts'];
  const fingerprints=async(existingOnly=false)=>Object.fromEntries(await Promise.all(protectedTables.map(async table=>[table,(await one(db,`select md5(string_agg(to_jsonb(r)::text,'|' order by to_jsonb(r)->>'id',to_jsonb(r)->>'month')) hash from ${table} r ${existingOnly && table==='ledger_transactions'?'where id<9000':existingOnly && table==='ledger_movements'?'where transaction_id<9000':''}`)).hash])));
  const capacity=async()=>[await call(db,'ledger_owner_financial_capacity_v1',['2026-11-01']),await call(db,'ledger_owner_recovery_capacity_v1')];
  const before=await fingerprints(),expected=await capacity();
  const attributes=await db.query("select oid,proowner,proacl,prosecdef,proconfig from pg_proc where proname in(select unnest($1::text[])) order by oid",[definitions.map(([,name])=>name)]);
  const bodies=async()=>(await db.query("select oid,prosrc from pg_proc where proname=any($1::text[]) order by oid",[definitions.map(([,name])=>name)])).rows;
  const originalBodies=await bodies();
  // Simulate a server whose function-definition rendering changes after CREATE.
  // The extra newline is outside the body; prosrc remains the correct comparison.
  await db.exec(`create function public.boundary_test_functiondef(oid) returns text language sql as $$
   select pg_catalog.pg_get_functiondef($1) || case when position('2026-08-01' in
    (select prosrc from pg_proc where oid=$1))>0 then E'\n' else '' end $$;`);
  await db.exec(migration.replaceAll('pg_get_functiondef(v_oid)','public.boundary_test_functiondef(v_oid)').replace('COMMIT;','ROLLBACK;'));
  assert.deepEqual(await bodies(),originalBodies,'header rendering differences and mixed CRLF/LF do not reject correct bodies');
  // A genuine body mismatch must still roll back every function replacement.
  await assert.rejects(db.exec(migration.replace('EXECUTE v_patched;',"EXECUTE replace(v_patched,'begin',E'begin\\n-- injected body drift');")),/Boundary post-definition mismatch/);
  await db.exec('ROLLBACK');
  assert.deepEqual(await bodies(),originalBodies,'body verification failure is atomic');
  assert.deepEqual(await fingerprints(),before);
  await db.exec(migration);
  assert.deepEqual(await fingerprints(),before,'migration has zero row DML, including three exact close hashes/revisions');
  assert.deepEqual(await capacity(),expected,'unchanged current movement set: zero cash/capacity impact');
  assert.deepEqual(await db.query("select oid,proowner,proacl,prosecdef,proconfig from pg_proc where proname in(select unnest($1::text[])) order by oid",[definitions.map(([,name])=>name)]),attributes);
  for(const id of [1,2,3,5])await movement(9000+id,'2026-07-15',20_000_000,id);
  assert.deepEqual(await capacity(),expected,'restored July movements cannot inflate current cash or capacity');
  assert.equal(expected[0].liquidFunds,347_837_434);
  const over=cash[0]+1;
  assert.equal((await call(db,'ledger_pay_owner_allocation_v1',[1,over,1,'2026-11-01T12:00:00+07:00','local',1])).status,'insufficient_fund');
  assert.equal((await call(db,'ledger_pay_owner_allocation_v1',[1,20_000_001,1,'2026-07-20T12:00:00+07:00','local',1])).status,'insufficient_fund','July cannot spend the August opening');
  assert.equal((await call(db,'ledger_create_reserve_entry_v1',[1,'allocate',over,'2026-11-01T12:00:00+07:00','local',1])).status,'insufficient_fund_balance');
  assert.equal((await call(db,'ledger_reserve_insert_entry_v2',[1,'allocate','extra',over,null,'local','00000000-0000-0000-0000-000000000001',1])).status,'insufficient_fund_balance');
  assert.equal((await call(db,'ledger_create_owner_investment_cash_event_v1',[1,'recovery',over,'2026-11-01T12:00:00+07:00',1,'local','local',1])).status,'insufficient_fund');
  await db.exec('begin');
  assert.equal((await call(db,'ledger_pay_owner_allocation_v1',[1,1,1,'2026-11-01T12:00:00+07:00','local',1])).status,'paid','valid payment still passes the existing fund trigger');
  await db.exec('rollback');
  await db.exec("insert into ledger_transactions(id,type,business_date,occurred_at,status) values(8000,'owner_settlement_payment','2026-11-01','2026-11-01','confirmed')");
  await assert.rejects(db.query('insert into ledger_movements(transaction_id,fund_account_id,amount) values(8000,1,$1)',[-over]),/OWNER_SETTLEMENT_INSUFFICIENT_FUND/);
  await db.exec('delete from ledger_transactions where id=8000');
  assert.deepEqual((await db.query('select * from ledger_card_reconciliation_lines')).rows,[{id:1,reconciliation_id:1,pos_card_transaction_id:1190,allocated_gross_amount:'3694200'}]);
  const originalRows=(await db.query('select * from ledger_transactions where id<9000 order by id')).rows;
  assert.equal(originalRows.length,11,'no generated opening, adjustment or ledger payment is retained');
  assert.deepEqual(await fingerprints(true),before,'all original rows, including movements, allocations, account dates and close revisions/hashes remain byte-for-byte unchanged');
 }finally{await db.close();}
});
