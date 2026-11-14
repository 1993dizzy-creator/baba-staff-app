// Reservation Phase 1 migration on an isolated PGlite database (no production credentials).
// Covers: webhook -> inbox through the real persist adapter, dedup, DB failure / retry,
// quarantine + reprocess, privileges, staff roles, lifecycle + history, planned table
// conflicts, Asia/Ho_Chi_Minh 03:00 business day, append-only audit, PII retention purge.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { getBusinessDate } from '../lib/common/business-time.ts';
import { buildZaloInboxPlan, fingerprint, handleZaloWebhook } from '../lib/zalo/webhook-poc.ts';
import { createZaloInboxPersist } from '../lib/reservations/zalo-inbox-store.ts';

const migration = readFileSync('supabase/migrations/20261114120000_create_reservation_inbox_foundation.sql', 'utf8');
const SECRET = 'test-webhook-secret-0123456789';
const GROUP_ID = 'grp-test-0001';
const TEXT = '@Bot đặt BABA TEST 0901234567';
const CONTACT = '0901 234 567';
const ENV = { ZALO_BOT_WEBHOOK_SECRET: SECRET, ZALO_BOT_WEBHOOK_MODE: 'persist', ZALO_BOT_WEBHOOK_POC_ALLOWED_GROUP_IDS: fingerprint(GROUP_ID) };
const U = { owner: 1, manager: 2, leader: 3, staff: 4, master: 5, inactive: 6, noLogin: 7, unknown: 99 };

async function fixture() {
  const db = new PGlite({ extensions: { btree_gist } });
  await db.exec(`create role anon; create role authenticated; create role service_role; create schema extensions;
    create table public.users(id bigint primary key, role text, is_active boolean, app_login_enabled boolean);
    insert into public.users values (1,'owner',true,true),(2,'manager',true,true),(3,'leader',true,true),(4,'staff',true,true),
      (5,'master',true,true),(6,'manager',false,true),(7,'leader',true,false);`);
  await db.exec(migration);
  return db;
}

const rows = async (db, sql, args = []) => (await db.query(sql, args)).rows;
// Every RPC is executed AS service_role (the app's role), proving the grants.
async function asRole(db, role, sql, args = []) {
  await db.exec(`set role ${role}`);
  try { return (await db.query(sql, args)).rows; } finally { await db.exec('reset role'); }
}
const rpc = async (db, fn, args) => (await asRole(db, 'service_role',
  `select public.${fn}(${args.map((a, i) => `$${i + 1}${a?.cast ?? ''}`).join(',')}) r`, args.map(a => (a?.cast ? a.v : a))))[0].r;
const j = v => ({ v: JSON.stringify(v), cast: '::jsonb' });
const arr = v => ({ v, cast: '::text[]' });

const pgClient = db => ({
  rpc: async (fn, args) => {
    try { return { data: await rpc(db, fn, [j(args.p_entry)]), error: null }; }
    catch (e) { return { data: null, error: { code: e.code, message: e.message } }; }
  },
});

function event({ chat_id = GROUP_ID, message_id = 'msg-1', event_name = 'message.text.received', text = TEXT, date = 1794551160000 } = {}) {
  return { event_name, message: { message_id, date, message_type: 'CHAT_TEXT',
    from: { id: 'sender-1', display_name: 'Khach Test', is_bot: false }, chat: { id: chat_id, chat_type: 'GROUP' }, text } };
}
const post = (db, body, logs = []) => handleZaloWebhook(
  new Request('https://example.test/api/integrations/zalo-bot', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bot-api-secret-token': SECRET },
    body: typeof body === 'string' ? body : JSON.stringify(body) }),
  ENV, (tag, data) => logs.push(data), createZaloInboxPersist(async () => pgClient(db)));

const PII = [TEXT, '0901234567', CONTACT, 'Khach Test', 'sender-1', GROUP_ID, 'Nguyen Van A'];
function assertNoPii(value, label) {
  const text = JSON.stringify(value);
  for (const p of PII) assert.ok(!text.includes(p), `${label} leaked ${p}`);
}

