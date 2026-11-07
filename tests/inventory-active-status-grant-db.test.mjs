// Isolated PGlite only. Reproduces the /inventory "비활성" failure: after P1-2F (20261102144000)
// service_role could no longer UPDATE public.inventory.is_active, so the active-status PATCH failed with
// 42501 for every role and the UI showed "권한이 없습니다". 20261108130000 grants only that column.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { writerFixture, item, definition } from './helpers/inventory-writer-integration-fixture.mjs';
import { readMigration } from './helpers/pos-shadow-fixture.mjs';

async function p12fChain() {
  const db = new PGlite();
  await writerFixture(db);
  await db.exec(readMigration('20261102142849_pos_signed_projection_epochs_and_handoff.sql'));
  const ingestion = readMigration('20261102113150_pos_reliable_cukcuk_ingestion.sql');
  await db.exec(ingestion.slice(0, ingestion.indexOf('alter table pos_ingest_private.runs')));
  await db.exec(definition(ingestion, 'pos_ingest_private.canonical_hash'));
  // Operating broad grants first, so the profile's revokes are exercised.
  await db.exec('grant select,insert,update,delete,truncate on inventory,inventory_logs to service_role,anon,authenticated;grant update(quantity),insert(quantity) on inventory to service_role');
  await db.exec(readMigration('20261102144000_pos_writer_least_privilege_and_day_reconciliation.sql'));
  return db;
}
// Exactly what the active-status route writes.
const deactivate = "update inventory set is_active=false,updated_by_name='master user',updated_by_username='master' where id=1";

test('before the grant the active-status write is denied for service_role (the reported bug)', async () => {
  const db = await p12fChain();
  try {
    await db.exec('set role service_role');
    await assert.rejects(db.exec(deactivate), e => e.code === '42501');
    await db.exec('reset role');
    assert.equal((await item(db)).is_active, true);
  } finally { await db.close(); }
});

test('with the grant is_active can be toggled; quantity, unit, package and row creation stay writer-only', async () => {
  const db = await p12fChain();
  try {
    await db.exec(readFileSync('supabase/migrations/20261108130000_inventory_active_status_column_grant.sql', 'utf8'));
    const before = await item(db);
    await db.exec('set role service_role');
    try {
      await db.exec(deactivate);
      for (const sql of ['update inventory set quantity=99 where id=1', "update inventory set unit='kg' where id=1", 'update inventory set package_content_quantity=20000 where id=1', "insert into inventory(item_name,quantity) values('forged',5)", 'delete from inventory where id=1'])
        await assert.rejects(db.exec(sql), e => e.code === '42501', sql);
      await db.exec("update inventory set is_active=true,updated_by_name='master user',updated_by_username='master' where id=1");
    } finally { await db.exec('reset role'); }
    const after = await item(db);
    assert.equal(after.is_active, true);
    assert.equal(after.quantity, before.quantity, 'quantity untouched');
    assert.equal(after.updated_by_username, 'master');
  } finally { await db.close(); }
});

test('the app role check already allows master; a DB writer denial is not shown as a role problem', () => {
  // items-server.ts is server-only, so its role list is checked from source (master must be present).
  const server = readFileSync('lib/inventory/items-server.ts', 'utf8');
  const roles = server.slice(server.indexOf('export const canToggleInventoryItemActiveStatus'), server.indexOf('export const getInventoryKegCandidateIds'));
  for (const role of ['owner', 'master', 'manager', 'leader']) assert.match(roles, new RegExp('role === "' + role + '"'), role);
  assert.doesNotMatch(roles, /staff/);
  const page = readFileSync('components/inventory/InventoryPageContent.tsx', 'utf8');
  assert.match(page, /res\.status === 403 && result\.error === "inventory_writer_permission_review_required"\) \{\s*alert\(t\.activeStatusWriterBlocked\);/);
  const text = readFileSync('lib/text/inventory.ts', 'utf8');
  assert.equal((text.match(/activeStatusWriterBlocked:/g) || []).length, 2, 'KO and VI');
});
