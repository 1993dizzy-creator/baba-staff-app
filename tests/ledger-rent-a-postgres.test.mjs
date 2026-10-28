import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { nativeInventoryPostgres } from './helpers/inventory-native-postgres.mjs';
import { fixtureSql, migrationFiles, readMigration, protectedState } from './helpers/ledger-rent-a-native-fixture.mjs';

// Real PostgreSQL (local binaries only, never production). Installs the two rent/reserve
// v2 migrations on a fixture shaped like production and checks the A-plan gates.
const one=async(c,sql,args=[])=>(await c.query(sql,args)).rows[0];
const call=async(c,sql,args=[])=>Object.values(await one(c,sql,args))[0];
const uuid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;

test('rent A-plan migrations on native PostgreSQL',{
  skip:!process.env.QA_POSTGRES_BIN && 'No local PostgreSQL configured',timeout:180000,
},async t=>{
  const runtime=await nativeInventoryPostgres({testContext:t});t.diagnostic(runtime.version);
  const db=new runtime.Database();
  t.after(()=>db.close());
  await db.exec(fixtureSql);
  const before=await protectedState(db);
  const auditBefore=(await db.query('select * from ledger_audit_logs order by id')).rows;
  for(const file of migrationFiles) await db.exec(readMigration(file));
  const month=(await one(db,"select date_trunc('month',((now() at time zone 'Asia/Ho_Chi_Minh')-interval '3 hours')::date)::date::text m")).m;

  await t.test('install keeps every existing row and leaves legacy reserve columns NULL',async()=>{
    assert.deepEqual(await protectedState(db),before);
    const touched=await one(db,'select count(*)::int n from ledger_reserve_entries where allocation_kind is not null or restores_entry_id is not null or attribution_month is not null or request_key is not null');
    assert.equal(touched.n,0);
  });

  await t.test('grants: API role only, nothing for anon/authenticated, internal helper private',async()=>{
    const rows=(await db.query(`select p.proname,has_function_privilege('anon',p.oid,'execute') anon,has_function_privilege('authenticated',p.oid,'execute') auth,
      has_function_privilege('service_role',p.oid,'execute') svc,p.prosecdef from pg_proc p where p.proname like 'ledger_%v2' or p.proname like 'ledger_%rent%' order by 1`)).rows;
    assert.equal(rows.length,9);
    for(const row of rows){
      assert.equal(row.anon,false,row.proname);assert.equal(row.auth,false,row.proname);assert.equal(row.prosecdef,true,row.proname);
      const internal=['ledger_reserve_insert_entry_v2','ledger_rent_actor_can_write_v1','ledger_rent_ledger_start_v1'].includes(row.proname);
      assert.equal(row.svc,!internal,row.proname);
    }
    const tables=(await db.query(`select relname,relrowsecurity rls,has_table_privilege('service_role',oid,'select') sel,has_table_privilege('service_role',oid,'insert') ins,
      has_table_privilege('anon',oid,'select') anon from pg_class where relname in('ledger_rent_contracts','ledger_rent_contract_payments')`)).rows;
    assert.equal(tables.length,2);
    for(const row of tables) assert.deepEqual([row.rls,row.sel,row.ins,row.anon],[true,true,false,false]);
  });

  await t.test('seed: 2 contracts, July pre-ledger evidence + #1304 link = 600M, no ledger row, idempotent guard',async()=>{
    await db.exec(readFileSync('scripts/ledger/rent-a-seed.sql','utf8'));
    const contracts=(await db.query('select id,status,terms_status,period_start::text,period_end::text,annual_amount::text,recurring_plan_id,reserve_plan_id from ledger_rent_contracts order by id')).rows;
    assert.deepEqual(contracts.map(c=>[c.status,c.terms_status,c.period_start,c.period_end,c.annual_amount]),[
      ['active','provisional','2026-07-01','2027-06-30','600000000.000'],['planned','provisional','2027-07-01','2028-06-30','720000000.000']]);
    assert.equal(Number(contracts[0].recurring_plan_id),3);assert.equal(Number(contracts[1].reserve_plan_id),1);
    const payments=(await db.query('select source,payment_transaction_id,pre_ledger_reference,paid_on::text,amount::text from ledger_rent_contract_payments order by paid_on')).rows;
    assert.deepEqual(payments.map(p=>[p.source,p.payment_transaction_id&&Number(p.payment_transaction_id),p.pre_ledger_reference,p.paid_on,p.amount]),[
      ['pre_ledger',null,'sheet:2026-07:row:33','2026-07-03','300000000.000'],['ledger',1304,null,'2026-08-11','300000000.000']]);
    await assert.rejects(db.exec(readFileSync('scripts/ledger/rent-a-seed.sql','utf8')),/RENT_SEED_ALREADY_APPLIED/);
    await db.query('rollback').catch(()=>{});
    assert.deepEqual(await protectedState(db),before);
    assert.equal((await one(db,"select count(*)::int n from ledger_transactions where recognition_month='2026-07-01' and category_id=3")).n,0);
  });

  await t.test('payment link guards: duplicate, July cash twice, over contract, non-payment rows, overlap, roles',async()=>{
    const c=(await one(db,"select id from ledger_rent_contracts where status='active'")).id;
    const link=(tx,replace=null,actor=1)=>call(db,'select ledger_link_rent_payment_v1($1,$2,$3,null,$4) r',[c,tx,replace,actor]);
    const pre=(ref,date,amount)=>call(db,"select ledger_record_pre_ledger_rent_payment_v1($1,$2,$3,$4,2,null,1) r",[c,ref,date,amount]);
    assert.equal((await link(1304)).status,'already_linked');
    assert.equal((await pre('sheet:2026-07:row:33','2026-07-03',300000000)).status,'already_recorded');
    // On/after the ledger start (opening seed 2026-08-01) a payment must be a real ledger row.
    assert.equal((await pre('sheet:2026-08:row:132','2026-08-11',1)).status,'not_pre_ledger');
    assert.equal((await pre('sheet:2026-07:row:99','2026-07-05',1)).status,'exceeds_contract_amount');
    assert.equal((await link(3305)).status,'invalid_transaction');
    assert.equal((await link(999999)).status,'transaction_not_found');
    assert.equal((await link(1304,null,2)).status,'forbidden');
    const overlap=await call(db,"select ledger_save_rent_contract_v1(null,$1,1) r",[{name:'x',periodStart:'2027-06-01',periodEnd:'2027-12-31',annualAmount:1,status:'planned'}]);
    assert.equal(overlap.status,'period_overlap');
    const invalid=await call(db,"select ledger_save_rent_contract_v1(null,$1,1) r",[{name:'x',periodStart:'2029-01-01',periodEnd:'2028-01-01',annualAmount:1,status:'planned'}]);
    assert.equal(invalid.status,'invalid_payload');
    // Editable terms: dates/due/method can change; payments must still fit.
    const next=(await one(db,"select id from ledger_rent_contracts where status='planned'")).id;
    const edit=await call(db,"select ledger_save_rent_contract_v1($1,$2,1) r",[next,{name:'매장 임대 (차기 계약)',periodStart:'2027-07-01',periodEnd:'2028-06-30',annualAmount:720000000,status:'planned',termsStatus:'provisional',paymentMethod:'installments',paymentDueDate:'2027-06-25',reservePlanId:1}]);
    assert.equal(edit.status,'saved');
    const shrink=await call(db,"select ledger_save_rent_contract_v1($1,$2,1) r",[c,{name:'현 계약',periodStart:'2026-07-01',periodEnd:'2027-06-30',annualAmount:500000000,status:'active',recurringPlanId:3}]);
    assert.equal(shrink.status,'payments_exceed_contract_amount');
  });

  await t.test('future July migration converts the pre-ledger row instead of adding a second payment',async()=>{
    await db.query('begin');
    try {
      await db.query("insert into ledger_transactions(id,type,status,amount,business_date,occurred_at,source_type,source_key) values(9100,'prepaid_expense_payment','confirmed',300000000,'2026-07-03','2026-07-03T05:00:00Z','july_migration','july:row:33')");
      await db.query('insert into ledger_movements values(9100,9100,2,-300000000)');
      const c=(await one(db,"select id from ledger_rent_contracts where status='active'")).id;
      const preId=(await one(db,"select id from ledger_rent_contract_payments where source='pre_ledger'")).id;
      assert.equal((await call(db,'select ledger_link_rent_payment_v1($1,9100,null,null,1) r',[c])).status,'exceeds_contract_amount');
      const converted=await call(db,'select ledger_link_rent_payment_v1($1,9100,$2,null,1) r',[c,preId]);
      assert.equal(converted.status,'converted');
      const sum=await one(db,'select count(*)::int n,sum(amount)::text total from ledger_rent_contract_payments where contract_id=$1',[c]);
      assert.deepEqual([sum.n,sum.total],[2,'600000000.000']);
    } finally { await db.query('rollback'); }
  });

  await t.test('reserve v2: extra on top of the 60M rule, regular confirm, idempotent retry',async()=>{
    await db.query(`insert into ledger_reserve_plans(id,name,target_amount,is_active,fund_account_id,recurring_monthly_amount,recurring_day,recurring_start_month,recurring_auto_generate)
      values(2,'QA plan',1000000000,true,1,60000000,1,$1,true)`,[month]);
    const extra=await call(db,"select ledger_create_reserve_entry_v2(2,'extra',50000000,null,'top-up',$1,1) r",[uuid(1)]);
    assert.equal(extra.status,'created');assert.equal(extra.attributionMonth,month);
    assert.equal((await call(db,"select ledger_create_reserve_entry_v2(2,'extra',50000000,null,'top-up',$1,1) r",[uuid(1)])).status,'duplicate');
    assert.equal((await call(db,"select ledger_create_reserve_entry_v2(2,'extra',40000000,null,'top-up',$1,1) r",[uuid(1)])).status,'request_key_conflict');
    const gen=await call(db,'select ledger_generate_reserve_schedule_v2($1,false,1) r',[month]);
    assert.equal(gen.createdCount,1);
    const sched=await one(db,'select id,planned_amount::text p from ledger_reserve_scheduled_allocations where reserve_plan_id=2');
    assert.equal(sched.p,'60000000.000','an extra top-up must not shrink the recurring 60M');
    const conf=await call(db,'select ledger_confirm_reserve_schedule_v2($1,1) r',[sched.id]);
    assert.equal(conf.status,'confirmed');assert.equal(Number(conf.amount),60000000);assert.equal(conf.attributionMonth,month);
    const rows=(await db.query('select allocation_kind,amount::text,attribution_month::text m from ledger_reserve_entries where reserve_plan_id=2 order by id')).rows;
    assert.deepEqual(rows.map(r=>[r.allocation_kind,Number(r.amount),r.m]),[['extra',50000000,month],['regular',60000000,month]]);
    assert.equal((await call(db,"select ledger_create_reserve_entry_v2(2,'regular',1,null,null,$1,1) r",[uuid(2)])).status,'invalid_entry');
    assert.equal((await call(db,"select ledger_create_reserve_entry_v2(2,'extra',1,null,null,$1,2) r",[uuid(3)])).status,'forbidden');
  });

  await t.test('restore: linked to its release, partial/over/duplicate/cross-plan/concurrent guards',async()=>{
    const release=await call(db,"select ledger_create_reserve_entry_v2(2,'release',100000000,null,'loan',$1,1) r",[uuid(10)]);
    assert.equal(release.status,'created');
    const rel=release.reserveEntryId;
    const restore=(amount,key,target=rel)=>call(db,"select ledger_create_reserve_entry_v2(2,'restore',$1,$2,'repaid',$3,1) r",[amount,target,uuid(key)]);
    assert.equal((await restore(40000000,11)).status,'created');
    assert.equal((await restore(40000000,11)).status,'duplicate');
    const over=await restore(70000000,12);
    assert.equal(over.status,'restore_exceeds_release');assert.equal(Number(over.remainingAmount),60000000);
    assert.equal((await restore(60000000,13)).status,'created');
    assert.equal((await restore(1,14)).status,'restore_exceeds_release');
    const allocateId=(await one(db,"select id from ledger_reserve_entries where reserve_plan_id=2 and allocation_kind='extra'")).id;
    assert.equal((await restore(1,15,allocateId)).status,'invalid_restore_target');
    assert.equal((await restore(1,16,3)).status,'invalid_restore_target','plan #1 release cannot be restored from another plan');
    assert.equal((await call(db,"select ledger_create_reserve_entry_v2(2,'restore',1,null,null,$1,1) r",[uuid(17)])).status,'invalid_entry');
    const balance=await one(db,"select sum(case entry_type when 'allocate' then amount else -amount end)::text b from ledger_reserve_entries where reserve_plan_id=2");
    assert.equal(balance.b,'110000000.000');

    // Two sessions racing to restore the same 60M release: exactly one succeeds.
    const second=await call(db,"select ledger_create_reserve_entry_v2(2,'release',60000000,null,'race',$1,1) r",[uuid(20)]);
    const a=await runtime.connect(db.name),b=await runtime.connect(db.name);
    try {
      await a.query('begin');
      const first=await call(a,"select ledger_create_reserve_entry_v2(2,'restore',60000000,$1,null,$2,1) r",[second.reserveEntryId,uuid(21)]);
      assert.equal(first.status,'created');
      const pending=call(b,"select ledger_create_reserve_entry_v2(2,'restore',60000000,$1,null,$2,1) r",[second.reserveEntryId,uuid(22)]);
      await new Promise(resolve=>setTimeout(resolve,300));
      await a.query('commit');
      assert.equal((await pending).status,'restore_exceeds_release');
    } finally { await a.query('rollback').catch(()=>{});await a.end();await b.end(); }
  });

  await t.test('no back-dating: closed months and a closed current month reject; late confirm counts in the confirmation month',async()=>{
    await assert.rejects(db.query("insert into ledger_reserve_entries(reserve_plan_id,entry_type,amount,occurred_at) values(2,'allocate',1,'2026-09-15T05:00:00Z')"),/LEDGER_MONTH_CLOSED/);
    // A September schedule (closed month) confirmed now lands in the current month.
    const late=await one(db,`insert into ledger_reserve_scheduled_allocations(reserve_plan_id,scheduled_month,scheduled_date,planned_amount,rule_snapshot)
      values(2,'2026-09-01','2026-09-01',60000000,'{"monthlyAmount":60000000}') returning id`);
    const conf=await call(db,'select ledger_confirm_reserve_schedule_v2($1,1) r',[late.id]);
    assert.equal(conf.status,'confirmed');assert.equal(conf.attributionMonth,month);assert.equal(conf.scheduledMonth,'2026-09-01');
    assert.equal((await call(db,"select ledger_generate_reserve_schedule_v2('2026-09-01',false,1) r")).status,'month_closed');
    await db.query('begin');
    try {
      await db.query("insert into ledger_month_closures(month,status,revision,snapshot_hash) values($1,'closed',1,'x')",[month]);
      assert.equal((await call(db,"select ledger_create_reserve_entry_v2(2,'extra',1,null,null,$1,1) r",[uuid(30)])).status,'current_month_closed');
    } finally { await db.query('rollback'); }
  });

  await t.test('request key race: same payload is a duplicate, another payload under the key is a conflict (unique_violation path)',async()=>{
    const count=async()=>(await one(db,'select count(*)::int n from ledger_reserve_entries')).n;
    const race=async(firstSql,firstArgs,secondSql,secondArgs)=>{
      const a=await runtime.connect(db.name),b=await runtime.connect(db.name);
      try {
        await a.query('begin');
        const first=await call(a,firstSql,firstArgs);
        assert.equal(first.status,'created');
        const pending=call(b,secondSql,secondArgs);
        await new Promise(resolve=>setTimeout(resolve,300));
        await a.query('commit');
        return {first,second:await pending};
      } finally { await a.query('rollback').catch(()=>{});await a.end();await b.end(); }
    };
    // Different plan, same key: B does not wait on A's plan lock, so it reaches the unique
    // index and gets unique_violation. Before the fix this returned 'duplicate'.
    const before=await count();
    const conflict=await race("select ledger_create_reserve_entry_v2(2,'extra',7000000,null,'race a',$1,1) r",[uuid(40)],
      "select ledger_create_reserve_entry_v2(1,'release',1000000,null,'race b',$1,1) r",[uuid(40)]);
    assert.equal(conflict.second.status,'request_key_conflict');
    assert.equal(await count(),before+1,'only the first request is booked');
    assert.equal((await one(db,'select count(*)::int n from ledger_reserve_entries where request_key=$1',[uuid(40)])).n,1);
    // Same plan, same payload: B waits on the plan lock and returns A's entry as a duplicate.
    const same=await race("select ledger_create_reserve_entry_v2(2,'extra',8000000,null,'retry',$1,1) r",[uuid(41)],
      "select ledger_create_reserve_entry_v2(2,'extra',8000000,null,'retry',$1,1) r",[uuid(41)]);
    assert.equal(same.second.status,'duplicate');
    assert.equal(Number(same.second.reserveEntryId),Number(same.first.reserveEntryId));
    assert.equal(await count(),before+2);
  });

  await t.test('a future month schedule cannot be confirmed early; nothing is written',async()=>{
    const next=(await one(db,"select (date_trunc('month',((now() at time zone 'Asia/Ho_Chi_Minh')-interval '3 hours')::date)+interval '1 month')::date::text m")).m;
    const row=await one(db,`insert into ledger_reserve_scheduled_allocations(reserve_plan_id,scheduled_month,scheduled_date,planned_amount,rule_snapshot)
      values(2,$1,$1,60000000,'{"monthlyAmount":60000000}') returning id`,[next]);
    const entries=(await one(db,'select count(*)::int n from ledger_reserve_entries')).n;
    const audits=(await one(db,'select count(*)::int n from ledger_audit_logs')).n;
    const result=await call(db,'select ledger_confirm_reserve_schedule_v2($1,1) r',[row.id]);
    assert.equal(result.status,'future_schedule');assert.equal(result.scheduledMonth,next);assert.equal(result.currentMonth,month);
    const after=await one(db,'select status,reserve_entry_id from ledger_reserve_scheduled_allocations where id=$1',[row.id]);
    assert.deepEqual([after.status,after.reserve_entry_id],['pending',null]);
    assert.equal((await one(db,'select count(*)::int n from ledger_reserve_entries')).n,entries);
    assert.equal((await one(db,'select count(*)::int n from ledger_audit_logs')).n,audits);
    // The late-confirm policy is unchanged (covered above): an earlier month books in the current month.
  });

  await t.test('nothing protected changed; audit log only grew',async()=>{
    assert.deepEqual(await protectedState(db),before);
    const audits=(await db.query('select * from ledger_audit_logs order by id')).rows;
    assert.deepEqual(audits.slice(0,auditBefore.length),auditBefore);
    assert.ok(audits.length>auditBefore.length);
  });

  await t.test('rollback script: seed undo works; v2 uninstall refuses while v2 rows exist; clean DB uninstalls fully',async()=>{
    const script=readFileSync('scripts/ledger/rent-a-rollback.sql','utf8');
    const section=n=>script.slice(script.indexOf(`-- ${n}.`),n===3?undefined:script.indexOf(`-- ${n+1}.`));
    await db.exec(section(1));
    assert.equal((await one(db,'select count(*)::int n from ledger_rent_contracts')).n,0);
    await assert.rejects(db.exec(section(2)),/RESERVE_V2_ROWS_EXIST/);
    await db.query('rollback').catch(()=>{});
    assert.deepEqual(await protectedState(db),before);
    const clean=new runtime.Database();
    try {
      await clean.exec(fixtureSql);
      const cleanBefore=await protectedState(clean);
      for(const file of migrationFiles) await clean.exec(readMigration(file));
      await clean.exec(section(2));await clean.exec(section(3));
      assert.equal((await one(clean,"select count(*)::int n from pg_proc where pronamespace='public'::regnamespace and (proname like 'ledger_%rent%' or proname like 'ledger_%reserve%v2')")).n,0);
      assert.equal((await one(clean,"select count(*)::int n from information_schema.columns where table_name='ledger_reserve_entries' and column_name in('allocation_kind','request_key')")).n,0);
      assert.deepEqual(await protectedState(clean),cleanBefore);
    } finally { await clean.close(); }
  });
});
