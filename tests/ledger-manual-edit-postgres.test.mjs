import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { nativeInventoryPostgres } from './helpers/inventory-native-postgres.mjs';
import { fixtureSql, readMigration, ledgerTotals } from './helpers/ledger-manual-edit-native-fixture.mjs';

// Real PostgreSQL (local binaries only). TX#2415 party SQL + manual edit/cancel migration.
const one = async (c, sql, args = []) => (await c.query(sql, args)).rows[0];
const call = async (c, sql, args = []) => Object.values(await one(c, sql, args))[0];
// The exact stored value (microseconds), as the API passes it back: a JS Date would truncate it.
const updatedAt = async (db, id) => (await one(db, 'select updated_at::text u from ledger_transactions where id=$1', [id])).u;
const edit = async (db, id, changes, actor = 1, reason = 'QA 수정') =>
  call(db, 'select ledger_update_manual_transaction_v2($1,$2,$3,$4,$5) r', [id, await updatedAt(db, id), changes, reason, actor]);
const cancel = async (db, id, actor = 1, reason = 'QA 삭제') =>
  call(db, 'select ledger_cancel_manual_transaction_v1($1,$2,$3,$4) r', [id, await updatedAt(db, id), reason, actor]);
const movements = async (db, id) => (await db.query('select id,fund_account_id,amount::numeric::text amount from ledger_movements where transaction_id=$1 order by id', [id])).rows
  .map(r => ({ id: Number(r.id), account: Number(r.fund_account_id), amount: Number(r.amount) }));
const closures = db => db.query('select month,status,revision,snapshot_hash from ledger_month_closures order by month').then(r => r.rows);
const audits = db => db.query('select * from ledger_audit_logs order by id').then(r => r.rows);