test('webhook persist: stored once, redeliveries counted, other groups never stored, failures not ACKed', async () => {
  const db = await fixture();
  try {
    const logs = [];
    const first = await post(db, event(), logs);
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { ok: true, observed: true, stored: true, duplicate: false });
    const again = await post(db, event(), logs);
    assert.deepEqual(await again.json(), { ok: true, observed: true, stored: true, duplicate: true });
    await post(db, event({ text: '@Bot edited' }), logs);
    const [inbox] = await rows(db, 'select * from reservation_private.inbox');
    assert.equal((await rows(db, 'select count(*)::int n from reservation_private.inbox'))[0].n, 1);
    assert.deepEqual([inbox.status, inbox.delivery_count, inbox.payload_mismatch_count], ['received', 3, 1]);
    assert.equal(inbox.message_text, TEXT, 'first payload is kept as evidence');
    assert.equal(inbox.group_fp, fingerprint(GROUP_ID), 'SQL fingerprint == TS fingerprint');
    assert.equal(inbox.message_fp, fingerprint('msg-1'));
    assert.equal(inbox.message_at.toISOString(), '2026-11-13T06:26:00.000Z');
    assert.equal(inbox.business_date.toISOString().slice(0, 10), '2026-11-13');

    const other = await post(db, event({ chat_id: 'grp-other' }), logs);
    assert.deepEqual(await other.json(), { ok: true, observed: false, stored: false });
    const quarantined = await post(db, { hello: 'world' }, logs);
    assert.equal((await quarantined.json()).stored, true);
    const broken = await post(db, '{"event_name":', logs);
    assert.equal(broken.status, 200);
    const all = await rows(db, 'select status, quarantine_reason, raw_body is not null raw from reservation_private.inbox order by id');
    assert.deepEqual(all, [
      { status: 'received', quarantine_reason: null, raw: false },
      { status: 'quarantined', quarantine_reason: 'unknown_event_shape', raw: false },
      { status: 'quarantined', quarantine_reason: 'invalid_json', raw: true }]);

    const events = await rows(db, 'select event_type, changes from reservation_private.reservation_events order by id');
    assert.deepEqual(events.map(e => e.event_type), ['inbox_received', 'inbox_duplicate', 'inbox_duplicate', 'inbox_quarantined', 'inbox_quarantined']);
    assertNoPii(events, 'events');
    assertNoPii(logs, 'logs');

    // DB unavailable (e.g. migration not applied / function missing): 503, nothing stored or ACKed.
    await db.exec('alter function public.reservation_inbox_ingest_v1(jsonb) rename to reservation_inbox_ingest_v1_off');
    const failLogs = [];
    const down = await post(db, event({ message_id: 'msg-2' }), failLogs);
    assert.equal(down.status, 503);
    assert.equal(JSON.parse(failLogs[0]).error_code, 'pg_42883');
    assertNoPii(failLogs, 'failure log');
    await db.exec('alter function public.reservation_inbox_ingest_v1_off(jsonb) rename to reservation_inbox_ingest_v1');
    assert.equal((await rows(db, "select count(*)::int n from reservation_private.inbox where message_id='msg-2'"))[0].n, 0);
    const retried = await post(db, event({ message_id: 'msg-2' }));
    assert.equal((await retried.json()).duplicate, false);
    assert.equal((await (await post(db, event({ message_id: 'msg-2' }))).json()).duplicate, true);
    assert.equal((await rows(db, "select count(*)::int n from reservation_private.inbox where message_id='msg-2'"))[0].n, 1);
  } finally { await db.close(); }
});

test('ingest RPC validates its input and rejects a received row that is not allowlist-shaped', async () => {
  const db = await fixture();
  try {
    const base = { status: 'received', event_name: 'message.text.received', chat_type: 'GROUP', chat_id: 'g', message_id: 'm',
      message_text: 'x', payload_sha256: 'a'.repeat(64), raw_payload: {} };
    for (const bad of [{ ...base, status: 'linked' }, { ...base, payload_sha256: 'xyz' }, { ...base, chat_type: 'PRIVATE' },
      { ...base, message_id: '' }, { ...base, message_text: 5 }, { ...base, raw_body: 'both' },
      Object.fromEntries(Object.entries(base).filter(([key]) => key !== 'raw_payload')),
      { ...base, status: 'quarantined' }]) {
      assert.equal((await rpc(db, 'reservation_inbox_ingest_v1', [j(bad)])).status, 'invalid_input', JSON.stringify(bad).slice(0, 60));
    }
    assert.equal((await rows(db, 'select count(*)::int n from reservation_private.inbox'))[0].n, 0);
  } finally { await db.close(); }
});

