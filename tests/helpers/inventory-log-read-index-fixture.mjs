import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
export const INDEX_MIGRATION = 'supabase/migrations/20261009161017_add_inventory_logs_created_at_id_read_index.sql';
const source = readFileSync('app/api/inventory/logs/route.ts', 'utf8');
const ast = ts.createSourceFile('route.ts', source, ts.ScriptTarget.Latest, true);
const declaration = ast.statements.filter(ts.isVariableStatement).flatMap(node => [...node.declarationList.declarations]).find(node => node.name.getText(ast) === 'LOG_CARD_COLUMNS');
if (!declaration?.initializer) throw Error('Missing actual inventory card projection');
// Execute the actual pure array/flatMap/join projection initializer from the API.
export const CARD_COLUMNS = new Function(`return ${declaration.initializer.getText(ast)}`)().split(',').map(s => s.trim());
export const SELECT_COLUMNS = CARD_COLUMNS.map(name => name === 'created_at' ? 'created_at::text as created_at' : name).join(',');
export const ROW_COUNT = 11890;
// Qualify the timestamp key so the test's textual timestamp output (needed to
// preserve microseconds in JS) cannot become the ORDER BY expression.
export const ORDER = 'order by inventory_logs.created_at desc nulls last, inventory_logs.id desc';
export const FILTERS = {
  all: '', businessDate: "business_date='2026-09-02'", item: 'item_id=2', reason: "reason='purchase'",
  combined: "business_date='2026-09-02' and item_id=2 and reason='purchase'",
  stockCheck: "item_id=2 and reason='stock_check'", saleDeduction: "item_id=2 and reason='sale_deduction'",
};
export function queryFor(filter = '', cursor) {
  const conditions = filter ? [filter] : []; const params = [];
  if (cursor) {
    params.push(cursor.id);
    if (cursor.created_at === null) conditions.push('created_at is null and id<$1');
    else { params.push(cursor.created_at); conditions.push('(created_at<$2::timestamptz or (created_at=$2::timestamptz and id<$1) or created_at is null)'); }
  }
  return { sql: `select ${SELECT_COLUMNS} from inventory_logs ${conditions.length ? 'where ' + conditions.join(' and ') : ''} ${ORDER} limit 500`, params };
}
export async function readPages(db, filter = '') {
  const rows = []; let cursor; let requests = 0;
  for (;;) {
    const query = queryFor(filter, cursor);
    const page = (await db.query(query.sql, query.params)).rows; requests++; rows.push(...page);
    if (page.length < 500) return { rows, requests };
    cursor = { id: Number(page.at(-1).id), created_at: page.at(-1).created_at };
  }
}
export async function explain(db, query) {
  return (await db.query('explain (analyze, buffers, format json) ' + query.sql, query.params)).rows[0]['QUERY PLAN'][0];
}
export function planNodes(plan) { return [plan, ...(plan.Plans ?? []).flatMap(planNodes)]; }
export async function fixture() {
  const db = new PGlite();
  // Do not force an index choice: use the normal PostgreSQL scan alternatives.
  await db.exec('set enable_seqscan=on; set enable_indexscan=on; set enable_bitmapscan=on;');
  const numeric = name => /(?:quantity|purchase_price|low_stock_threshold)$/.test(name);
  const columns = CARD_COLUMNS.map(name => name === 'id' ? 'id bigint primary key' : `${name} ${name === 'created_at' ? 'timestamptz' : name === 'item_id' ? 'bigint' : numeric(name) ? 'numeric' : 'text'}`);
  await db.exec(`create table inventory_logs (${columns.join(',')},business_date date,related_batch_id bigint,purchase_supplier_partner_id bigint,source_actor_user_id bigint,correction_of_inventory_log_id bigint);`);
  const values = CARD_COLUMNS.map(name => name === 'id' ? 'i' : name === 'item_id' ? 'i%10+1' : name === 'created_at'
    ? "case when i%67=0 then null else timestamptz '2026-09-01 00:00:00+07'+(i/4)*interval '1 second'+((i%4)/2)*interval '1 microsecond' end"
    : name === 'reason' ? "case when i%3=0 then 'stock_check' when i%3=1 then 'purchase' else 'sale_deduction' end"
    : numeric(name) ? '100' : name.endsWith('note') ? 'repeat(md5(i::text),10)' : "'sample-'||i%10");
  await db.exec(`insert into inventory_logs (${CARD_COLUMNS.join(',')},business_date) select ${values.join(',')},date '2026-09-01'+(i%30)::int from generate_series(1,${ROW_COUNT}) i;`);
  for (const name of ['202607050002_add_inventory_stock_check_log_index.sql', '202607050003_add_inventory_sale_deduction_log_index.sql'])await db.exec(readFileSync('supabase/migrations/' + name, 'utf8'));
  await db.exec(`create index inventory_logs_related_batch_idx on inventory_logs(related_batch_id);
    create index inventory_logs_purchase_supplier_partner_idx on inventory_logs(purchase_supplier_partner_id) where purchase_supplier_partner_id is not null;
    create index inventory_logs_source_actor_idx on inventory_logs(source_actor_user_id) where source_actor_user_id is not null;
    create index inventory_logs_purchase_correction_idx on inventory_logs(correction_of_inventory_log_id,id); analyze inventory_logs;`);
  return db;
}