test('manual transaction edit/cancel and TX#2415 party link on native PostgreSQL', {
  skip: !process.env.QA_POSTGRES_BIN && 'No local PostgreSQL configured', timeout: 180000,
}, async t => {
  const runtime = await nativeInventoryPostgres({ testContext: t }); t.diagnostic(runtime.version);
  const db = new runtime.Database();
  t.after(() => db.close());
  await db.exec(fixtureSql);
  const closed = await closures(db);
  const auditStart = await audits(db);

  await t.test('TX#2415 → THỦY NAM #35: party only, amount and cash movement unchanged, one audit row, idempotent', async () => {
    const before = await one(db, 'select * from ledger_transactions where id=2415');
    const totals = await ledgerTotals(db);
    const sql = readFileSync('scripts/ledger/tx2415-thuy-nam-party.sql', 'utf8');
    await db.exec(sql);
    const after = await one(db, 'select * from ledger_transactions where id=2415');
    assert.equal(Number(after.party_id), 35);
    const strip = row => Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'party_id' && key !== 'updated_at'));
    assert.deepEqual(strip(after), strip(before));
    assert.deepEqual(await movements(db, 2415), [{ id: 1235, account: 1, amount: -500000 }]);
    assert.deepEqual(await ledgerTotals(db), totals, 'balances and P&L unchanged');
    const linkAudit = (await audits(db)).filter(a => a.action === 'manual_transaction_party_linked');
    assert.equal(linkAudit.length, 1);
    assert.equal(linkAudit[0].before_snapshot.transaction.party_id, null);
    assert.equal(linkAudit[0].after_snapshot.transaction.party_id, 35);
    const stamp = await updatedAt(db, 2415);
    await db.exec(sql); // second run: no-op
    assert.equal((await audits(db)).filter(a => a.action === 'manual_transaction_party_linked').length, 1);
    assert.equal(await updatedAt(db, 2415), stamp);
  });

  await t.test('install the migration; no existing row changes', async () => {
    const rows = (await db.query('select * from ledger_transactions order by id')).rows;
    const moves = (await db.query('select * from ledger_movements order by id')).rows;
    await db.exec(readMigration());
    assert.deepEqual((await db.query('select * from ledger_transactions order by id')).rows, rows);
    assert.deepEqual((await db.query('select * from ledger_movements order by id')).rows, moves);
    const grants = (await db.query(`select proname,has_function_privilege('anon',oid,'execute') anon,has_function_privilege('authenticated',oid,'execute') auth,
      has_function_privilege('service_role',oid,'execute') svc,prosecdef from pg_proc where proname like 'ledger_%manual_transaction%' and pronamespace='public'::regnamespace order by 1`)).rows;
    for (const row of grants) {
      assert.equal(row.anon, false, row.proname); assert.equal(row.auth, false, row.proname); assert.equal(row.prosecdef, true);
      assert.equal(row.svc, ['ledger_update_manual_transaction_v2', 'ledger_cancel_manual_transaction_v1'].includes(row.proname), row.proname);
    }
  });

  await t.test('expense edit: amount, account, party, date, title, memo; only sent fields; movement updated in place; audit before/after', async () => {
    const totals = await ledgerTotals(db);
    const result = await edit(db, 2415, { amount: 600000, fromAccountId: 2, occurredAt: '2026-10-20T10:00:00+07:00', title: '돼지고기 (THỦY NAM)' });
    assert.equal(result.status, 'updated');
    assert.deepEqual(result.changedFields, ['occurredAt', 'amount', 'fromAccountId', 'title']);
    const row = await one(db, 'select *, business_date::text b, recognition_month::text r from ledger_transactions where id=2415');
    assert.deepEqual([row.type, Number(row.amount), row.b, row.r, Number(row.party_id), Number(row.category_id), row.display_snapshot.titleOverride, row.memo],
      ['expense', 600000, '2026-10-20', '2026-10-01', 35, 42, '돼지고기 (THỦY NAM)', '10/2 돼지고기 현금 구매, 거래처인지 미납금인지 확인안됨']);
    assert.deepEqual(await movements(db, 2415), [{ id: 1235, account: 2, amount: -600000 }], 'same movement row');
    const after = await ledgerTotals(db);
    assert.equal(after.balances[1], totals.balances[1] + 500000);
    assert.equal(after.balances[2], totals.balances[2] - 600000);
    assert.equal(after.pl.expense, totals.pl.expense + 100000);
    const audit = (await audits(db)).at(-1);
    assert.equal(audit.action, 'manual_transaction_updated');
    assert.equal(Number(audit.before_snapshot.transaction.amount), 500000);
    assert.equal(Number(audit.after_snapshot.transaction.amount), 600000);
    assert.deepEqual(audit.before_snapshot.movements.map(m => Number(m.fund_account_id)), [1]);
    assert.equal(audit.reason, 'QA 수정');
    assert.equal((await edit(db, 2415, { memo: '10/2 돼지고기 현금 구매, 거래처인지 미납금인지 확인안됨' })).status, 'unchanged');
    assert.equal((await edit(db, 2415, { memo: '메모만' })).status, 'updated');
    assert.equal(Number((await one(db, 'select amount from ledger_transactions where id=2415')).amount), 600000, 'memo-only edit keeps amount');
  });

  await t.test('03:00 business day and moving months', async () => {
    await edit(db, 3000, { occurredAt: '2026-11-01T02:59:00+07:00' });
    let row = await one(db, "select business_date::text b, recognition_month::text r from ledger_transactions where id=3000");
    assert.deepEqual([row.b, row.r], ['2026-10-31', '2026-10-01'], '02:59 is still 10/31');
    await edit(db, 3000, { occurredAt: '2026-11-01T03:00:00+07:00' });
    row = await one(db, "select business_date::text b, recognition_month::text r from ledger_transactions where id=3000");
    assert.deepEqual([row.b, row.r], ['2026-11-01', '2026-11-01'], 'recognition month follows the new business month');
    await edit(db, 3000, { occurredAt: '2026-10-05T12:00:00+07:00' });
  });

  await t.test('closed months: neither out of nor into a closed month; Aug/Sep closures unchanged', async () => {
    assert.equal((await edit(db, 2415, { occurredAt: '2026-09-30T12:00:00+07:00' })).status, 'month_closed');
    assert.equal((await edit(db, 3002, { amount: 1 })).status, 'month_closed');
    assert.equal((await cancel(db, 3002)).status, 'month_closed');
    assert.deepEqual(await closures(db), closed);
  });

  await t.test('type changes and validation', async () => {
    const id = Number((await one(db, `insert into ledger_transactions(type,occurred_at,business_date,recognition_month,amount,category_id,status,source_type,confirmed_by)
      values('expense','2026-10-10T05:00:00Z','2026-10-10','2026-10-01',30000,43,'confirmed','manual',1) returning id`)).id);
    await db.query('insert into ledger_movements(transaction_id,fund_account_id,amount) values($1,1,-30000)', [id]);
    assert.equal((await edit(db, id, { type: 'transfer' })).status, 'invalid_accounts', 'transfer needs a to account');
    assert.equal((await edit(db, id, { type: 'transfer', toAccountId: 1 })).status, 'invalid_accounts', 'same account');
    assert.equal((await edit(db, id, { type: 'transfer', toAccountId: 2 })).status, 'updated');
    let row = await one(db, 'select type,category_id,recognition_month,party_id from ledger_transactions where id=$1', [id]);
    assert.deepEqual([row.type, row.category_id, row.recognition_month], ['transfer', null, null]);
    assert.deepEqual((await movements(db, id)).map(m => [m.account, m.amount]), [[1, -30000], [2, 30000]]);
    assert.equal((await edit(db, id, { type: 'income' })).status, 'invalid_category');
    assert.equal((await edit(db, id, { type: 'income', categoryId: 42 })).status, 'invalid_category', 'expense category on income');
    assert.equal((await edit(db, id, { type: 'income', categoryId: 9, partyId: 35 })).status, 'invalid_party');
    assert.equal((await edit(db, id, { type: 'income', categoryId: 9 })).status, 'updated');
    row = await one(db, 'select type,category_id,recognition_month::text r from ledger_transactions where id=$1', [id]);
    assert.deepEqual([row.type, Number(row.category_id), row.r], ['income', 9, '2026-10-01']);
    assert.deepEqual((await movements(db, id)).map(m => [m.account, m.amount]), [[2, 30000]], 'from side removed');
    assert.equal((await edit(db, id, { type: 'expense', categoryId: 44, fromAccountId: 1 })).status, 'invalid_category', 'inactive category');
    assert.equal((await edit(db, id, { type: 'expense', categoryId: 43, fromAccountId: 9 })).status, 'invalid_accounts', 'inactive account');
    assert.equal((await edit(db, id, { type: 'expense', categoryId: 43, fromAccountId: 1, partyId: 36 })).status, 'invalid_party', 'inactive party');
    assert.equal((await edit(db, id, { amount: 1.5 })).status, 'invalid_amount');
    assert.equal((await edit(db, id, { bogus: 1 })).status, 'invalid_input');
    assert.equal((await edit(db, id, { memo: 'x' }, 2)).status, 'forbidden', 'staff');
    assert.equal((await edit(db, id, { memo: 'x' }, 4)).status, 'forbidden', 'inactive owner');
    assert.equal((await edit(db, id, { memo: 'x' }, 3)).status, 'updated', 'owner');
  });

  await t.test('cancel ("삭제") income, expense and transfer: row and movements kept, totals drop exactly once, no double cancel', async () => {
    for (const id of [3000, 2415, 3001]) {
      const totals = await ledgerTotals(db);
      const tx = await one(db, 'select type,amount from ledger_transactions where id=$1', [id]);
      const kept = await movements(db, id);
      const stamp = await updatedAt(db, id);
      const result = await cancel(db, id);
      assert.equal(result.status, 'cancelled', String(id));
      assert.equal((await one(db, 'select status from ledger_transactions where id=$1', [id])).status, 'cancelled');
      assert.deepEqual(await movements(db, id), kept, 'movements preserved');
      const after = await ledgerTotals(db);
      for (const m of kept) assert.equal(after.balances[m.account], totals.balances[m.account] - m.amount);
      if (tx.type !== 'transfer') assert.equal(after.pl[tx.type] ?? 0, (totals.pl[tx.type] ?? 0) - Number(tx.amount));
      else assert.deepEqual(after.pl, totals.pl, 'transfer never touches P&L');
      assert.equal((await call(db, 'select ledger_cancel_manual_transaction_v1($1,$2,$3,1) r', [id, stamp, '중복'])).status, 'already_cancelled');
      assert.equal((await cancel(db, id)).status, 'already_cancelled');
      assert.equal((await edit(db, id, { memo: 'x' })).status, 'already_cancelled');
      assert.deepEqual(await ledgerTotals(db), after, 'second cancel changes nothing');
      const audit = (await audits(db)).filter(a => a.action === 'manual_transaction_cancelled' && Number(a.entity_id) === id);
      assert.equal(audit.length, 1);
      assert.equal(audit[0].before_snapshot.transaction.status, 'confirmed');
      assert.equal(audit[0].after_snapshot.transaction.status, 'cancelled');
    }
    assert.equal((await call(db, "select ledger_cancel_manual_transaction_v1(3003,now(),'  ',1) r")).status, 'invalid_input', 'reason required');
  });

  await t.test('linked, special and automatic rows keep their own correction flows', async () => {
    for (const [id, status] of [[3003, 'linked_transaction'], [3006, 'linked_transaction'], [3004, 'special_transaction'], [3005, 'unsupported_transaction'], [5, 'unsupported_transaction']]) {
      assert.equal((await edit(db, id, { memo: 'x' })).status, status, `edit ${id}`);
      assert.equal((await cancel(db, id)).status, status, `cancel ${id}`);
    }
    assert.equal((await call(db, "select ledger_update_manual_transaction_v2(999999,now(),'{\"memo\":\"x\"}',$1,1) r", ['r'])).status, 'not_found');
  });

  await t.test('stale and concurrent edits: one wins, the other is refused, nothing is lost', async () => {
    const id = Number((await one(db, `insert into ledger_transactions(type,occurred_at,business_date,recognition_month,amount,category_id,status,source_type,confirmed_by)
      values('expense','2026-10-11T05:00:00Z','2026-10-11','2026-10-01',40000,43,'confirmed','manual',1) returning id`)).id);
    await db.query('insert into ledger_movements(transaction_id,fund_account_id,amount) values($1,1,-40000)', [id]);
    const stamp = await updatedAt(db, id);
    assert.equal((await call(db, 'select ledger_update_manual_transaction_v2($1,$2,$3,$4,1) r', [id, '2000-01-01T00:00:00Z', { amount: 1 }, 'old'])).status, 'stale');
    const a = await runtime.connect(db.name), b = await runtime.connect(db.name);
    try {
      await a.query('begin');
      const first = await call(a, 'select ledger_update_manual_transaction_v2($1,$2,$3,$4,1) r', [id, stamp, { amount: 41000 }, 'A']);
      assert.equal(first.status, 'updated');
      const second = call(b, 'select ledger_cancel_manual_transaction_v1($1,$2,$3,1) r', [id, stamp, 'B']);
      await new Promise(resolve => setTimeout(resolve, 300));
      await a.query('commit');
      assert.equal((await second).status, 'stale', 'cancel based on the old version is refused');
    } finally { await a.query('rollback').catch(() => {}); await a.end(); await b.end(); }
    const row = await one(db, 'select status,amount from ledger_transactions where id=$1', [id]);
    assert.deepEqual([row.status, Number(row.amount)], ['confirmed', 41000]);
    assert.deepEqual(await movements(db, id).then(rows => rows.map(m => m.amount)), [-41000]);
  });

  await t.test('migration install: atomic first run, idempotent re-run, full rollback on failure', async () => {
    const sql = readMigration();
    assert.match(sql, /^begin;$/m); assert.match(sql, /^commit;\s*$/m);
    assert.equal((sql.match(/^create or replace function public\./gm) || []).length, 4);
    assert.doesNotMatch(sql, /^create function /m);
    const commitAt = sql.lastIndexOf('commit;');
    const failing = sql.slice(0, commitAt) + 'select 1/0;\n' + sql.slice(commitAt);
    const state = async c => ({
      functions: (await c.query(`select proname, md5(prosrc) body, prosecdef, proconfig::text cfg,
        has_function_privilege('anon',oid,'execute') anon, has_function_privilege('authenticated',oid,'execute') auth,
        has_function_privilege('service_role',oid,'execute') svc, coalesce(proacl::text,'') acl
        from pg_proc where pronamespace='public'::regnamespace and proname like 'ledger_%manual_transaction%' order by proname`)).rows,
      transactions: (await c.query('select * from ledger_transactions order by id')).rows,
      movements: (await c.query('select * from ledger_movements order by id')).rows,
      audits: (await c.query('select count(*)::int n from ledger_audit_logs')).rows[0].n,
      closures: (await c.query('select * from ledger_month_closures order by id')).rows,
    });
    const fresh = new runtime.Database();
    try {
      await fresh.exec(fixtureSql);
      const empty = await state(fresh);
      assert.deepEqual(empty.functions, []);
      // Failure before COMMIT on an empty database: nothing is left behind.
      await assert.rejects(fresh.exec(failing), /division by zero/);
      await fresh.query('rollback');
      assert.deepEqual(await state(fresh), empty);
      // First run.
      await fresh.exec(sql);
      const installed = await state(fresh);
      assert.equal(installed.functions.length, 4);
      for (const fn of installed.functions) {
        assert.equal(fn.prosecdef, true, fn.proname); assert.equal(fn.cfg, '{"search_path=pg_catalog, public"}', fn.proname);
        assert.equal(fn.anon, false, fn.proname); assert.equal(fn.auth, false, fn.proname);
        assert.equal(fn.svc, ['ledger_update_manual_transaction_v2', 'ledger_cancel_manual_transaction_v1'].includes(fn.proname), fn.proname);
      }
      assert.deepEqual({ ...installed, functions: [] }, { ...empty, functions: [] }, 'install writes no data');
      // Re-run: same bodies, same grants, same data.
      await fresh.exec(sql);
      assert.deepEqual(await state(fresh), installed);
      // Failure during a re-run: the installed functions and grants stay exactly as they were.
      await assert.rejects(fresh.exec(failing), /division by zero/);
      await fresh.query('rollback');
      assert.deepEqual(await state(fresh), installed);
      // Still callable after the failed re-run.
      const version = (await one(fresh, 'select updated_at::text u from ledger_transactions where id=3000')).u;
      assert.equal((await call(fresh, 'select ledger_update_manual_transaction_v2(3000,$1,$2,$3,1) r', [version, { memo: '재실행 후' }, 'QA'])).status, 'updated');
    } finally { await fresh.close(); }
  });

  await t.test('closures unchanged; audit log only appended', async () => {
    assert.deepEqual(await closures(db), closed);
    const all = await audits(db);
    assert.deepEqual(all.slice(0, auditStart.length), auditStart);
  });
});
