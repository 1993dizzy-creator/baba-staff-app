import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

const migration = readFileSync("supabase/migrations/20260929100000_edit_manual_ledger_display.sql", "utf8");
const api = readFileSync("app/api/admin/ledger/transactions/[id]/display/route.ts", "utf8");

async function database() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create table users(id bigint primary key, role text, is_active boolean, app_login_enabled boolean);
    create table ledger_transactions(
      id bigint primary key, type text, status text, source_type text, source_key text,
      correction_of_id bigint, business_date date, memo text, source_snapshot jsonb default '{}'::jsonb,
      amount numeric, category_id bigint, party_id bigint, occurred_at timestamptz,
      recognition_month date, updated_at timestamptz default now()
    );
    create table ledger_movements(id bigint primary key, transaction_id bigint, fund_account_id bigint, amount numeric);
    create table ledger_audit_logs(id bigint generated always as identity primary key, actor_user_id bigint,
      action text, entity_type text, entity_id bigint, before_snapshot jsonb, after_snapshot jsonb, reason text);
    create table closed_months(month date primary key);
    create function ledger_month_is_closed_v1(p_month date) returns boolean language sql as $$
      select exists(select 1 from closed_months where month=p_month) $$;
    insert into users values(1,'owner',true,true),(2,'staff',true,true);
    insert into ledger_transactions(id,type,status,source_type,business_date,memo,amount,category_id,party_id,occurred_at,recognition_month)
      values(1,'expense','confirmed','manual','2026-09-29','Original memo',10000,7,4,'2026-09-29T12:00:00+07:00','2026-09-01');
    insert into ledger_movements values(1,1,10,-10000);
  `);
  await db.exec(migration);
  return db;
}

async function edit(db, id=1, actor=1, title="Fixed title", memo="Fixed memo", reason="Typo") {
  const result = await db.query("select ledger_edit_manual_transaction_display_v1($1,$2,$3,$4,$5) as result", [id,title,memo,reason,actor]);
  return result.rows[0].result;
}

test("manual display RPC changes only title and memo and audits before/after with reason", async () => {
  const db = await database();
  try {
    const before = (await db.query("select * from ledger_transactions where id=1")).rows[0];
    const movementBefore = (await db.query("select * from ledger_movements where transaction_id=1")).rows;
    assert.equal((await edit(db)).status, "updated");
    const after = (await db.query("select * from ledger_transactions where id=1")).rows[0];
    assert.equal(after.display_snapshot.titleOverride, "Fixed title");
    assert.equal(after.memo, "Fixed memo");
    assert.deepEqual(after.source_snapshot, before.source_snapshot);
    for (const field of ["amount","category_id","party_id","occurred_at","business_date","recognition_month","type","source_type","source_key"]) assert.deepEqual(after[field], before[field], field);
    assert.deepEqual((await db.query("select * from ledger_movements where transaction_id=1")).rows, movementBefore);
    const audit = (await db.query("select * from ledger_audit_logs")).rows[0];
    assert.equal(audit.reason, "Typo");
    assert.equal(audit.action, "manual_transaction_display_edited");
    assert.equal(audit.before_snapshot.memo, "Original memo");
    assert.equal(audit.after_snapshot.memo, "Fixed memo");
    assert.equal(audit.after_snapshot.display_snapshot.titleOverride, "Fixed title");
    assert.equal((await edit(db,1,1,"Fixed title","Fixed memo","Again")).status, "unchanged");
    assert.equal((await db.query("select count(*)::int as n from ledger_audit_logs")).rows[0].n, 1);
  } finally { await db.close(); }
});

test("manual display RPC blocks closed months, unauthorized actors and non-generic rows", async () => {
  const db = await database();
  try {
    assert.equal((await edit(db,1,2)).status, "forbidden");
    assert.equal((await edit(db,1,1,"Title","Memo"," ")).status, "invalid_input");
    await db.exec("insert into closed_months values('2026-09-01')");
    assert.equal((await edit(db)).status, "month_closed");
    await db.exec("delete from closed_months");
    for (const [type, source, key, correction] of [
      ["payroll_payment","manual",null,null], ["payable_payment","manual",null,null],
      ["card_settlement_deposit","card_settlement_deposit",null,null],
      ["expense","inventory_purchase_candidate",null,null],
      ["expense","manual",null,99],
      ["balance_adjustment","manual",null,null],
    ]) {
      await db.query("update ledger_transactions set type=$1,source_type=$2,source_key=$3,correction_of_id=$4 where id=1", [type,source,key,correction]);
      assert.equal((await edit(db)).status, "unsupported_transaction", `${type}/${source}`);
    }
    assert.equal((await db.query("select count(*)::int as n from ledger_audit_logs")).rows[0].n, 0);
  } finally { await db.close(); }
});

test("API accepts only display fields and calls service-role RPC", () => {
  assert.match(api, /ALLOWED_FIELDS = new Set\(\["title", "memo", "reason"\]\)/);
  assert.match(api, /requireLedgerActor\(\)/);
  assert.match(api, /rpc\("ledger_edit_manual_transaction_display_v1"/);
  assert.doesNotMatch(api, /\.from\("ledger_transactions"\)\.update/);
  assert.match(migration, /security definer set search_path = pg_catalog, public/);
  assert.match(migration, /grant execute on function public\.ledger_edit_manual_transaction_display_v1\(bigint, text, text, text, bigint\) to service_role/);
});


test("manual display RPC is security definer with a fixed search path and service-role-only execution", async () => {
  const db = await database();
  try {
    const { rows } = await db.query("select p.prosecdef, p.proconfig from pg_proc p where p.oid='public.ledger_edit_manual_transaction_display_v1(bigint,text,text,text,bigint)'::regprocedure");
    assert.equal(rows[0].prosecdef, true);
    assert.ok(rows[0].proconfig.includes("search_path=pg_catalog, public"));
    const signature = "public.ledger_edit_manual_transaction_display_v1(bigint,text,text,text,bigint)";
    for (const role of ["anon", "authenticated"]) {
      const access = await db.query("select has_function_privilege($1,$2,'EXECUTE') as allowed", [role,signature]);
      assert.equal(access.rows[0].allowed, false, role);
    }
    const service = await db.query("select has_function_privilege('service_role',$1,'EXECUTE') as allowed", [signature]);
    assert.equal(service.rows[0].allowed, true);
  } finally { await db.close(); }
});
