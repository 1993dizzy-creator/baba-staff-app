import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { before, after } from 'node:test';
import { fixture, INDEX_MIGRATION, ROW_COUNT, FILTERS, SELECT_COLUMNS, ORDER, queryFor, readPages, explain, planNodes } from './helpers/inventory-log-read-index-fixture.mjs';
let db; const baseline = new Map(); let beforePlan;
before(async () => {
  db = await fixture();
  for (const [name, filter] of Object.entries(FILTERS)) baseline.set(name, await readPages(db, filter));
  beforePlan = await explain(db, queryFor());
  await db.exec(readFileSync(INDEX_MIGRATION, 'utf8')); await db.exec('analyze inventory_logs');
});
after(async () => { await db?.close(); });
test('latest 500 actual card fields replace Seq Scan/Sort with the exact narrow ordering index', async () => {
  assert.ok(planNodes(beforePlan.Plan).some(node => node['Node Type'] === 'Seq Scan'));
  assert.ok(planNodes(beforePlan.Plan).some(node => node['Node Type'] === 'Sort'));
  const actual = await explain(db, queryFor());
  assert.ok(planNodes(actual.Plan).some(node => node['Index Name'] === 'inventory_logs_created_at_id_read_idx'));
  assert.ok(planNodes(actual.Plan).every(node => node['Node Type'] !== 'Sort'));
  assert.equal(actual.Plan['Actual Rows'], 500);
  assert.deepEqual((await db.query(queryFor().sql)).rows, baseline.get('all').rows.slice(0, 500));
});
for (const [name, filter] of Object.entries(FILTERS)) test(`all pages preserve every projected field and order for ${name}`, async () => {
  const actual = await readPages(db, filter);
  assert.deepEqual(actual, baseline.get(name));
  assert.equal(new Set(actual.rows.map(row => String(row.id))).size, actual.rows.length);
  assert.deepEqual(actual.rows, (await db.query(`select ${SELECT_COLUMNS} from inventory_logs ${filter ? 'where '+filter : ''} ${ORDER}`)).rows);
  if (name === 'all') { assert.equal(actual.rows.length, ROW_COUNT); assert.equal(actual.requests, 24); }
});
test('equal timestamps, microseconds and the transition to NULL never lose or repeat cursor rows', async () => {
  const rows = baseline.get('all').rows;
  const positions = rows.map((row, index) => index).filter(index => index > 0 && rows[index].created_at === rows[index-1].created_at);
  assert.ok(positions.length > 1000);
  const boundary = rows.findIndex(row => row.created_at === null);
  for (const index of [499, 999, positions[500], boundary-1, boundary, boundary+20]) {
    const row = rows[index]; const query = queryFor('', {id:Number(row.id),created_at:row.created_at});
    assert.deepEqual((await db.query(query.sql, query.params)).rows, rows.slice(index+1,index+501));
  }
  const plan = await explain(db, queryFor('', {id:Number(rows[boundary+20].id),created_at:null}));
  assert.ok(planNodes(plan.Plan).some(node => node['Index Name'] === 'inventory_logs_created_at_id_read_idx'));
  assert.ok(planNodes(plan.Plan).every(node => node['Node Type'] !== 'Sort'));
});
test('migration adds one non-covering ordering index without replacing existing indexes or rewriting logs', async () => {
  const sql = readFileSync(INDEX_MIGRATION, 'utf8').replace(/--[^\n]*/g,'');
  assert.match(sql,/create index inventory_logs_created_at_id_read_idx\s+on public\.inventory_logs using btree \(created_at desc nulls last, id desc\)/);
  assert.doesNotMatch(sql,/\b(update|insert|delete|alter|drop|include|function|trigger|grant|revoke)\b/i);
  const indexes = (await db.query("select indexname,indexdef from pg_indexes where tablename='inventory_logs'")).rows;
  assert.equal(indexes.filter(row=>row.indexname==='inventory_logs_created_at_id_read_idx').length,1);
  for (const name of ['inventory_logs_stock_check_item_business_date_idx','inventory_logs_sale_deduction_item_business_date_idx','inventory_logs_purchase_correction_idx'])assert.ok(indexes.some(row=>row.indexname===name));
  assert.equal(Number((await db.query('select count(*) n from inventory_logs')).rows[0].n),ROW_COUNT);
});