test('privileges: private tables closed to every API role; RPCs executable by service_role only', async () => {
  const db = await fixture();
  try {
    for (const role of ['anon', 'authenticated', 'service_role']) {
      for (const table of ['inbox', 'reservations', 'reservation_events', 'reservation_table_links']) {
        await assert.rejects(asRole(db, role, `select * from reservation_private.${table}`), /permission denied/, `${role} ${table}`);
      }
      await assert.rejects(asRole(db, role, "select reservation_private.business_date(now())"), /permission denied/);
    }
    for (const role of ['anon', 'authenticated']) {
      await assert.rejects(asRole(db, role, "select public.reservation_inbox_ingest_v1('{}'::jsonb)"), /permission denied/);
      await assert.rejects(asRole(db, role, 'select public.reservation_list_v1(1, current_date, current_date, null)'), /permission denied/);
    }
    assert.equal((await rpc(db, 'reservation_list_v1', [U.owner, '2026-11-14', '2026-11-14', null])).status, 'ok');
    const rls = await rows(db, "select relname, relrowsecurity from pg_class where relnamespace='reservation_private'::regnamespace and relkind='r' order by 1");
    assert.ok(rls.length === 4 && rls.every(r => r.relrowsecurity), 'RLS enabled on all four tables');
    const definers = await rows(db, "select proname from pg_proc where pronamespace='public'::regnamespace and proname like 'reservation\\_%' and not prosecdef");
    assert.deepEqual(definers, [], 'every public reservation RPC is security definer');
  } finally { await db.close(); }
});

test('staff roles: view vs manage vs purge; inactive or login-disabled staff are refused', async () => {
  const db = await fixture();
  try {
    const input = { customerName: 'Nguyen Van A', customerContact: CONTACT, partySize: 4, reservedAt: '2026-11-15T19:00:00+07:00' };
    for (const actor of [U.staff, U.inactive, U.noLogin, U.unknown]) {
      assert.equal((await rpc(db, 'reservation_create_v1', [actor, j(input)])).status, 'forbidden', `create ${actor}`);
      assert.equal((await rpc(db, 'reservation_inbox_list_v1', [actor, null, '2026-11-01', '2026-11-30', 100])).status, 'forbidden');
    }
    const created = await rpc(db, 'reservation_create_v1', [U.leader, j(input)]);
    assert.equal(created.status, 'ok');
    assert.equal(created.reservation.customerContact, CONTACT, 'the creator sees what was saved');
    const id = created.reservation.id;

    const staffList = await rpc(db, 'reservation_list_v1', [U.staff, '2026-11-15', '2026-11-15', null]);
    assert.equal(staffList.status, 'ok');
    assert.equal(staffList.items[0].customerContact, '***567');
    assert.equal(staffList.items[0].contactMasked, true);
    assert.equal((await rpc(db, 'reservation_get_v1', [U.staff, id, true])).status, 'forbidden', 'staff cannot reveal');
    assert.equal((await rpc(db, 'reservation_get_v1', [U.staff, id, false])).reservation.customerContact, '***567');
    for (const actor of [U.inactive, U.noLogin, U.unknown]) {
      assert.equal((await rpc(db, 'reservation_list_v1', [actor, '2026-11-15', '2026-11-15', null])).status, 'forbidden');
    }
    const managerList = await rpc(db, 'reservation_list_v1', [U.manager, '2026-11-15', '2026-11-15', null]);
    assert.equal(managerList.items[0].customerContact, '***567', 'lists always mask');

    const revealed = await rpc(db, 'reservation_get_v1', [U.manager, id, true]);
    assert.equal(revealed.reservation.customerContact, CONTACT);
    const viewed = await rows(db, "select actor_user_id::int a from reservation_private.reservation_events where event_type='contact_viewed'");
    assert.deepEqual(viewed, [{ a: U.manager }], 'each reveal is audited');

    for (const actor of [U.manager, U.leader, U.staff]) {
      assert.equal((await rpc(db, 'reservation_purge_expired_pii_v1', [actor, null, true])).status, 'forbidden');
    }
    for (const actor of [U.owner, U.master]) {
      assert.equal((await rpc(db, 'reservation_purge_expired_pii_v1', [actor, null, true])).status, 'ok');
    }
    assert.equal((await rpc(db, 'reservation_list_v1', [U.staff, '2026-11-01', '2027-03-01', null])).status, 'invalid_input', 'range capped');
  } finally { await db.close(); }
});

