import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BABA_TABLES } from '../lib/sales/baba-table-catalog.ts';
import { getBusinessDate } from '../lib/common/business-time.ts';
import { fixture, original, hardening, rpc, json, create, input, ingest, queryRows as rows } from './helpers/reservation-hardening-fixture.mjs';

const TABLE = BABA_TABLES[0].MapObjectID;
const OTHER = BABA_TABLES[1].MapObjectID;

test('all five live roles may confirm; Staff gains no other write, inbox, purge or contact privilege', async () => {
  const db = await fixture();
  try {
    for (const actor of [1,2,3,4,5,6,7,8,999]) {
      const r = await create(db);
      const result = await rpc(db, 'reservation_transition_v1', [actor, r.id, 1, 'confirmed', null]);
      assert.equal(result.status, actor <= 5 ? 'ok' : 'forbidden');
      if (actor <= 5) assert.equal(result.reservation.confirmedBy, actor);
    }
    const r = await create(db);
    const link = await rpc(db, 'reservation_link_table_v1', [4, r.id, 1, TABLE]);
    const v = link.reservation.version;
    assert.equal((await rpc(db, 'reservation_create_v1', [5, json(input())])).status, 'forbidden');
    assert.equal((await rpc(db, 'reservation_update_v1', [5, r.id, v, json({ partySize: 9 })])).status, 'forbidden');
    assert.equal((await rpc(db, 'reservation_link_table_v1', [5, r.id, v, OTHER])).status, 'forbidden');
    assert.equal((await rpc(db, 'reservation_release_table_v1', [5, r.id, v, link.reservation.tables[0].linkId, null])).status, 'forbidden');
    assert.equal((await rpc(db, 'reservation_get_v1', [5, r.id, true])).status, 'forbidden');
    assert.equal((await rpc(db, 'reservation_inbox_list_v1', [5, null, '2026-11-01', '2026-11-30', 100])).status, 'forbidden');
    assert.equal((await rpc(db, 'reservation_purge_expired_pii_v1', [5, null, false])).status, 'forbidden');
    const confirmed = await rpc(db, 'reservation_transition_v1', [5, r.id, v, 'confirmed', null]);
    for (const to of ['pending','arrived','completed','cancelled','no_show']) {
      assert.equal((await rpc(db, 'reservation_transition_v1', [5, r.id, confirmed.reservation.version, to, 'synthetic'])).status, 'forbidden');
    }
    await db.exec('update public.users set app_login_enabled = false where id = 5');
    const next = await create(db);
    assert.equal((await rpc(db, 'reservation_transition_v1', [5, next.id, 1, 'confirmed', null])).status, 'forbidden');
  } finally { await db.close(); }
});

test('every versioned RPC rejects NULL, invalid and stale versions without writes; invalid inputs cannot partially change state', async () => {
  const db = await fixture();
  try {
    const r = await create(db);
    const linked = await rpc(db, 'reservation_link_table_v1', [4, r.id, 1, TABLE]);
    const linkId = linked.reservation.tables[0].linkId;
    for (const version of [null, 0, -1, 2147483647, 1, 900]) {
      const expected = version === null || version <= 0 || version === 2147483647 ? 'invalid_input' : 'version_conflict';
      for (const [name, extra] of [ ['reservation_update_v1', [json({partySize:9})]],
        ['reservation_transition_v1',['confirmed',null]], ['reservation_link_table_v1',[OTHER]],
        ['reservation_release_table_v1',[linkId,null]] ]) {
        assert.equal((await rpc(db,name,[4,r.id,version,...extra])).status,expected,`${name} ${version}`);
      }
    }
    for (const [name,extra] of [['reservation_update_v1',[json({partySize:9})]],
      ['reservation_transition_v1',['confirmed',null]],['reservation_link_table_v1',[OTHER]],
      ['reservation_release_table_v1',[linkId,null]]]) {
      for (const bad of ['bad', 1.5, '2147483648']) await assert.rejects(rpc(db,name,[4,r.id,bad,...extra]));
      await assert.rejects(rpc(db,name,[4,r.id]), /does not exist/);
    }
    assert.equal((await rpc(db, 'reservation_update_v1', [4,r.id,2,json({ customerName: null })])).status,'invalid_input');
    const detail = await rpc(db,'reservation_get_v1',[4,r.id,false]);
    assert.equal(detail.reservation.version,2);
    assert.equal(detail.reservation.partySize,4);
    assert.deepEqual(detail.events.map(e=>e.type),['reservation_created','table_linked']);
  } finally { await db.close(); }
});

