import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';

export const originalPath = 'supabase/migrations/20261114120000_create_reservation_inbox_foundation.sql';
export const hardeningPath = 'supabase/migrations/20261114120001_reservation_phase1_hardening.sql';
export const original = readFileSync(originalPath, 'utf8');
export const hardening = readFileSync(hardeningPath, 'utf8');
export const users = `create role anon; create role authenticated; create role service_role; create schema extensions;
create table public.users(id bigint primary key, role text, is_active boolean, app_login_enabled boolean);
insert into public.users values (1,'owner',true,true),(2,'master',true,true),(3,'manager',true,true),
 (4,'leader',true,true),(5,'staff',true,true),(6,'staff',false,true),(7,'staff',true,false),(8,'outsider',true,true);`;
export async function fixture(applyHardening = true) {
  const db = new PGlite({ extensions: { btree_gist } });
  try {
    await db.exec(users);
    await db.exec(original);
    if (applyHardening) await db.exec(hardening);
    return db;
  } catch (error) { await db.close(); throw error; }
}
export const queryRows = async (db, sql, args = []) => (await db.query(sql, args)).rows;
export const json = value => ({ value: JSON.stringify(value), type: '::jsonb' });
export async function rpc(db, name, args) {
  await db.exec('set role service_role');
  try {
    return (await queryRows(db, `select public.${name}(${args.map((v, i) => `$${i+1}${v?.type ?? ''}`).join(',')}) result`,
      args.map(v => v?.type ? v.value : v)))[0].result;
  } finally { await db.exec('reset role'); }
}
export const input = extra => ({ customerName: 'Synthetic Customer', customerContact: 'offline-contact-only',
  note: 'synthetic free text', partySize: 4, reservedAt: '2026-11-15T19:00:00+07:00', ...extra });
export const create = async (db, extra = {}) => (await rpc(db, 'reservation_create_v1', [4, json(input(extra))])).reservation;
export const ingest = (db, extra = {}) => rpc(db, 'reservation_inbox_ingest_v1', [json({
  status: 'received', event_name: 'message.text.received', chat_type: 'GROUP', chat_id: 'offline-group', message_id: 'offline-message',
  message_text: 'synthetic original', payload_sha256: 'a'.repeat(64), raw_payload: { text: 'synthetic raw' }, ...extra })]);