test('lifecycle: inbox -> pending -> confirmed -> arrived -> completed; no auto-confirm; history kept without PII', async () => {
  const db = await fixture();
  try {
    await post(db, event());
    await post(db, { hello: 'world' });
    const inboxList = await rpc(db, 'reservation_inbox_list_v1', [U.leader, arr(['received']), '2026-11-01', '2026-11-30', 50]);
    assert.equal(inboxList.items.length, 1);
    assert.equal(inboxList.items[0].messageText, TEXT, 'managers read the message to review it');
    assert.equal('rawPayload' in inboxList.items[0], false, 'lists do not carry raw payloads');
    assert.equal((await rows(db, 'select count(*)::int n from reservation_private.reservations'))[0].n, 0, 'webhook created no reservation');

    const input = { customerName: 'Nguyen Van A', customerContact: CONTACT, partySize: 4, reservedAt: '2026-11-15T19:00:00+07:00',
      sourceInboxId: inboxList.items[0].id, requestKey: '11111111-1111-4111-8111-111111111111', note: 'ban gan cua so' };
    const created = await rpc(db, 'reservation_create_v1', [U.leader, j(input)]);
    assert.deepEqual([created.status, created.reservation.status, created.reservation.version, created.duplicateRequest], ['ok', 'pending', 1, false]);
    const replay = await rpc(db, 'reservation_create_v1', [U.leader, j(input)]);
    assert.deepEqual([replay.duplicateRequest, replay.reservation.id], [true, created.reservation.id], 'double submit returns the same reservation');
    assert.equal((await rows(db, 'select status from reservation_private.inbox where id=$1', [input.sourceInboxId]))[0].status, 'linked');
    const quarantinedId = (await rows(db, "select id from reservation_private.inbox where status='quarantined'"))[0].id;
    assert.equal((await rpc(db, 'reservation_create_v1', [U.leader, j({ ...input, requestKey: null, sourceInboxId: quarantinedId })])).status, 'invalid_source');

    const id = created.reservation.id;
    assert.equal((await rpc(db, 'reservation_transition_v1', [U.leader, id, 1, 'arrived', null])).status, 'invalid_transition', 'pending cannot jump to arrived');
    assert.equal((await rpc(db, 'reservation_transition_v1', [U.leader, id, 9, 'confirmed', null])).status, 'version_conflict');
    const updated = await rpc(db, 'reservation_update_v1', [U.leader, id, 1, j({ partySize: 6, customerContact: '0988 000 111', note: 'doi ban' })]);
    assert.deepEqual([updated.status, updated.reservation.version, updated.reservation.partySize], ['ok', 2, 6]);
    assert.equal((await rpc(db, 'reservation_update_v1', [U.leader, id, 1, j({ partySize: 7 })])).status, 'version_conflict');
    assert.equal((await rpc(db, 'reservation_update_v1', [U.leader, id, 2, j({ partySize: 0 })])).status, 'invalid_input');
    assert.equal((await rpc(db, 'reservation_update_v1', [U.leader, id, 2, j({ reservedAt: '2026-11-15 19:00' })])).status, 'invalid_input', 'offset required');
    let v = 2;
    for (const to of ['confirmed', 'arrived', 'completed']) {
      const t = await rpc(db, 'reservation_transition_v1', [U.manager, id, v, to, null]);
      assert.equal(t.status, 'ok', to); v = t.reservation.version;
    }
    assert.equal((await rpc(db, 'reservation_transition_v1', [U.manager, id, v, 'cancelled', 'x'])).status, 'invalid_transition', 'completed is terminal');
    assert.equal((await rpc(db, 'reservation_update_v1', [U.manager, id, v, j({ partySize: 2 })])).status, 'invalid_transition');

    const detail = await rpc(db, 'reservation_get_v1', [U.staff, id, false]);
    assert.deepEqual(detail.events.map(e => [e.type, e.fromStatus, e.toStatus]), [
      ['reservation_created', null, 'pending'], ['reservation_updated', 'pending', 'pending'],
      ['status_changed', 'pending', 'confirmed'], ['status_changed', 'confirmed', 'arrived'], ['status_changed', 'arrived', 'completed']]);
    assert.deepEqual(detail.events[1].changes.fields, ['customerContact', 'note', 'partySize']);
    assert.deepEqual([detail.events[1].changes.before.partySize, detail.events[1].changes.after.partySize], [4, 6]);
    const allEvents = await rows(db, 'select * from reservation_private.reservation_events');
    assertNoPii(allEvents, 'reservation_events');
    assert.ok(!JSON.stringify(allEvents).includes('0988000111') && !JSON.stringify(allEvents).includes('doi ban'));

    const second = await rpc(db, 'reservation_create_v1', [U.leader, j({ customerName: 'B', partySize: 2, reservedAt: '2026-11-15T20:00:00+07:00' })]);
    assert.equal((await rpc(db, 'reservation_transition_v1', [U.leader, second.reservation.id, 1, 'cancelled', ' '])).status, 'reason_required');
    const cancelled = await rpc(db, 'reservation_transition_v1', [U.leader, second.reservation.id, 1, 'cancelled', 'khach huy']);
    assert.deepEqual([cancelled.status, cancelled.reservation.status, cancelled.reservation.cancelReason], ['ok', 'cancelled', 'khach huy']);

    await assert.rejects(db.query('update reservation_private.reservation_events set event_type=event_type'), /append-only/);
    await assert.rejects(db.query('delete from reservation_private.reservation_events'), /append-only/);
    await assert.rejects(db.query('truncate reservation_private.reservation_events'), /append-only/);
  } finally { await db.close(); }
});

