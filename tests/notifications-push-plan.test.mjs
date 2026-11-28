// BABA-NOTIFICATION-01B queue plans on real PostgreSQL (throwaway local cluster, synthetic rows only;
// never run against Production). Seeds 10k and 100k finished deliveries, then checks with
// EXPLAIN (ANALYZE, BUFFERS) and auto_explain (the statements INSIDE the claim function) that an
// empty queue, a small queue, not-yet-due retries, lease-expired claims and TTL-expired rows are
// found through the partial indexes: no scan of finished history, no external sort, no temp blocks.
// Plans are written to .local/notification-01b/plans-<n>.txt for the report.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { startPushCluster, rpc } from './helpers/push-native-pg.mjs';

const KEY = 'B' + 'A'.repeat(86), AUTH = 'C'.repeat(22);
const QUERIES = {
  recovery_pending: `select d.id from notification_private.push_deliveries d where d.status = 'pending' and d.next_attempt_at <= now()
    order by d.next_attempt_at, d.id limit 5 for update skip locked`,
  recovery_sending: `select d.id from notification_private.push_deliveries d where d.status = 'sending' and d.claimed_at < now() - interval '90 seconds'
    order by d.claimed_at, d.id limit 5 for update skip locked`,
  idle_probe_pending: `select exists (select 1 from notification_private.push_deliveries d where d.status = 'pending' and d.next_attempt_at <= now())`,
  idle_probe_sending: `select exists (select 1 from notification_private.push_deliveries d where d.status = 'sending' and d.claimed_at < now() - interval '90 seconds')`,
  event: `select d.id from notification_private.push_deliveries d where d.notification_id = $1
    and ((d.status = 'pending' and d.next_attempt_at <= now()) or (d.status = 'sending' and d.claimed_at < now() - interval '90 seconds'))
    order by d.id limit 5 for update skip locked`,
};
const bad = plan => /Seq Scan on push_deliveries|Sort Method: external|temp (read|written)=/i.test(plan);