test('Staff list/detail/confirmation contain only operational data, including arbitrary names, notes, cancellation and release reasons', async () => {
  const db = await fixture();
  try {
    const secret = 'SYNTHETIC-UNSTRUCTURED-PRIVATE-CONTENT';
    const r = await create(db,{ customerName: secret, customerContact: secret, note: secret });
    const l = await rpc(db,'reservation_link_table_v1',[4,r.id,1,TABLE]);
    await rpc(db,'reservation_release_table_v1',[4,r.id,2,l.reservation.tables[0].linkId,secret]);
    const confirm = await rpc(db,'reservation_transition_v1',[5,r.id,3,'confirmed',secret]);
    assert.ok(!JSON.stringify(confirm).includes(secret));
    await rpc(db,'reservation_transition_v1',[4,r.id,4,'cancelled',secret]);
    const list = await rpc(db,'reservation_list_v1',[5,'2026-11-15','2026-11-15',null]);
    const detail = await rpc(db,'reservation_get_v1',[5,r.id,false]);
    for(const response of [list, detail]) assert.ok(!JSON.stringify(response).includes(secret));
    for(const key of ['customerName','customerContact','contactMasked','note','cancelReason','sourceInboxId']) {
      assert.ok(!(key in list.items[0]), key);
      assert.ok(!(key in detail.reservation), key);
    }
    assert.equal(list.items[0].partySize,4);
    assert.equal(list.items[0].confirmedBy,5);
    assert.ok(detail.events.every(e=>Object.keys(e.changes).length===0));
    assert.ok(!(JSON.stringify(await rows(db,'select * from reservation_private.reservation_events')).includes(secret)), 'append-only history never receives raw reasons');
    assert.equal((await rpc(db,'reservation_get_v1',[4,r.id,true])).reservation.customerContact,secret, 'manage policy unchanged');
  } finally { await db.close(); }
});

test('PII purge removes all free text, keeps immutable structured history, is dry-run/idempotent and blocks reintroducing notes', async () => {
  const db = await fixture();
  try {
    const secret = 'SYNTHETIC-PII-ANY-FORMAT';
    const msg = await ingest(db,{ sender_name: secret, sender_id: secret, message_text: secret, raw_payload: {nested:secret} });
    const r = await create(db,{ sourceInboxId:msg.inboxId, customerName:secret, customerContact:secret, note:secret, reservedAt:'2020-01-01T19:00:00+07:00' });
    const l=await rpc(db,'reservation_link_table_v1',[4,r.id,1,TABLE]);
    await rpc(db,'reservation_release_table_v1',[4,r.id,2,l.reservation.tables[0].linkId,secret]);
    await rpc(db,'reservation_transition_v1',[4,r.id,3,'cancelled',secret]);
    const junk=await ingest(db,{ status:'quarantined', quarantine_reason:'unknown_event_shape', chat_id:null, message_id:null, payload_sha256:'b'.repeat(64), message_text:secret });
    await rpc(db,'reservation_inbox_dismiss_v1',[4,junk.inboxId,secret]);
    await db.exec("update reservation_private.inbox set received_at=now()-interval '200 days'");
    const before=await rows(db,'select * from reservation_private.reservation_events');
    assert.equal((await rpc(db,'reservation_purge_expired_pii_v1',[1,null,null])).dryRun,true);
    assert.ok(JSON.stringify(await rows(db,'select * from reservation_private.reservations')).includes(secret));
    assert.equal((await rpc(db,'reservation_purge_expired_pii_v1',[1,null,false])).reservationCount,1);
    for(const table of ['inbox','reservations','reservation_table_links','reservation_events']) {
      assert.ok(!JSON.stringify(await rows(db,`select * from reservation_private.${table}`)).includes(secret),table);
    }
    const after=await rows(db,'select * from reservation_private.reservation_events order by id');
    assert.deepEqual(after.slice(0,before.length),before);
    assert.equal((await rpc(db,'reservation_purge_expired_pii_v1',[1,null,false])).reservationCount,0);
    const purged=await ingest(db,{ status:'quarantined', quarantine_reason:'unknown_event_shape', chat_id:null, message_id:null, payload_sha256:'c'.repeat(64) });
    await db.exec("update reservation_private.inbox set received_at=now()-interval '200 days' where id="+purged.inboxId);
    await rpc(db,'reservation_purge_expired_pii_v1',[1,null,false]);
    assert.equal((await rpc(db,'reservation_inbox_dismiss_v1',[4,purged.inboxId,secret])).status,'invalid_transition');
    assert.equal((await rpc(db,'reservation_create_v1',[4,json(input({sourceInboxId:purged.inboxId}))])).status,'invalid_source');
    await assert.rejects(db.exec('update reservation_private.reservation_events set changes=changes'), /append-only/);
  } finally { await db.close(); }
});