test('planned table links: no overlapping plans per table, release on cancel, plan kept separate from occupancy', async () => {
  const db = await fixture();
  try {
    const make = async (at, dur = 120) => (await rpc(db, 'reservation_create_v1', [U.leader, j({ customerName: 'K', partySize: 2, reservedAt: at, durationMinutes: dur })])).reservation;
    const r1 = await make('2026-11-15T19:00:00+07:00');
    const r2 = await make('2026-11-15T20:00:00+07:00');
    const r3 = await make('2026-11-15T21:00:00+07:00');
    const l1 = await rpc(db, 'reservation_link_table_v1', [U.leader, r1.id, 1, ' a1 ']);
    assert.deepEqual([l1.status, l1.reservation.tables.map(t => t.tableCode), l1.reservation.version], ['ok', ['A1'], 2]);
    assert.equal((await rpc(db, 'reservation_link_table_v1', [U.leader, r1.id, 2, 'A1'])).unchanged, true);
    const clash = await rpc(db, 'reservation_link_table_v1', [U.leader, r2.id, 1, 'A1']);
    assert.deepEqual(clash, { status: 'table_conflict', conflictReservationId: r1.id });
    assert.equal((await rpc(db, 'reservation_link_table_v1', [U.leader, r3.id, 1, 'A1'])).status, 'ok', '[19:00,21:00) and [21:00,23:00) touch, not overlap');
    assert.equal((await rpc(db, 'reservation_link_table_v1', [U.leader, r2.id, 1, 'B2'])).status, 'ok');
    assert.equal((await rpc(db, 'reservation_link_table_v1', [U.leader, r2.id, 2, 'bad code!'])).status, 'invalid_input');
    assert.equal((await rpc(db, 'reservation_link_table_v1', [U.staff, r2.id, 2, 'C3'])).status, 'forbidden');

    // Moving r1 later would overlap r3 on A1: refused, nothing changed.
    const moved = await rpc(db, 'reservation_update_v1', [U.leader, r1.id, 2, j({ reservedAt: '2026-11-15T20:00:00+07:00' })]);
    assert.equal(moved.status, 'table_conflict');
    assert.equal((await rpc(db, 'reservation_get_v1', [U.leader, r1.id, false])).reservation.reservedAt, '2026-11-15T12:00:00+00:00');
    // Shortening r1 keeps A1 and moves its planned window with it.
    assert.equal((await rpc(db, 'reservation_update_v1', [U.leader, r1.id, 2, j({ durationMinutes: 60 })])).status, 'ok');
    assert.equal((await rows(db, "select upper(planned_range) u from reservation_private.reservation_table_links where reservation_id=$1", [r1.id]))[0].u.toISOString(), '2026-11-15T13:00:00.000Z');

    const c = await rpc(db, 'reservation_transition_v1', [U.leader, r3.id, 2, 'cancelled', 'khach huy']);
    assert.deepEqual(c.reservation.tables, [], 'cancel releases planned tables');
    assert.equal((await rpc(db, 'reservation_get_v1', [U.leader, r3.id, false])).tableHistory[0].releaseReason, 'status:cancelled');
    const r4 = await make('2026-11-15T21:30:00+07:00');
    assert.equal((await rpc(db, 'reservation_link_table_v1', [U.leader, r4.id, 1, 'A1'])).status, 'ok', 'released table can be planned again');

    // arrived keeps the plan (actual occupancy is not modeled here); manual release works with history.
    const conf = await rpc(db, 'reservation_transition_v1', [U.leader, r1.id, 3, 'confirmed', null]);
    const arrived = await rpc(db, 'reservation_transition_v1', [U.leader, r1.id, conf.reservation.version, 'arrived', null]);
    assert.deepEqual(arrived.reservation.tables.map(t => t.tableCode), ['A1']);
    const linkId = arrived.reservation.tables[0].linkId;
    const rel = await rpc(db, 'reservation_release_table_v1', [U.leader, r1.id, arrived.reservation.version, linkId, 'doi ban']);
    assert.deepEqual(rel.reservation.tables, []);
    const cols = await rows(db, "select column_name from information_schema.columns where table_schema='reservation_private' and table_name='reservation_table_links'");
    assert.ok(!cols.some(c => /occup|seated|pos_/i.test(c.column_name)), 'no occupancy columns in the planning table');
  } finally { await db.close(); }
});

