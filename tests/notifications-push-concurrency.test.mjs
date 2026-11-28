// BABA-NOTIFICATION-01B on real PostgreSQL with independent connections (throwaway local cluster).
// Covers: endpoint ownership races (newer session wins), logout racing a registration, single
// enqueue, disjoint parallel claims, a slow live claim never re-claimed within its lease, and
// several server instances running recovery at once (one scan, an idle queue writes nothing).
import test from 'node:test';
import assert from 'node:assert/strict';
import { U, payload } from './helpers/notification-fixture.mjs';
import { startPushCluster, rpc } from './helpers/push-native-pg.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const KEY = 'B' + 'A'.repeat(86), AUTH = 'C'.repeat(22), DEV = 'D'.repeat(43), DEV2 = 'E'.repeat(43);
const ep = n => `https://fcm.googleapis.com/fcm/send/race-${n}`;
const exp = () => new Date(Date.now() + 20 * 86400000).toISOString();
const subscribe = (c, user, iat, endpoint, device = DEV) => rpc(c, 'notification_push_subscribe_v1', [user, iat, exp(), endpoint, KEY, AUTH, 'ko', null, device]);

test('real PostgreSQL push concurrency', { timeout: 120000 }, async t => {
  const cluster = await startPushCluster('pg-conc');
  const { admin } = cluster;
  try {
    await admin.query(`update notification_private.policies set push_enabled = true where type_code = 'system.test_all'`);
    t.diagnostic((await admin.query('select version() v')).rows[0].v);
    const pool = []; for (let i = 0; i < 6; i++) pool.push(await cluster.connect());
    const ungate = () => admin.query("update notification_private.push_runtime set recovery_started_at = '-infinity'");
    const active = async endpoint => (await admin.query("select user_id::int u, session_iat::bigint iat from notification_private.push_subscriptions where endpoint=$1 and status='active'", [endpoint])).rows;

    await t.test('30 racing registrations of one endpoint: exactly one active owner, always the newest session', async () => {
      const users = [U.owner, U.master, U.managerHall, U.leaderBar, U.staffBar, U.staffHall];
      const results = await Promise.all(Array.from({ length: 30 }, (_, i) => subscribe(pool[i % pool.length], users[i % users.length], 1790000000 + i, ep('shared'))));
      assert.ok(results.every(r => ['ok', 'superseded'].includes(r.status)), JSON.stringify(results));
      const rows = await active(ep('shared'));
      assert.equal(rows.length, 1); assert.equal(Number(rows[0].iat), 1790000029);
    });

    await t.test('account switch A -> B racing on 40 endpoints: B (newer session) always ends as the owner', async () => {
      for (let i = 0; i < 40; i++) {
        const [a, b] = await Promise.all([subscribe(pool[i % 6], U.staffBar, 1790001000 + i, ep(`ab-${i}`)), subscribe(pool[(i + 1) % 6], U.staffHall, 1790001001 + i, ep(`ab-${i}`))]);
        assert.equal(b.status, 'ok'); assert.ok(['ok', 'superseded'].includes(a.status));
        const late = await rpc(pool[(i + 2) % 6], 'notification_push_sync_v1', [U.staffBar, 1790001000 + i, exp(), ep(`ab-${i}`), 'ko', DEV]);
        assert.equal(late.device, 'superseded', 'late sync of A never revokes B');
        assert.deepEqual((await active(ep(`ab-${i}`))).map(r => r.u), [U.staffHall]);
      }
    });

    await t.test('logout racing a registration of the same session (40 trials): never an active row afterwards', async () => {
      for (let i = 0; i < 40; i++) {
        const iat = 1790002000 + i;
        const [sub, out] = await Promise.all([
          subscribe(pool[i % 6], U.leaderBar, iat, ep(`lo-${i}`)),
          rpc(pool[(i + 3) % 6], 'notification_push_session_revoke_v1', [U.leaderBar, iat, i % 2 ? DEV : null]),
        ]);
        assert.equal(out.status, 'ok');
        assert.ok(['ok', 'session_revoked'].includes(sub.status), sub.status);
        assert.equal((await active(ep(`lo-${i}`))).length, 0, `trial ${i}: ${sub.status}`);
        // A late retry of that registration is refused.
        assert.equal((await subscribe(pool[(i + 1) % 6], U.leaderBar, iat, ep(`lo-${i}`))).status, 'session_revoked');
      }
      // Another device of the same user and session second survives a per-device logout.
      await subscribe(admin, U.master, 1790003000, ep('dev-a'), DEV);
      await subscribe(admin, U.master, 1790003000, ep('dev-b'), DEV2);
      await rpc(admin, 'notification_push_session_revoke_v1', [U.master, 1790003000, DEV]);
      assert.deepEqual([(await active(ep('dev-a'))).length, (await active(ep('dev-b'))).length], [0, 1]);
    });

    await t.test('60 parallel first observations enqueue each device exactly once', async () => {
      for (let i = 0; i < 8; i++) await subscribe(admin, U.staffBar, 1790004000, ep(`bar-${i}`));
      const results = await Promise.all(Array.from({ length: 60 }, (_, i) => rpc(pool[i % 6], 'notification_upsert_v1',
        ['system.test_all', 'race:push', JSON.stringify(payload())])));
      const created = results.filter(r => r.status === 'created');
      assert.equal(created.length, 1);
      const n = (await admin.query('select count(*)::int n, count(distinct subscription_id)::int d from notification_private.push_deliveries where notification_id=$1', [created[0].id])).rows[0];
      assert.equal(n.n, n.d); assert.ok(n.n >= 9);
      t.diagnostic(`deliveries for the race event: ${n.n}`);
      await admin.query('select set_config($1, $2, false)', ['baba.race_event', String(created[0].id)]);
    });

    await t.test('parallel senders: disjoint claims; a slow live claim (send + report delay) is never re-claimed within the lease', async () => {
      const event = Number((await admin.query("select id from notification_private.notifications where dedupe_key='race:push'")).rows[0].id);
      const [{ n: total }] = (await admin.query('select count(*)::int n from notification_private.push_deliveries where notification_id=$1 and status=$2', [event, 'pending'])).rows;
      // 6 senders claim small batches of the same event at once.
      const claims = await Promise.all(pool.map(c => rpc(c, 'notification_push_claim_v1', [event, 2, 90])));
      const ids = claims.flatMap(r => r.items.map(i => i.deliveryId));
      assert.equal(new Set(ids).size, ids.length, 'no row claimed twice');
      assert.equal(ids.length, Math.min(total, 12));
      // Slow sender: holds its claims for 2.5 s while other instances keep running recovery.
      const slow = claims.flatMap(r => r.items);
      const stop = Date.now() + 2500; let reclaimed = 0; let recoveryRuns = 0;
      while (Date.now() < stop) {
        await ungate();
        const r = await rpc(pool[recoveryRuns % 6], 'notification_push_claim_v1', [null, 20, 90]);
        recoveryRuns++;
        reclaimed += r.items.filter(i => slow.some(s => s.deliveryId === i.deliveryId)).length;
        await delay(100);
      }
      assert.equal(reclaimed, 0, `live claims never re-claimed (${recoveryRuns} recovery runs)`);
      const reports = await Promise.all(slow.map((item, i) => rpc(pool[i % 6], 'notification_push_report_v1', [item.deliveryId, item.claimToken, 'accepted', 201, null, null])));
      assert.ok(reports.every(r => r.status === 'ok'), 'the slow sender still owns its claims');
      // Two reports with one token race: one wins, the other is stale.
      await admin.query("update notification_private.push_deliveries set status='pending', next_attempt_at=now(), claim_token=null, claimed_at=null where status in ('pending','sending')");
      const one = (await rpc(admin, 'notification_push_claim_v1', [event, 1, 90])).items[0];
      if (one) {
        const r2 = await Promise.all([pool[0], pool[1]].map(c => rpc(c, 'notification_push_report_v1', [one.deliveryId, one.claimToken, 'accepted', 201, null, null])));
        assert.deepEqual(r2.map(r => r.status).sort(), ['ok', 'stale']);
      }
    });

    await t.test('6 server instances run recovery at once: one scan; idle queue = no write', async () => {
      await admin.query("update notification_private.push_deliveries set status='pending', next_attempt_at=now(), claim_token=null, claimed_at=null where status in ('pending','sending')");
      await ungate();
      const burst = await Promise.all(Array.from({ length: 12 }, (_, i) => rpc(pool[i % 6], 'notification_push_claim_v1', [null, 5, 90])));
      const scanned = burst.filter(r => r.items.length || r.skipped);
      assert.equal(scanned.length, 1, 'exactly one instance passed the gate');
      assert.ok(burst.filter(r => r !== scanned[0]).every(r => r.throttled === true || r.idle === true));
      // Drain everything, then an idle burst writes nothing.
      await admin.query("update notification_private.push_deliveries set status='accepted', claim_token=null, claimed_at=null, finished_at=now() where status in ('pending','sending')");
      const before = (await admin.query('select xmin::text x, recovery_started_at::text t from notification_private.push_runtime')).rows[0];
      const idle = await Promise.all(Array.from({ length: 12 }, (_, i) => rpc(pool[i % 6], 'notification_push_claim_v1', [null, 5, 90])));
      assert.ok(idle.every(r => r.idle === true && r.items.length === 0));
      assert.deepEqual((await admin.query('select xmin::text x, recovery_started_at::text t from notification_private.push_runtime')).rows[0], before);
    });
  } finally {
    await cluster.stop();
  }
});
