import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { BABA_TABLES, BABA_TABLES_EVIDENCE, babaTableCatalog } from '../lib/sales/baba-table-catalog.ts';
import { input, order, overview, now } from './helpers/table-overview-fixture.mjs';

test('verified BABA inventory: 27 actual UUIDs, 11/8/8 Owner areas, no duplicate identities/names or invented 9/10', () => {
  assert.equal(BABA_TABLES.length, 27);
  assert.equal(new Set(BABA_TABLES.map(t => t.MapObjectID)).size, 27);
  assert.equal(new Set(BABA_TABLES.map(t => t.MapObjectName)).size, 27);
  assert.deepEqual(BABA_TABLES.filter(t => t.displayArea === 'bar').map(t => t.MapObjectName), Array.from({length:11},(_,i)=>'BAR'+(i+1)));
  assert.deepEqual(BABA_TABLES.filter(t => t.displayArea === 'floor1').map(t => t.MapObjectName), ['1','2','3','4','5','6','7','8']);
  assert.deepEqual(BABA_TABLES.filter(t => t.displayArea === 'floor2').map(t => t.MapObjectName), ['11','12','13','14','15','16','17','18']);
  assert.ok(!BABA_TABLES.some(t => t.MapObjectName === '9' || t.MapObjectName === '10'));
  for (const table of BABA_TABLES) {
    assert.equal(table.AreaName, table.displayArea === 'floor2' ? 'B' : 'A');
    assert.equal(table.AreaID, table.AreaName === 'A' ? 'ee074f4e-82e3-4bb0-b4c6-dba90289cdf5' : '2c5cfe86-68a2-4aab-9568-88ee309e5905');
    assert.equal(table.observedIsAvailable, true);
  }
  const identities = BABA_TABLES.map(({MapObjectID,MapObjectName,AreaID,AreaName,observedIsAvailable}) =>
    ({MapObjectID,MapObjectName,AreaID,AreaName,observedIsAvailable})).sort((a,b)=>a.MapObjectID.localeCompare(b.MapObjectID));
  // Expected digest calculated independently from the approved operational response, not catalog output.
  assert.equal(createHash('sha256').update(JSON.stringify(identities)).digest('hex'), 'e102d7055f376433f26a56f4301ac4563518a95807b17d1c24267e7929141650');
  assert.equal(BABA_TABLES_EVIDENCE.sourceSha256, '445c1a96491fcb7e370e8454a9c091aac4c9baefcb833d575dfed7c2fbfa3c60');
  assert.equal(BABA_TABLES_EVIDENCE.fetchedAt, '2026-11-12T18:17:40.919Z');
  assert.equal(BABA_TABLES_EVIDENCE.allowMergeTable, 0);
});

test('static catalog remains visible after probe time; historical true never supplies current free/paid/reserved states', () => {
  const catalog = babaTableCatalog();
  assert.equal(catalog.kind, 'verified_static');
  assert.ok(catalog.tables.every(t => t.available === null));
  const result = overview({ catalog, orders: [] });
  assert.equal(result.summary.total, 27); assert.equal(result.summary.occupied, 0);
  assert.equal(result.summary.unknown, 27);
  assert.equal(result.summary.free, null); assert.equal(result.summary.paid, null); assert.equal(result.summary.reserved, null);
  assert.ok(result.tables.every(t => t.state === 'unknown'));
  assert.equal(result.tables.filter(t => t.area === 'bar').length, 11);
  assert.equal(result.tables.filter(t => t.area === 'floor1').length, 8);
  assert.equal(result.tables.filter(t => t.area === 'floor2').length, 8);
  // Returned projections cannot mutate the tracked catalog or future reads.
  catalog.tables[0].name = 'mutated';
  assert.equal(babaTableCatalog().tables[0].name, 'BAR1');
});

test('synthetic current orders match all 27 actual table names exactly and preserve separate OrderIds', () => {
  const orders = BABA_TABLES.map((table,i)=>order('synthetic-'+i,table.MapObjectName));
  const result = overview({ catalog: babaTableCatalog(), orders: [...orders, orders[0], order('second-bar1','BAR1')] });
  assert.equal(result.summary.occupied, 27); assert.ok(result.tables.every(t=>t.state === 'occupied'));
  assert.equal(result.tables[0].orders.length, 2);
  assert.deepEqual(result.tables[0].orders.map(o=>o.id), ['synthetic-0','second-bar1']);
  assert.equal(result.unlinked.length, 0);
});

test('catalog never overrides order freshness/errors/uncertainty; BAR alone and composite names remain unlinked', () => {
  const base = input(), catalog = babaTableCatalog();
  for (const changes of [
    { enabled:false }, { sync:null }, { sync:{...base.sync,lastErrorCode:'orders_vanished_unconfirmed'} },
    { sync:{...base.sync,lastErrorCode:'provider_timeout'} },
    { sync:{...base.sync,lastSuccessAt:new Date(now.getTime()-11*60_000).toISOString()} },
    { orders:[order('old','BAR1',{businessDate:'2026-11-12'})] },
    { orders:[order('unknown','BAR1',{status:6})] },
    { orders:[order('menu-missing','BAR1',{lines:null})] },
  ]) {
    const result = overview({ catalog, orders:[order('synthetic','BAR1')], ...changes });
    assert.equal(result.tables.length, 27); assert.ok(result.tables.every(t=>t.state==='unknown'));
  }
  const unmatched = overview({ catalog, orders:[order('a','BAR'),order('b','1+2'),order('c','BAR1/BAR2'),order('d',null)] });
  assert.equal(unmatched.unlinked.length,4); assert.ok(unmatched.tables.every(t=>t.state==='unknown'));
});

test('tables page server uses only the static identity catalog, regardless of the operational Tables flag', () => {
  const source = readFileSync('lib/sales/table-overview-server.ts','utf8');
  assert.match(source,/const catalog = babaTableCatalog\(\)/);
  assert.doesNotMatch(source,/tables-read-server|loadTableCatalog|POS_TABLES_READ_ENABLED|loginCukcuk/);
});