test('business day: Asia/Ho_Chi_Minh with a 03:00 cutoff, identical to getBusinessDate()', async () => {
  const db = await fixture();
  try {
    const instants = ['2026-11-14T16:59:59Z', '2026-11-14T17:00:00Z', '2026-11-14T19:59:59Z', '2026-11-14T20:00:00Z',
      '2026-12-31T19:59:59Z', '2026-12-31T20:00:00Z', '2027-02-28T20:30:00Z'];
    await db.exec("set time zone 'America/New_York'"); // server session time zone must not matter
    for (const at of instants) {
      const [{ d }] = await rows(db, 'select reservation_private.business_date($1::timestamptz)::text d', [at]);
      assert.equal(d, getBusinessDate(new Date(at)), at);
    }
    const late = await rpc(db, 'reservation_create_v1', [U.leader, j({ customerName: 'L', partySize: 2, reservedAt: '2026-11-15T02:30:00+07:00' })]);
    const atThree = await rpc(db, 'reservation_create_v1', [U.leader, j({ customerName: 'T', partySize: 2, reservedAt: '2026-11-15T03:00:00+07:00' })]);
    assert.equal(late.reservation.businessDate, '2026-11-14', '02:30 belongs to the previous business day');
    assert.equal(atThree.reservation.businessDate, '2026-11-15');
    const day14 = await rpc(db, 'reservation_list_v1', [U.staff, '2026-11-14', '2026-11-14', null]);
    assert.deepEqual(day14.items.map(r => r.customerName), ['L']);
    for (const bad of ['2026-11-15T19:00:00', '2026-11-15', 'tomorrow 7pm', '2026-13-01T19:00:00+07:00']) {
      assert.equal((await rpc(db, 'reservation_create_v1', [U.leader, j({ customerName: 'X', partySize: 2, reservedAt: bad })])).status, 'invalid_input', bad);
    }
    // Inbox: 02:59 VN message → previous business date.
    await post(db, event({ message_id: 'late', date: Date.parse('2026-11-14T19:59:00Z') }));
    assert.equal((await rows(db, "select business_date::text d from reservation_private.inbox where message_id='late'"))[0].d, '2026-11-14');
  } finally { await db.close(); }
});

