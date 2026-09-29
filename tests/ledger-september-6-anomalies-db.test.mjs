import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

const migration = readFileSync("supabase/migrations/20260929115054_correct_september_6_ledger_identity.sql", "utf8");

async function database(closed = false) {
  const db = new PGlite();
  await db.exec([
    "create table users(id bigint primary key, role text, is_active boolean, app_login_enabled boolean);",
    "create table ledger_parties(id bigint primary key, name text, is_active boolean);",
    "create table ledger_categories(id bigint primary key, name text, kind text, is_active boolean);",
    "create table ledger_supplier_party_mappings(id bigint primary key, supplier_name text, party_id bigint, is_active boolean);",
    "create table ledger_fund_accounts(id bigint primary key, type text);",
    "create table ledger_transactions(id bigint primary key, source_type text, type text, status text, correction_of_id bigint, business_date date, amount numeric, party_id bigint, category_id bigint, memo text, display_snapshot jsonb default '{}'::jsonb, source_snapshot jsonb default '{}'::jsonb, economic_effect_sign int default 1, updated_at timestamptz default now());",
    "create table ledger_movements(id bigint primary key, transaction_id bigint, fund_account_id bigint, amount numeric);",
    "create table ledger_candidates(id bigint primary key, source_type text, source_key text, status text, resolved_transaction_id bigint);",
    "create table inventory_logs(id bigint primary key, item_id bigint, business_date date, source text, reason text, new_supplier text);",
    "create table ledger_payables(id bigint primary key, expense_transaction_id bigint);",
    "create table ledger_audit_logs(id bigint generated always as identity primary key, actor_user_id bigint, action text, entity_type text, entity_id bigint, before_snapshot jsonb, after_snapshot jsonb, reason text);",
    "create table closed_months(month date primary key);",
    "create function ledger_month_is_closed_v1(p_month date) returns boolean language sql as $$ select exists(select 1 from closed_months where month=p_month) $$;",
    "insert into users values(1,'owner',true,true);",
    "insert into ledger_parties values(3,'Chợ',true),(4,'Shopee',true);",
    "insert into ledger_categories values(8,'보험·복리후생','expense',true),(9,'식자재 매입','expense',true);",
    "insert into ledger_supplier_party_mappings values(1,'Shopee',4,true);",
    "insert into ledger_fund_accounts values(1,'cash');",
    "insert into ledger_transactions(id,source_type,type,status,business_date,amount,category_id,memo,source_snapshot) values(1767,'manual','expense','confirmed','2026-09-06',515000,9,'thit lon · 9월 시트 수기 비용','{\"sheet\":\"September\"}');",
    "insert into ledger_transactions(id,source_type,type,status,business_date,amount,category_id,source_snapshot) values(2000,'inventory_purchase_candidate','expense','confirmed','2026-09-06',153000,9,'{\"inventory_log_id\":10423,\"supplier\":null}');",
    "insert into ledger_transactions(id,source_type,type,status,business_date,amount,category_id,memo) values(900,'manual','expense','confirmed','2026-08-31',666250,9,'Chợ 돼지등심');",
    "insert into ledger_movements values(1,1767,1,-515000),(2,2000,1,-153000),(3,900,1,-666250);",
    "insert into ledger_candidates values(1,'inventory_purchase_log','inventory-log:10423','confirmed',2000);",
    "insert into inventory_logs values(10423,591,'2026-09-06','create','purchase',null),(10427,591,'2026-09-06','edit_form','edit','Shopee');",
  ].join("\n"));
  if (closed) await db.exec("insert into closed_months values('2026-09-01')");
  return db;
}

test("data migration changes identity only and audits both transactions", async () => {
  const db = await database();
  try {
    const before = (await db.query("select id,amount,business_date,source_snapshot from ledger_transactions order by id")).rows;
    const movements = (await db.query("select * from ledger_movements order by id")).rows;
    await db.exec(migration);
    const rows = (await db.query("select * from ledger_transactions order by id")).rows;
    const pork = rows.find(row => row.id === 1767);
    const shopee = rows.find(row => row.id === 2000);
    assert.equal(pork.display_snapshot.titleOverride, "야유회 돼지고기 구입");
    assert.equal(pork.memo, "7~8일 직원 야유회용 시장 구매");
    assert.equal(pork.party_id, 3);
    assert.equal(pork.category_id, 8);
    assert.equal(shopee.party_id, 4);
    assert.equal(rows.find(row => row.id === 900).memo, "Chợ 돼지등심");
    assert.deepEqual((await db.query("select id,amount,business_date,source_snapshot from ledger_transactions order by id")).rows, before);
    assert.deepEqual((await db.query("select * from ledger_movements order by id")).rows, movements);
    assert.deepEqual((await db.query("select action from ledger_audit_logs order by id")).rows.map(row => row.action),
      ["september_6_manual_identity_corrected", "september_6_inventory_supplier_linked"]);
    const audit = (await db.query("select before_snapshot,after_snapshot,reason from ledger_audit_logs where entity_id=2000")).rows[0];
    assert.equal(audit.before_snapshot.party_id, null);
    assert.equal(audit.after_snapshot.party_id, 4);
    assert.match(audit.reason, /Inventory log #10423/);
  } finally { await db.close(); }
});

test("closed September blocks the migration with no writes", async () => {
  const db = await database(true);
  try {
    await assert.rejects(db.exec(migration), /SEPTEMBER_6_IDENTITY_MONTH_CLOSED/);
    assert.equal((await db.query("select party_id from ledger_transactions where id=2000")).rows[0].party_id, null);
    assert.equal((await db.query("select count(*)::int as count from ledger_audit_logs")).rows[0].count, 0);
  } finally { await db.close(); }
});
test("Shopee correction requires both the original purchase and the later supplier edit", async () => {
  for (const missingLogId of [10423, 10427]) {
    const db = await database();
    try {
      await db.query("delete from inventory_logs where id=$1", [missingLogId]);
      await assert.rejects(db.exec(migration), /SEPTEMBER_6_SHOPEE_PRECONDITION_FAILED/);
      assert.equal((await db.query("select party_id from ledger_transactions where id=2000")).rows[0].party_id, null);
      assert.equal((await db.query("select count(*)::int as count from ledger_audit_logs")).rows[0].count, 0);
    } finally { await db.close(); }
  }
});