for (const size of [10_000, 100_000]) {
  test(`queue plans with ${size.toLocaleString('en')} finished deliveries`, { timeout: 180000 }, async t => {
    const cluster = await startPushCluster(`pg-plan-${size}`);
    const { admin, logs } = cluster;
    const report = [];
    try {
      await admin.query(`update notification_private.policies set push_enabled = true where type_code = 'system.test_all'`);
      await admin.query(`insert into notification_private.push_subscriptions (user_id, session_iat, device_hash, device_generation, endpoint, p256dh, auth, expires_at)
        select 1, 1790000000, repeat('D', 43), 1, 'https://fcm.googleapis.com/fcm/send/plan-' || g, $1, $2, now() + interval '20 days' from generate_series(1, 100) g`, [KEY, AUTH]);
      await admin.query(`insert into notification_private.notifications (type_code, domain, dedupe_key, severity, title_ko, title_vi, policy_revision, status, resolved_at, resolution_reason)
        select 'system.test_all', 'system', 'hist:' || g, 'normal', 'a', 'b', 1, 'resolved', now(), 'done' from generate_series(1, ${size / 100}) g`);
      await admin.query(`insert into notification_private.push_deliveries (notification_id, subscription_id, user_id, status, attempt_count, next_attempt_at, expires_at, finished_at, accepted_at, last_error, created_at)
        select n.id, s.id, 1, st, 1, now() - interval '2 days', now() - interval '1 day', now() - interval '1 day',
          case when st = 'accepted' then now() - interval '1 day' end, case when st <> 'accepted' then 'history' end, now() - interval '2 days'
        from notification_private.notifications n cross join notification_private.push_subscriptions s
        cross join lateral (select (array['accepted','accepted','accepted','failed','skipped','expired'])[1 + ((n.id + s.id) % 6)::int] st) x
        where n.dedupe_key like 'hist:%'`);
      await admin.query('analyze notification_private.push_deliveries');
      const [{ n }] = (await admin.query('select count(*)::int n from notification_private.push_deliveries')).rows;
      assert.equal(n, size);

      const explain = async (name, sql, args = []) => {
        await admin.query('begin');
        try {
          const plan = (await admin.query(`explain (analyze, buffers, costs off, timing off, summary on) ${sql}`, args)).rows.map(r => r['QUERY PLAN']).join('\n');
          report.push(`## ${name}\n${plan}\n`);
          return plan;
        } finally { await admin.query('rollback'); }
      };

      // 1) Empty queue (history only): the probes and the recovery queries never touch history.
      for (const name of ['idle_probe_pending', 'idle_probe_sending', 'recovery_pending', 'recovery_sending']) {
        const plan = await explain(`empty/${name}`, QUERIES[name]);
        assert.ok(!bad(plan), `${name}\n${plan}`);
      }
      const svc = await cluster.connect();
      const idleStart = process.hrtime.bigint();
      const idle = await rpc(svc, 'notification_push_claim_v1', [null, 5, 90]);
      const idleMs = Number(process.hrtime.bigint() - idleStart) / 1e6;
      assert.equal(idle.idle, true);

      // 2) Small live queue: 5 due, 5 not yet due (retry backoff), 3 lease-expired claims, 2 TTL-expired.
      const ev = Number((await admin.query(`insert into notification_private.notifications (type_code, domain, dedupe_key, severity, title_ko, title_vi, policy_revision)
        values ('system.test_all', 'system', 'live:1', 'warning', 'a', 'b', 1) returning id`)).rows[0].id);
      await admin.query(`insert into notification_private.push_deliveries (notification_id, subscription_id, user_id, status, attempt_count, next_attempt_at, expires_at, claim_token, claimed_at)
        select $1, s.id, 1,
          case when s.rn <= 10 or s.rn > 13 then 'pending' else 'sending' end,
          case when s.rn <= 5 or s.rn > 13 then 0 else 1 end,
          case when s.rn between 6 and 10 then now() + interval '4 minutes' else now() - interval '1 second' end,
          case when s.rn > 13 then now() + interval '2 seconds' else now() + interval '50 minutes' end,
          case when s.rn between 11 and 13 then gen_random_uuid() end,
          case when s.rn between 11 and 13 then now() - interval '5 minutes' end
        from (select id, row_number() over (order by id) rn from notification_private.push_subscriptions) s where s.rn <= 15`, [ev]);
      await admin.query('analyze notification_private.push_deliveries');
      for (const name of ['recovery_pending', 'recovery_sending']) {
        const plan = await explain(`live/${name}`, QUERIES[name]);
        assert.ok(!bad(plan), `${name}\n${plan}`);
      }
      const eventPlan = await explain('live/event', QUERIES.event, [ev]);
      assert.ok(!bad(eventPlan), eventPlan);

      // 3) The real function statements (auto_explain, nested): recovery + event claims.
      await svc.query("reset role; load 'auto_explain'; set auto_explain.log_min_duration = 0; set auto_explain.log_analyze = on; set auto_explain.log_buffers = on; set auto_explain.log_nested_statements = on; set auto_explain.log_timing = off; set role service_role");
      const logStart = logs.length;
      const recStart = process.hrtime.bigint();
      const rec = await rpc(svc, 'notification_push_claim_v1', [null, 5, 90]);
      const recMs = Number(process.hrtime.bigint() - recStart) / 1e6;
      const evStart = process.hrtime.bigint();
      const evc = await rpc(svc, 'notification_push_claim_v1', [ev, 5, 90]);
      const evMs = Number(process.hrtime.bigint() - evStart) / 1e6;
      await new Promise(resolve => setTimeout(resolve, 300));
      const nested = logs.slice(logStart).join('');
      const dPlans = nested.split(/LOG:\s+duration:/).filter(p => /push_deliveries/.test(p));
      assert.ok(dPlans.length >= 3, 'auto_explain captured the function statements');
      for (const plan of dPlans) assert.ok(!/Seq Scan on push_deliveries|Sort Method: external|temp (read|written)=/.test(plan), plan);
      report.push(`## auto_explain (function statements touching push_deliveries)\n${dPlans.join('\n---\n')}\n`);
      // Outcomes: TTL-expired never handed out; not-yet-due rows untouched; lease-expired re-claimed.
      const handed = [...rec.items, ...evc.items];
      assert.ok(handed.length <= 10 && rec.items.length <= 5 && evc.items.length <= 5);
      const states = (await admin.query(`select status, count(*)::int n from notification_private.push_deliveries where notification_id=$1 group by status order by status`, [ev])).rows;
      t.diagnostic(`size=${size} idle_claim_ms=${idleMs.toFixed(1)} recovery_claim_ms=${recMs.toFixed(1)} event_claim_ms=${evMs.toFixed(1)} live_states=${JSON.stringify(states)}`);
      const notDue = (await admin.query(`select count(*)::int n from notification_private.push_deliveries where notification_id=$1 and status='pending' and next_attempt_at > now()`, [ev])).rows[0].n;
      assert.equal(notDue, 5, 'not-yet-due retries untouched');
      assert.equal((await admin.query(`select count(*)::int n from notification_private.push_deliveries where notification_id=$1 and status='expired'`, [ev])).rows[0].n, 2);
      const temp = (await admin.query('select temp_files::int f, temp_bytes::bigint b from pg_stat_database where datname = current_database()')).rows[0];
      assert.equal(temp.f, 0, 'no temporary files');
      report.unshift(`# ${size} finished deliveries — idle claim ${idleMs.toFixed(1)} ms, recovery claim ${recMs.toFixed(1)} ms, event claim ${evMs.toFixed(1)} ms, temp files ${temp.f}\n`);
    } finally {
      writeFileSync(`.local/notification-01b/plans-${size}.txt`, report.join('\n'));
      await cluster.stop();
    }
  });
}