test('DB catalog matches all 27 actual UUIDs; arbitrary table codes/UUIDs rejected; planned overlap and rollback retained', async () => {
  const db = await fixture();
  try {
    assert.deepEqual(await rows(db,'select id::text, display_name from reservation_private.table_catalog order by id'),
      BABA_TABLES.map(t=>({id:t.MapObjectID,display_name:t.MapObjectName})).sort((a,b)=>a.id.localeCompare(b.id)));
    const r=await create(db);
    for(const t of BABA_TABLES) {
      const current=(await rpc(db,'reservation_get_v1',[4,r.id,false])).reservation;
      assert.equal((await rpc(db,'reservation_link_table_v1',[4,r.id,current.version,t.MapObjectID])).status,'ok');
    }
    assert.equal((await rpc(db,'reservation_link_table_v1',[4,r.id,28,'00000000-0000-0000-0000-000000000000'])).status,'invalid_input');
    await assert.rejects(rpc(db,'reservation_link_table_v1',[4,r.id,28,'BAR1']), /uuid/);
    assert.equal((await rows(db,"select to_regprocedure('public.reservation_link_table_v1(bigint,bigint,integer,text)') f"))[0].f,null);
    const overlap=await create(db,{reservedAt:'2026-11-15T20:00:00+07:00',durationMinutes:60});
    assert.equal((await rpc(db,'reservation_link_table_v1',[4,overlap.id,1,TABLE])).status,'table_conflict');
    const touching=await create(db,{reservedAt:'2026-11-15T21:00:00+07:00'});
    assert.equal((await rpc(db,'reservation_link_table_v1',[4,touching.id,1,TABLE])).status,'ok');
    assert.equal((await rpc(db,'reservation_update_v1',[4,r.id,28,json({reservedAt:'2026-11-15T20:00:00+07:00'})])).status,'table_conflict');
    assert.equal((await rpc(db,'reservation_get_v1',[4,r.id,false])).reservation.version,28);
    assert.equal((await rpc(db,'reservation_get_v1',[4,r.id,false])).reservation.reservedAt,'2026-11-15T12:00:00+00:00');
    await rpc(db,'reservation_transition_v1',[4,r.id,28,'cancelled','synthetic']);
    assert.equal((await rpc(db,'reservation_link_table_v1',[4,overlap.id,1,TABLE])).status,'ok');
  } finally { await db.close(); }
});

test('confirmation metadata survives edits, table changes and reversal; reconfirmation retains both historical actors/times', async () => {
  const db = await fixture();
  try {
    const r=await create(db);
    const a=(await rpc(db,'reservation_transition_v1',[5,r.id,1,'confirmed',null])).reservation;
    const edit=(await rpc(db,'reservation_update_v1',[4,r.id,2,json({partySize:8})])).reservation;
    assert.equal(edit.confirmedBy,5); assert.equal(edit.confirmedAt,a.confirmedAt);
    const back=(await rpc(db,'reservation_transition_v1',[4,r.id,3,'pending',null])).reservation;
    assert.equal(back.confirmedAt,a.confirmedAt);
    const b=(await rpc(db,'reservation_transition_v1',[2,r.id,4,'confirmed',null])).reservation;
    assert.equal(b.confirmedBy,2); assert.ok(Date.parse(b.confirmedAt)>=Date.parse(a.confirmedAt));
    const events=(await rpc(db,'reservation_get_v1',[5,r.id,false])).events.filter(e=>e.type==='status_changed' && e.toStatus==='confirmed');
    assert.deepEqual(events.map(e=>e.actorUserId),[5,2]);
    assert.ok(events.every(e=>e.createdAt));
    const linked=(await rpc(db,'reservation_link_table_v1',[4,r.id,5,TABLE])).reservation;
    assert.equal(linked.confirmedAt,b.confirmedAt);
    assert.equal((await rpc(db,'reservation_list_v1',[5,'2026-11-15','2026-11-15',null])).items[0].confirmedBy,2);
    const exact=(await rpc(db,'reservation_get_v1',[4,r.id,false])).events.filter(e=>e.type==='status_changed' && e.toStatus==='confirmed');
    assert.deepEqual(exact.map(e=>e.changes.confirmedAt),[a.confirmedAt,b.confirmedAt]);
  } finally { await db.close(); }
});

