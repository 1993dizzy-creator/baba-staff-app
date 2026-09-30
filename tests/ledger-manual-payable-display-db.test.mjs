import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

const base = readFileSync("supabase/migrations/20260929063551_edit_manual_ledger_display.sql", "utf8");
const migration = readFileSync("supabase/migrations/20260929180508_allow_manual_payable_display_edit.sql", "utf8");

async function database() {
  const db = new PGlite();
  await db.exec([
    "create role anon; create role authenticated; create role service_role;",
    "create table users(id bigint primary key, role text, is_active boolean, app_login_enabled boolean);",
    "create table ledger_transactions(id bigint primary key,type text,status text,source_type text,source_key text,correction_of_id bigint,business_date date,memo text,source_snapshot jsonb default '{}'::jsonb,amount numeric,category_id bigint,party_id bigint,occurred_at timestamptz,recognition_month date,updated_at timestamptz default now());",
    "create table ledger_movements(id bigint primary key,transaction_id bigint,fund_account_id bigint,amount numeric);",
    "create table ledger_payable_allocations(id bigint primary key,payable_id bigint,payment_transaction_id bigint,allocated_amount numeric);",
    "create table ledger_audit_logs(id bigint generated always as identity primary key,actor_user_id bigint,action text,entity_type text,entity_id bigint,before_snapshot jsonb,after_snapshot jsonb,reason text);",
    "create table closed_months(month date primary key);",
    "create function ledger_month_is_closed_v1(p_month date) returns boolean language sql as $$ select exists(select 1 from closed_months where month=p_month) $$;",
    "insert into users values(1,'owner',true,true),(2,'staff',true,true),(3,'master',true,true),(4,'owner',false,true);",
    "insert into ledger_transactions(id,type,status,source_type,source_key,business_date,memo,source_snapshot,amount,category_id,party_id,occurred_at,recognition_month) values(1675,'payable_payment','confirmed','manual','delayed-purchase-payment:inventory-log:10017:2026-09-04','2026-09-04','8/29 켄트 담배 50개 매입분 실제 지연결제 · 9/4 Cho 계좌 1,900,000₫','{\"paymentKind\":\"delayed_purchase_payment\",\"originalTransactionId\":794,\"originalInventoryLogId\":10017}',1900000,null,7,'2026-09-04T12:00:00+07:00',null);",
    "insert into ledger_transactions(id,type,status,source_type,source_key,business_date,memo,amount,category_id,occurred_at,recognition_month) values(1661,'expense','confirmed','manual','sheet-manual-expense:2026-09:row-120','2026-09-12','diet con trun thang 678 · 해충방제',4500000,21,'2026-09-12T12:00:00+07:00','2026-09-01'),(1724,'transfer','confirmed','manual','sheet-manual-transfer:2026-09:row-122','2026-09-12','9월 시트 row122 · doi tien mat · Cho → 현금 1,500,000₫',1500000,null,'2026-09-12T12:00:00+07:00',null),(2000,'payroll_payment','confirmed','manual',null,'2026-09-12','Payroll',100,null,null,null),(2001,'payable_payment','confirmed','automatic',null,'2026-09-12','Auto payable',100,null,null,null),(2002,'expense','confirmed','manual',null,'2026-09-12','Corrected',100,21,null,'2026-09-01');",
    "update ledger_transactions set correction_of_id=1661 where id=2002;",
    "insert into ledger_movements values(1,1675,10,-1900000),(2,1661,11,-4500000),(3,1724,10,-1500000),(4,1724,12,1500000);",
    "insert into ledger_payable_allocations values(1,794,1675,1900000);",
  ].join("\n"));
  await db.exec(base);
  await db.exec(migration);
  return db;
}

async function edit(db, id, actor = 1, title = "수정 제목", memo = "수정 메모", reason = "표시 정정") {
  const result = await db.query("select ledger_edit_manual_transaction_display_v1($1,$2,$3,$4,$5) as result", [id,title,memo,reason,actor]);
  return result.rows[0].result;
}