test('quarantine reprocess re-judges the stored payload; dismiss; never two live copies of one message', async () => {
  const db = await fixture();
  try {
    // A payload shape the parser did not know at receipt time (simulated by a nested wrapper).
    const unknownShape = { data: event({ message_id: 'msg-wrapped' }) };
    await post(db, unknownShape);
    const [q] = await rows(db, "select id, payload_sha256, raw_payload from reservation_private.inbox where status='quarantined'");
    const got = await rpc(db, 'reservation_inbox_get_v1', [U.leader, q.id]);
    assert.deepEqual(got.item.rawPayload, unknownShape);
    assert.equal((await rpc(db, 'reservation_inbox_get_v1', [U.staff, q.id])).status, 'forbidden');

    // Today's parser still cannot read it -> stays quarantined, attempt counted.
    const again = buildZaloInboxPlan(got.item.rawPayload, q.payload_sha256, [fingerprint(GROUP_ID)]);
    const still = await rpc(db, 'reservation_inbox_reprocess_v1', [U.leader, q.id, j(again.entry)]);
    assert.deepEqual([still.status, still.item.status, still.item.reprocessCount], ['ok', 'quarantined', 1]);
    // A fixed parser (simulated: unwrap .data) produces a valid entry for the SAME stored payload.
    const fixed = buildZaloInboxPlan(got.item.rawPayload.data, q.payload_sha256, [fingerprint(GROUP_ID)]).entry;
    assert.equal((await rpc(db, 'reservation_inbox_reprocess_v1', [U.leader, q.id, j({ ...fixed, payload_sha256: 'b'.repeat(64) })])).status, 'invalid_input', 'evidence hash must match');
    const ok = await rpc(db, 'reservation_inbox_reprocess_v1', [U.leader, q.id, j(fixed)]);
    assert.deepEqual([ok.status, ok.item.status, ok.item.groupFp], ['ok', 'received', fingerprint(GROUP_ID)]);
    // The real message arriving later (normal shape) is now a duplicate, not a second row.
    assert.equal((await (await post(db, event({ message_id: 'msg-wrapped' }))).json()).duplicate, true);

    // Reprocessing a quarantined copy of an already-received message dismisses it as duplicate.
    await post(db, event({ message_id: 'msg-3' }));
    await post(db, { data: event({ message_id: 'msg-3' }) });
    const [dupe] = await rows(db, "select id, payload_sha256, raw_payload from reservation_private.inbox where status='quarantined'");
    const dupEntry = buildZaloInboxPlan(dupe.raw_payload.data, dupe.payload_sha256, [fingerprint(GROUP_ID)]).entry;
    const d = await rpc(db, 'reservation_inbox_reprocess_v1', [U.leader, dupe.id, j(dupEntry)]);
    assert.equal(d.status, 'duplicate');
    assert.equal(d.item.status, 'dismissed');
    assert.equal((await rows(db, "select count(*)::int n from reservation_private.inbox where message_id='msg-3' and status in ('received','linked')"))[0].n, 1);

    await post(db, { hello: 'x' });
    const [junk] = await rows(db, "select id from reservation_private.inbox where status='quarantined'");
    assert.equal((await rpc(db, 'reservation_inbox_dismiss_v1', [U.staff, junk.id, 'spam'])).status, 'forbidden');
    const dis = await rpc(db, 'reservation_inbox_dismiss_v1', [U.leader, junk.id, 'spam']);
    assert.equal(dis.item.status, 'dismissed');
    assert.equal((await rpc(db, 'reservation_inbox_dismiss_v1', [U.leader, junk.id, 'again'])).status, 'invalid_transition');
  } finally { await db.close(); }
});

