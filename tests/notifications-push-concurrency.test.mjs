// BABA-NOTIFICATION-01B on real PostgreSQL with independent connections (throwaway local cluster).
// Covers: same-browser account switches racing in the SAME session second (the browser generation
// orders them, not the clock), a revoked row never restored by an older request, same-user re-login
// vs the old session's unsubscribe, logout racing a registration, single enqueue, disjoint parallel
// claims, a slow live claim never re-claimed within its lease, and several server instances running
// recovery at once (one scan, an idle queue writes nothing).
import test from 'node:test';
import assert from 'node:assert/strict';
import { U, payload } from './helpers/notification-fixture.mjs';
import { startPushCluster, rpc } from './helpers/push-native-pg.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const KEY = 'B' + 'A'.repeat(86), AUTH = 'C'.repeat(22);
const ep = n => `https://fcm.googleapis.com/fcm/send/race-${n}`;
const exp = () => new Date(Date.now() + 20 * 86400000).toISOString();
// A browser = signed push device cookie identity; g grows with every login/logout in it.
const browser = (tag, issued = 1000) => ({ hash: (String(tag) + '_'.repeat(43)).slice(0, 43), issued });
const dev = (b, g) => [b.hash, g, (b.hash.slice(0, 12) + 'n' + g + '_'.repeat(22)).slice(0, 22), b.issued];
const SECOND = 1790000000; // every session below is issued in this same second
const subscribe = (c, user, endpoint, b, g, iat = SECOND) =>
  rpc(c, 'notification_push_subscribe_v1', [user, iat, exp(), endpoint, KEY, AUTH, 'ko', null, ...dev(b, g), 1]);
const sync = (c, user, endpoint, b, g, iat = SECOND) => rpc(c, 'notification_push_sync_v1', [user, iat, exp(), endpoint, 'ko', ...dev(b, g), 1]);
const unsubscribe = (c, user, endpoint, b, g, iat = SECOND) => rpc(c, 'notification_push_unsubscribe_v1', [user, iat, endpoint, ...dev(b, g)]);
const logout = (c, user, b, g, iat = SECOND) => rpc(c, 'notification_push_session_revoke_v1', [user, iat, ...(b ? dev(b, g) : [null, null, null, null]), b ? null : Date.now()]);

