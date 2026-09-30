import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import ts from "typescript";

const base = readFileSync("supabase/migrations/20260929063551_edit_manual_ledger_display.sql", "utf8");
const migration = readFileSync("supabase/migrations/20260930063332_edit_manual_transaction_amount.sql", "utf8");
const api = readFileSync("app/api/admin/ledger/transactions/[id]/manual-edit/route.ts", "utf8");

async function database() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create table users(id bigint primary key, role text, is_active boolean, app_login_enabled boolean);
    create table ledger_transactions(id bigint primary key, type text, status text, source_type text,
      source_key text, correction_of_id bigint, business_date date, memo text,
      source_snapshot jsonb default '{}'::jsonb, amount numeric, category_id bigint,
      party_id bigint, occurred_at timestamptz, recognition_month date,
      updated_at timestamptz default now());
    create table ledger_movements(id bigint primary key, transaction_id bigint, fund_account_id bigint, amount numeric);
    create table ledger_audit_logs(id bigint generated always as identity primary key, actor_user_id bigint,
      action text, entity_type text, entity_id bigint, before_snapshot jsonb, after_snapshot jsonb, reason text);
    create table closed_months(month date primary key);
    create function ledger_month_is_closed_v1(p_month date) returns boolean language sql as $$
      select exists(select 1 from closed_months where month=p_month) $$;
    insert into users values (1,'owner',true,true),(2,'master',true,true),(3,'staff',true,true),(4,'owner',false,true);
    insert into ledger_transactions(id,type,status,source_type,business_date,memo,amount,category_id,party_id,occurred_at,recognition_month)
      values
      (1,'expense','confirmed','manual','2026-09-29','Old memo',100,7,8,'2026-09-29T12:00:00+07:00','2026-09-01'),
      (2,'income','confirmed','manual','2026-09-29','Old memo',100,9,8,'2026-09-29T12:00:00+07:00','2026-09-01'),
      (3,'transfer','confirmed','manual','2026-09-29','Old memo',100,null,8,'2026-09-29T12:00:00+07:00',null),
      (4,'payable_payment','confirmed','manual','2026-09-29','Old memo',100,null,8,'2026-09-29T12:00:00+07:00',null),
      (5,'payroll_payment','confirmed','manual','2026-09-29','Old memo',100,null,8,'2026-09-29T12:00:00+07:00',null),
      (6,'balance_adjustment','confirmed','manual','2026-09-29','Old memo',100,null,8,'2026-09-29T12:00:00+07:00',null),
      (7,'expense','confirmed','automatic','2026-09-29','Old memo',100,7,8,'2026-09-29T12:00:00+07:00','2026-09-01'),
      (8,'expense','confirmed','manual','2026-09-29','Old memo',100,7,8,'2026-09-29T12:00:00+07:00','2026-09-01'),
      (9,'expense','confirmed','manual','2026-09-29','Old memo',100,7,8,'2026-09-29T12:00:00+07:00','2026-09-01');
    update ledger_transactions set correction_of_id=1 where id=8;
    insert into ledger_movements values (1,1,10,-100),(2,2,11,100),(3,3,10,-100),(4,3,11,100),
      (5,4,10,-100),(6,5,10,-100),(7,6,10,-100),(8,7,10,-100),(9,8,10,-100),(10,9,10,-100);
  `);
  await db.exec(base);
  await db.exec(migration);
  return db;
}

async function edit(db, id, { title = "New title", amount = 150, memo = "New memo", reason = "Correction", actor = 1 } = {}) {
  const { rows } = await db.query("select ledger_edit_manual_transaction_v1($1,$2,$3,$4,$5,$6) as result",
    [id, title, amount, memo, reason, actor]);
  return rows[0].result;
}

test("expense, income and transfer update amount, display and audit atomically", async () => {
  const db = await database();
  try {
    for (const [id, expected] of [[2, [150]], [3, [-150, 150]]]) {
      const before = (await db.query("select * from ledger_transactions where id=$1", [id])).rows[0];
      assert.equal((await edit(db, id)).status, "updated");
      const after = (await db.query("select * from ledger_transactions where id=$1", [id])).rows[0];
      assert.equal(Number(after.amount), 150);
      assert.equal(after.display_snapshot.titleOverride, "New title");
      assert.equal(after.memo, "New memo");
      for (const key of ["category_id", "party_id", "occurred_at", "business_date", "recognition_month", "source_type", "source_key", "source_snapshot"])
        assert.deepEqual(after[key], before[key], key);
      assert.deepEqual((await db.query("select amount from ledger_movements where transaction_id=$1 order by id", [id])).rows.map(row => Number(row.amount)), expected);
      const audit = (await db.query("select * from ledger_audit_logs where entity_id=$1", [id])).rows[0];
      assert.equal(audit.action, "manual_transaction_edited");
      assert.equal(audit.reason, "Correction");
      assert.equal(Number(audit.before_snapshot.transaction.amount), 100);
      assert.equal(Number(audit.after_snapshot.transaction.amount), 150);
      assert.deepEqual(audit.before_snapshot.movements.map(row => Number(row.amount)), expected.map(n => n < 0 ? -100 : 100));
      assert.deepEqual(audit.after_snapshot.movements.map(row => Number(row.amount)), expected);
    }
    await db.exec("update ledger_transactions set correction_of_id=null where id=8");
    assert.equal((await edit(db, 1)).status, "updated");
    assert.equal(Number((await db.query("select amount from ledger_movements where id=1")).rows[0].amount), -150);
  } finally { await db.close(); }
});

test("same amount permits title and memo edit; identical input is a no-op", async () => {
  const db = await database();
  try {
    assert.equal((await edit(db, 9, { title: "Old memo", amount: 100, memo: "Old memo" })).status, "unchanged");
    assert.equal((await edit(db, 2, { amount: 100 })).status, "updated");
    assert.equal((await edit(db, 2, { amount: 100 })).status, "unchanged");
    assert.equal(Number((await db.query("select amount from ledger_movements where transaction_id=2")).rows[0].amount), 100);
    assert.equal((await db.query("select count(*)::int as n from ledger_audit_logs")).rows[0].n, 1);
  } finally { await db.close(); }
});

test("authorization, type, correction, amount and closed-month guards", async () => {
  const db = await database();
  try {
    assert.equal((await edit(db, 2, { actor: 3 })).status, "forbidden");
    assert.equal((await edit(db, 2, { actor: 4 })).status, "forbidden");
    assert.equal((await edit(db, 2, { actor: 2 })).status, "updated");
    for (const amount of [0, -1, 1.5, null]) assert.equal((await edit(db, 2, { amount })).status, "invalid_input");
    for (const id of [4, 5, 6, 7, 8]) assert.equal((await edit(db, id)).status, "unsupported_transaction");
    assert.equal((await edit(db, 1)).status, "already_corrected");
    await db.exec("insert into closed_months values ('2026-09-01')");
    assert.equal((await edit(db, 3)).status, "month_closed");
  } finally { await db.close(); }
});

test("invalid movement shape writes neither transaction, movement nor audit", async () => {
  const db = await database();
  try {
    await db.exec("update ledger_movements set amount=-90 where id=1");
    const before = (await db.query("select * from ledger_transactions where id=1")).rows[0];
    await db.exec("update ledger_transactions set correction_of_id=null where id=8");
    assert.equal((await edit(db, 1)).status, "invalid_movements");
    assert.deepEqual((await db.query("select * from ledger_transactions where id=1")).rows[0], before);
    assert.equal(Number((await db.query("select amount from ledger_movements where id=1")).rows[0].amount), -90);
    assert.equal((await db.query("select count(*)::int as n from ledger_audit_logs")).rows[0].n, 0);
  } finally { await db.close(); }
});

test("security definer, fixed search path and RPC privileges", async () => {
  const db = await database();
  try {
    const signature = "public.ledger_edit_manual_transaction_v1(bigint,text,numeric,text,text,bigint)";
    const { rows } = await db.query("select prosecdef,proconfig from pg_proc where oid=$1::regprocedure", [signature]);
    assert.equal(rows[0].prosecdef, true);
    assert.ok(rows[0].proconfig.includes("search_path=pg_catalog, public"));
    for (const role of ["anon", "authenticated"])
      assert.equal((await db.query("select has_function_privilege($1,$2,'EXECUTE') as allowed", [role, signature])).rows[0].allowed, false);
    assert.equal((await db.query("select has_function_privilege('service_role',$1,'EXECUTE') as allowed", [signature])).rows[0].allowed, true);
    assert.equal((await db.query("select has_function_privilege('postgres',$1,'EXECUTE') as allowed", [signature])).rows[0].allowed, true);
  } finally { await db.close(); }
});

test("API uses dedicated RPC and rejects unsafe amount", () => {
  assert.match(api, /ALLOWED_FIELDS = new Set\(\["title", "amount", "memo", "reason"\]\)/);
  assert.match(api, /Number\.isSafeInteger\(amount\)/);
  assert.match(api, /rpc\("ledger_edit_manual_transaction_v1"/);
  assert.doesNotMatch(api, /ledger_edit_manual_transaction_display_v1/);
});

test("numeric(16,3) integer boundary is accepted and the next integer is rejected by RPC", async () => {
  const db = await database();
  try {
    const maximum = 9999999999999;
    assert.equal((await edit(db, 2, { amount: maximum })).status, "updated");
    assert.equal(Number((await db.query("select amount from ledger_transactions where id=2")).rows[0].amount), maximum);
    assert.equal(Number((await db.query("select amount from ledger_movements where transaction_id=2")).rows[0].amount), maximum);
    assert.equal((await edit(db, 2, { amount: maximum + 1 })).status, "invalid_input");
    assert.equal(Number((await db.query("select amount from ledger_transactions where id=2")).rows[0].amount), maximum);
    assert.equal((await db.query("select count(*)::int as n from ledger_audit_logs")).rows[0].n, 1);
  } finally { await db.close(); }
});

test("manual-edit API accepts the numeric boundary and rejects the next integer before RPC", async () => {
  const code = ts.transpileModule(api, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const calls = [];
  const deps = {
    "@/lib/ledger/server": {
      async requireLedgerActor() { return { actor: { id: 1 }, response: null }; },
      ledgerJson(body, status = 200) { return { body, status }; },
    },
    "@/lib/supabase/server": {
      supabaseServer: {
        async rpc(name, args) {
          calls.push({ name, args });
          return { data: { status: "updated" }, error: null };
        },
      },
    },
  };
  const module = { exports: {} };
  new Function("require", "module", "exports", code)(name => deps[name], module, module.exports);
  const post = amount => module.exports.POST(
    new Request("http://localhost/api/admin/ledger/transactions/2/manual-edit", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Title", amount, memo: "Memo", reason: "Correction" }),
    }),
    { params: Promise.resolve({ id: "2" }) },
  );
  assert.equal((await post(9999999999999)).status, 200);
  assert.equal(calls[0].args.p_amount, 9999999999999);
  assert.equal((await post(10000000000000)).status, 400);
  assert.equal(calls.length, 1);
});