test("manual payable, expense and transfer edit title and memo while economic data and allocations stay unchanged", async () => {
  const db = await database();
  try {
    const beforeRows = (await db.query("select * from ledger_transactions order by id")).rows;
    const beforeMovements = (await db.query("select * from ledger_movements order by id")).rows;
    const beforeAllocations = (await db.query("select * from ledger_payable_allocations order by id")).rows;
    for (const id of [1675,1661,1724]) {
      assert.equal((await edit(db,id)).status,"updated");
      const after = (await db.query("select * from ledger_transactions where id=$1",[id])).rows[0];
      const before = beforeRows.find(row => row.id === id);
      assert.equal(after.display_snapshot.titleOverride,"수정 제목");
      assert.equal(after.memo,"수정 메모");
      for (const key of ["amount","type","status","source_type","source_key","correction_of_id","business_date","category_id","party_id","occurred_at","recognition_month","source_snapshot"])
        assert.deepEqual(after[key],before[key],key);
    }
    assert.deepEqual((await db.query("select * from ledger_movements order by id")).rows,beforeMovements);
    assert.deepEqual((await db.query("select * from ledger_payable_allocations order by id")).rows,beforeAllocations);
    const audits = (await db.query("select * from ledger_audit_logs order by id")).rows;
    assert.equal(audits.length,3);
    for (const audit of audits) {
      assert.equal(audit.action,"manual_transaction_display_edited");
      assert.equal(audit.reason,"표시 정정");
      assert.equal(audit.after_snapshot.memo,"수정 메모");
      assert.equal(audit.after_snapshot.display_snapshot.titleOverride,"수정 제목");
      assert.notEqual(audit.before_snapshot.memo,audit.after_snapshot.memo);
    }
  } finally { await db.close(); }
});

test("RPC retains role, active user, input, source, correction and closed month guards", async () => {
  const db = await database();
  try {
    assert.equal((await edit(db,1675,2)).status,"forbidden");
    assert.equal((await edit(db,1675,4)).status,"forbidden");
    assert.equal((await edit(db,1675,1,"","Memo","Reason")).status,"invalid_input");
    assert.equal((await edit(db,1675,1,"Title","Memo","")).status,"invalid_input");
    for (const id of [2000,2001,2002]) assert.equal((await edit(db,id)).status,"unsupported_transaction");
    await db.exec("insert into closed_months values('2026-09-01')");
    assert.equal((await edit(db,1675)).status,"month_closed");
    assert.equal((await db.query("select count(*)::int as n from ledger_audit_logs")).rows[0].n,0);
  } finally { await db.close(); }
});

test("RPC security remains definer with fixed search path and service-role-only execution", async () => {
  const db = await database();
  try {
    assert.match(migration,/create or replace function public\.ledger_edit_manual_transaction_display_v1/);
    assert.match(migration,/v_transaction\.type not in \('income', 'expense', 'transfer', 'payable_payment'\)/);
    assert.doesNotMatch(migration,/alter table|update public\.ledger_movements|update public\.ledger_payable_allocations/i);
    const signature = "public.ledger_edit_manual_transaction_display_v1(bigint,text,text,text,bigint)";
    const info = (await db.query("select prosecdef,proconfig from pg_proc where oid=$1::regprocedure",[signature])).rows[0];
    assert.equal(info.prosecdef,true);
    assert.ok(info.proconfig.includes("search_path=pg_catalog, public"));
    for (const role of ["anon","authenticated"])
      assert.equal((await db.query("select has_function_privilege($1,$2,'EXECUTE') as allowed",[role,signature])).rows[0].allowed,false);
    assert.equal((await db.query("select has_function_privilege('service_role',$1,'EXECUTE') as allowed",[signature])).rows[0].allowed,true);
  } finally { await db.close(); }
});