test('one reservation per Inbox: same key is idempotent, different or missing key cannot duplicate even after cancellation', async () => {
  const db = await fixture();
  try {
    const msg=await ingest(db);
    const p=input({sourceInboxId:msg.inboxId,requestKey:'11111111-1111-4111-8111-111111111111'});
    const first=await rpc(db,'reservation_create_v1',[4,json(p)]);
    assert.equal((await rpc(db,'reservation_create_v1',[4,json(p)])).duplicateRequest,true);
    for(const requestKey of ['22222222-2222-4222-8222-222222222222',null]) {
      assert.equal((await rpc(db,'reservation_create_v1',[4,json({...p,requestKey})])).status,'source_conflict');
    }
    await rpc(db,'reservation_transition_v1',[4,first.reservation.id,1,'cancelled','synthetic']);
    assert.equal((await rpc(db,'reservation_create_v1',[4,json({...p,requestKey:null})])).status,'source_conflict');
    assert.equal((await rows(db,'select count(*)::int n from reservation_private.reservations'))[0].n,1);
  } finally { await db.close(); }
});

test('hardening preserves closed RLS/RPC privileges; migration aborts atomically with existing data', async () => {
  const db = await fixture();
  try {
    for(const role of ['anon','authenticated','service_role']) {
      await db.exec(`set role ${role}`);
      try {
        for(const table of ['table_catalog','reservations','inbox','reservation_events','reservation_table_links']) {
          await assert.rejects(db.exec(`select * from reservation_private.${table}`),/permission denied/);
        }
        if(role!=='service_role') await assert.rejects(db.exec(`select public.reservation_link_table_v1(4,1,1,'${TABLE}')`),/permission denied/);
      } finally { await db.exec('reset role'); }
    }
    assert.equal((await rows(db,"select count(*)::int n from pg_class where relnamespace='reservation_private'::regnamespace and relkind='r' and relrowsecurity"))[0].n,5);
  } finally { await db.close(); }
  const existing=await fixture(false);
  try {
    await ingest(existing);
    await assert.rejects(existing.exec(hardening),/reservation_phase1_data_requires_owner_review/);
    await existing.exec('rollback');
    assert.equal((await rows(existing,'select count(*)::int n from reservation_private.inbox'))[0].n,1);
    assert.equal((await rows(existing,"select to_regclass('reservation_private.table_catalog') f"))[0].f,null);
    assert.equal((await rows(existing,"select count(*)::int n from public.users"))[0].n,8);
    assert.ok(original.includes('create function public.reservation_link_table_v1'));
  } finally { await existing.close(); }
});

test('final migration uses VN 03:00 regardless of session zone; purge rejects any future time', async () => {
  const db=await fixture();
  try {
    await db.exec("set time zone 'America/New_York'");
    for(const at of ['2026-11-14T02:59:59+07:00','2026-11-14T03:00:00+07:00','2027-01-01T02:30:00+07:00']) {
      const r=await create(db,{reservedAt:at});
      assert.equal(r.businessDate,getBusinessDate(new Date(at)));
    }
    assert.equal((await rpc(db,'reservation_purge_expired_pii_v1',[1,new Date(Date.now()+3600000).toISOString(),false])).status,'invalid_input');
  } finally { await db.close(); }
});

test('manual rollback supports either schema version, refuses real data, and clean re-creation applies both formal files', async () => {
  const rollback=readFileSync('supabase/reservation_inbox_foundation_rollback.sql','utf8');
  const empty=await fixture();
  try {
    await empty.exec(rollback);
    assert.equal((await rows(empty,"select to_regnamespace('reservation_private') s"))[0].s,null);
    await empty.exec(original);await empty.exec(hardening);
    assert.equal((await rows(empty,'select count(*)::int n from reservation_private.table_catalog'))[0].n,27);
    await ingest(empty);
    await assert.rejects(empty.exec(rollback), /reservation data exists/);
    await empty.exec('rollback');
    assert.equal((await rows(empty,'select count(*)::int n from reservation_private.inbox'))[0].n,1);
  } finally { await empty.close(); }
});