test('retention purge: dry run first, then personal data nulled; metadata and history kept', async () => {
  const db = await fixture();
  try {
    await post(db, event({ message_id: 'old' }));
    await post(db, event({ message_id: 'fresh' }));
    const r = await rpc(db, 'reservation_create_v1', [U.leader, j({ customerName: 'Nguyen Van A', customerContact: CONTACT, partySize: 2,
      reservedAt: '2025-09-01T19:00:00+07:00', sourceInboxId: 1 })]);
    await rpc(db, 'reservation_transition_v1', [U.leader, r.reservation.id, 1, 'cancelled', 'khach huy']);
    await db.exec("update reservation_private.inbox set received_at = now() - interval '100 days' where message_id='old'");

    const dry = await rpc(db, 'reservation_purge_expired_pii_v1', [U.owner, null, true]);
    assert.deepEqual([dry.dryRun, dry.inboxCount, dry.reservationCount], [true, 1, 1]);
    assert.equal((await rows(db, "select message_text from reservation_private.inbox where message_id='old'"))[0].message_text, TEXT, 'dry run changes nothing');
    const run = await rpc(db, 'reservation_purge_expired_pii_v1', [U.owner, null, false]);
    assert.deepEqual([run.inboxCount, run.reservationCount], [1, 1]);
    const [oldRow] = await rows(db, 'select * from reservation_private.inbox where id=1');
    assert.deepEqual([oldRow.message_text, oldRow.raw_payload, oldRow.sender_name, oldRow.chat_id, oldRow.status], [null, null, null, null, 'linked']);
    assert.equal(oldRow.group_fp, fingerprint(GROUP_ID), 'fingerprints kept');
    assert.equal((await rows(db, "select message_text from reservation_private.inbox where message_id='fresh'"))[0].message_text, TEXT);
    const res = await rpc(db, 'reservation_get_v1', [U.owner, r.reservation.id, true]);
    assert.deepEqual([res.reservation.customerName, res.reservation.customerContact, res.reservation.piiPurged, res.reservation.status], ['-', null, true, 'cancelled']);
    assert.ok(res.events.some(e => e.type === 'pii_purged'));
    assert.equal((await rpc(db, 'reservation_purge_expired_pii_v1', [U.owner, null, false])).inboxCount, 0, 'idempotent');
    assert.equal((await rpc(db, 'reservation_purge_expired_pii_v1', [U.owner, '2099-01-01T00:00:00Z', false])).status, 'invalid_input', 'cannot purge with a future clock');
  } finally { await db.close(); }
});

test('rollback script refuses while data exists, and removes every reservation object when empty', async () => {
  const rollback = readFileSync('supabase/reservation_inbox_foundation_rollback.sql', 'utf8');
  const db = await fixture();
  try {
    await post(db, event());
    await assert.rejects(db.exec(rollback), /reservation data exists/);
    await db.exec('rollback'); // the guard aborts the script's transaction, as a psql session would see
    assert.equal((await rows(db, "select count(*)::int n from pg_namespace where nspname='reservation_private'"))[0].n, 1, 'nothing dropped');
  } finally { await db.close(); }
  const empty = await fixture();
  try {
    await empty.exec(rollback);
    assert.equal((await rows(empty, "select count(*)::int n from pg_namespace where nspname='reservation_private'"))[0].n, 0);
    assert.equal((await rows(empty, "select count(*)::int n from pg_proc where proname like 'reservation\\_%'"))[0].n, 0);
    assert.equal((await rows(empty, 'select count(*)::int n from public.users'))[0].n, 7, 'existing tables untouched');
    await empty.exec(migration); // re-applicable after rollback
  } finally { await empty.close(); }
});

test('migration touches no existing table or function', () => {
  const body = migration.replace(/--.*$/gm, '');
  assert.doesNotMatch(body, /(?:alter|drop|truncate|update|insert into|delete from)\s+(?:table\s+)?public\.(?!reservation_)/i);
  assert.doesNotMatch(body, /create or replace function/i, 'only new functions');
  const created = [...body.matchAll(/create function (public\.\w+)/g)].map(m => m[1]);
  assert.ok(created.length > 0 && created.every(n => n.startsWith('public.reservation_')), created.join(','));
});