test('real PostgreSQL push concurrency', { timeout: 120000 }, async t => {
  const cluster = await startPushCluster('pg-conc');
  const { admin } = cluster;
  try {
    await admin.query(`update notification_private.policies set push_enabled = true where type_code = 'system.test_all'`);
    t.diagnostic((await admin.query('select version() v')).rows[0].v);
    const pool = []; for (let i = 0; i < 6; i++) pool.push(await cluster.connect());
    const ungate = () => admin.query("update notification_private.push_runtime set recovery_started_at = '-infinity'");
    const active = async endpoint => (await admin.query("select user_id::int u, device_generation::int g from notification_private.push_subscriptions where endpoint=$1 and status='active'", [endpoint])).rows;
    const users = [U.owner, U.master, U.managerHall, U.leaderBar, U.staffBar, U.staffHall];

    await t.test('30 logins of one browser in the same second race their registrations: the latest generation always owns it', async () => {
      const shared = browser('shared');
      const results = await Promise.all(Array.from({ length: 30 }, (_, i) => subscribe(pool[i % 6], users[i % 6], ep('shared'), shared, i + 1)));
      assert.ok(results.every(r => ['ok', 'superseded'].includes(r.status)), JSON.stringify(results));
      const rows = await active(ep('shared'));
      assert.equal(rows.length, 1); assert.deepEqual([rows[0].g, rows[0].u], [30, users[29 % 6]]);
    });

    await t.test('(1) same-second A -> B on 40 browsers, A and B in parallel, then A late: B always owns it', async () => {
      for (let i = 0; i < 40; i++) {
        const b = browser(`ab-${i}`);
        const [ra, rb] = await Promise.all([subscribe(pool[i % 6], U.staffBar, ep(`ab-${i}`), b, 1), subscribe(pool[(i + 1) % 6], U.staffHall, ep(`ab-${i}`), b, 2)]);
        assert.equal(rb.status, 'ok'); assert.ok(['ok', 'superseded'].includes(ra.status));
        const [late, lateSync] = await Promise.all([subscribe(pool[(i + 2) % 6], U.staffBar, ep(`ab-${i}`), b, 1), sync(pool[(i + 3) % 6], U.staffBar, ep(`ab-${i}`), b, 1)]);
        assert.deepEqual([late.status, lateSync.device], ['superseded', 'superseded']);
        assert.deepEqual((await active(ep(`ab-${i}`))).map(r => r.u), [U.staffHall]);
      }
    });

    await t.test('(2)(3) B revokes A by sync while A\'s old subscribe races it (40 trials): A is never active afterwards', async () => {
      for (let i = 0; i < 40; i++) {
        const b = browser(`rv-${i}`);
        await subscribe(admin, U.leaderBar, ep(`rv-${i}`), b, 1);
        const [s, late] = await Promise.all([sync(pool[i % 6], U.leaderHall, ep(`rv-${i}`), b, 2), subscribe(pool[(i + 1) % 6], U.leaderBar, ep(`rv-${i}`), b, 1)]);
        assert.ok(['foreign'].includes(s.device), s.device);
        assert.ok(['ok', 'superseded'].includes(late.status));
        assert.deepEqual((await active(ep(`rv-${i}`))).filter(r => r.u === U.leaderBar), [], `trial ${i}`);
        assert.equal((await subscribe(admin, U.leaderBar, ep(`rv-${i}`), b, 1)).status, 'superseded', 'history kept: no restore');
      }
    });

    await t.test('(4) same-user re-login registration vs the old session unsubscribe (40 trials): the new registration survives', async () => {
      for (let i = 0; i < 40; i++) {
        const b = browser(`rl-${i}`);
        await subscribe(admin, U.managerHall, ep(`rl-${i}`), b, 1);
        await Promise.all([subscribe(pool[i % 6], U.managerHall, ep(`rl-${i}`), b, 2, SECOND + 1), unsubscribe(pool[(i + 1) % 6], U.managerHall, ep(`rl-${i}`), b, 1)]);
        assert.deepEqual((await active(ep(`rl-${i}`))).map(r => r.g), [2], `trial ${i}`);
      }
    });

    await t.test('(5) logout racing a registration of the same browser (40 trials): never an active row afterwards', async () => {
      for (let i = 0; i < 40; i++) {
        const b = browser(`lo-${i}`); const withCookie = i % 2 === 1;
        const [sub, out] = await Promise.all([
          subscribe(pool[i % 6], U.leaderBar, ep(`lo-${i}`), b, 1, SECOND + 10 + i),
          logout(pool[(i + 3) % 6], U.leaderBar, withCookie ? b : null, 2, SECOND + 10 + i),
        ]);
        assert.equal(out.status, 'ok');
        assert.ok(['ok', 'superseded', 'session_revoked'].includes(sub.status), sub.status);
        assert.equal((await active(ep(`lo-${i}`))).length, 0, `trial ${i}: ${sub.status}`);
        assert.ok(['superseded', 'session_revoked'].includes((await subscribe(pool[(i + 1) % 6], U.leaderBar, ep(`lo-${i}`), b, 1, SECOND + 10 + i)).status));
      }
      // Same user, same second, another browser survives a per-browser logout.
      const a = browser('dev-a'), c = browser('dev-b');
      await subscribe(admin, U.master, ep('dev-a'), a, 1); await subscribe(admin, U.master, ep('dev-b'), c, 1);
      await logout(admin, U.master, a, 2);
      assert.deepEqual([(await active(ep('dev-a'))).length, (await active(ep('dev-b'))).length], [0, 1]);
    });

    await t.test("FINAL-3: A's delayed logout (g2) racing B's login registration (g3), 40 trials: B always survives", async () => {
      for (let i = 0; i < 40; i++) {
        const b = browser(`dl-${i}`);
        await subscribe(admin, U.staffBar, ep(`dl-${i}`), b, 1, SECOND + 200 + i);
        const [out, reg] = await Promise.all([
          logout(pool[i % 6], U.staffBar, b, 2, SECOND + 200 + i),
          subscribe(pool[(i + 1) % 6], U.staffHall, ep(`dl-${i}`), b, 3, SECOND + 200 + i),
        ]);
        assert.equal(out.status, 'ok'); assert.equal(reg.status, 'ok');
        assert.deepEqual((await active(ep(`dl-${i}`))).map(r => [r.u, r.g]), [[U.staffHall, 3]], `trial ${i}`);
        // A retry of the same delayed logout is still harmless.
        assert.equal((await logout(pool[(i + 2) % 6], U.staffBar, b, 2, SECOND + 200 + i)).revoked, 0);
        assert.deepEqual((await active(ep(`dl-${i}`))).map(r => r.u), [U.staffHall]);
      }
    });

    await t.test('60 parallel first observations enqueue each device exactly once', async () => {
      const bar = browser('bar');
      for (let i = 0; i < 8; i++) await subscribe(admin, U.staffBar, ep(`bar-${i}`), bar, 1, SECOND + 100);
      const results = await Promise.all(Array.from({ length: 60 }, (_, i) => rpc(pool[i % 6], 'notification_upsert_v1',
        ['system.test_all', 'race:push', JSON.stringify(payload())])));
      const created = results.filter(r => r.status === 'created');
      assert.equal(created.length, 1);
      const n = (await admin.query('select count(*)::int n, count(distinct subscription_id)::int d from notification_private.push_deliveries where notification_id=$1', [created[0].id])).rows[0];
      assert.equal(n.n, n.d); assert.ok(n.n >= 9);
      t.diagnostic(`deliveries for the race event: ${n.n}`);
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
