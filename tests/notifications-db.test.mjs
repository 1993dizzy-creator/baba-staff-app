// BABA-NOTIFICATION-01A migration on an isolated PGlite database (no production credentials).
// Covers: privileges, dedupe/observation/resolve/recurrence, read vs resolve independence,
// per-user read state, mark-all boundary, recipient rule AND/OR + NULL + personal allow list,
// access ceiling, policy-change contract (no back-fill, re-check on display), inactive/login-off/
// role change, cross-user access, href/payload validation, pagination, capped count, audit.
import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { baseSql, migration, testTypesSql, U, payload, pushMigrationIncluded } from './helpers/notification-fixture.mjs';
import { matchesRecipientRules } from '../lib/notifications/rules.ts';

async function fixture({ testTypes = true } = {}) {
  const db = new PGlite();
  await db.exec(baseSql);
  await db.exec(migration);
  if (testTypes) await db.exec(testTypesSql);
  return db;
}
const rows = async (db, sql, args = []) => (await db.query(sql, args)).rows;
async function asRole(db, role, sql, args = []) {
  await db.exec(`set role ${role}`);
  try { return (await db.query(sql, args)).rows; } finally { await db.exec('reset role'); }
}
// Every RPC runs AS service_role (the app's role), proving the grants.
const call = async (db, fn, args) => (await asRole(db, 'service_role',
  `select public.${fn}(${args.map((a, i) => `$${i + 1}${a?.cast ?? ''}`).join(',')}) r`,
  args.map(a => (a?.cast ? a.v : a))))[0].r;
const j = v => ({ v: v === null ? null : JSON.stringify(v), cast: '::jsonb' });
const upsert = (db, type, key, extra) => call(db, 'notification_upsert_v1', [type, key, j(payload(extra))]);
const resolve = (db, id, type, key, reason = 'business_resolved', evidence = { checkedBy: 'test' }) =>
  call(db, 'notification_resolve_v1', [id, type, key, reason, j(evidence)]);
const list = (db, user, filter = 'all', before = null, limit = 30) => call(db, 'notification_list_v1', [user, filter, before, limit]);
const count = async (db, user) => (await call(db, 'notification_unread_count_v1', [user])).unreadCount;
const ids = r => r.items.map(i => i.id);
const setRules = async (db, type, policy) => {
  const [{ revision }] = await rows(db, 'select revision from notification_private.policies where type_code=$1', [type]);
  const r = await call(db, 'notification_policy_update_v1', [U.owner, type, revision, j({ enabled: true, inAppEnabled: true, ...policy })]);
  assert.equal(r.status, 'ok', JSON.stringify(r));
  return r;
};
const recipients = async (db, id) => (await rows(db,
  'select user_id::int u from notification_private.recipients where notification_id=$1 order by user_id', [id])).map(r => r.u);

test('privileges: private schema closed to API roles; RPCs execute only as service_role', async () => {
  const db = await fixture();
  try {
    for (const role of ['anon', 'authenticated', 'service_role']) {
      for (const table of ['types', 'policies', 'policy_audit', 'notifications', 'recipients']) {
        await assert.rejects(asRole(db, role, `select * from notification_private.${table}`), /permission denied/);
      }
    }
    for (const role of ['anon', 'authenticated']) {
      await assert.rejects(asRole(db, role, 'select public.notification_unread_count_v1(1)'), /permission denied/);
      await assert.rejects(asRole(db, role, `select public.notification_upsert_v1('system.test_all','k','{}'::jsonb)`), /permission denied/);
      await assert.rejects(asRole(db, role, 'select public.notification_policy_list_v1(1)'), /permission denied/);
    }
    const rls = await rows(db, `select relname, relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where nspname='notification_private' and relkind='r' order by relname`);
    assert.ok(rls.length === (pushMigrationIncluded ? 9 : 5) && rls.every(r => r.relrowsecurity), 'RLS enabled on every table');
    const realtime = await rows(db, "select count(*)::int n from pg_publication_tables where schemaname='notification_private'");
    assert.equal(realtime[0].n, 0, 'no realtime publication');
  } finally { await db.close(); }
});

test('dedupe: first observation creates once; repeats keep read state; resolve then recur creates a new event', async () => {
  const db = await fixture();
  try {
    const first = await upsert(db, 'system.test_all', 'evt:1');
    assert.equal(first.status, 'created');
    assert.equal(first.recipientCount, 10, 'every active login-enabled account (10 of 12)');
    assert.equal((await call(db, 'notification_mark_read_v1', [U.staffBar, first.id])).status, 'ok');
    const [{ read_at: readAt }] = await rows(db, 'select read_at from notification_private.recipients where notification_id=$1 and user_id=$2', [first.id, U.staffBar]);
    for (let i = 0; i < 5; i++) {
      const again = await upsert(db, 'system.test_all', 'evt:1', { severity: 'urgent', bodyKo: `관측 ${i}` });
      assert.deepEqual([again.status, again.id], ['observed', first.id]);
    }
    const [n] = await rows(db, 'select * from notification_private.notifications where id=$1', [first.id]);
    assert.deepEqual([n.observation_count, n.severity, n.body_ko, n.title_ko], [6, 'urgent', '관측 4', '테스트 알림']);
    assert.ok(n.last_observed_at >= n.first_observed_at);
    const [{ read_at: after }] = await rows(db, 'select read_at from notification_private.recipients where notification_id=$1 and user_id=$2', [first.id, U.staffBar]);
    assert.deepEqual(after, readAt, 'repeat observation never resets read');
    assert.equal((await rows(db, 'select count(*)::int n from notification_private.notifications'))[0].n, 1);
    assert.equal((await rows(db, 'select count(*)::int n from notification_private.recipients'))[0].n, 10, 'no extra recipients');

    // Resolve is a business fact: read state unchanged, other users still unread.
    const res = await resolve(db, first.id, 'system.test_all', 'evt:1');
    assert.deepEqual([res.status, res.id], ['resolved', first.id]);
    assert.equal((await resolve(db, first.id, 'system.test_all', 'evt:1')).status, 'already_resolved');
    assert.equal(await count(db, U.staffHall), 1, 'resolving does not mark read');
    assert.equal(await count(db, U.staffBar), 0);
    const [r] = await rows(db, 'select status, resolved_at, resolution_reason, resolution_evidence from notification_private.notifications where id=$1', [first.id]);
    assert.equal(r.status, 'resolved'); assert.ok(r.resolved_at); assert.equal(r.resolution_reason, 'business_resolved');
    assert.deepEqual(r.resolution_evidence, { checkedBy: 'test' });

    // Recurrence after resolution = a distinct event with fresh recipients.
    const recur = await upsert(db, 'system.test_all', 'evt:1');
    assert.equal(recur.status, 'created'); assert.notEqual(recur.id, first.id);
    assert.equal(await count(db, U.staffBar), 1);
    // A duplicate / delayed resolution of the FIRST occurrence never resolves the recurrence.
    const late = await resolve(db, first.id, 'system.test_all', 'evt:1', 'late_retry', { attempt: 2 });
    assert.equal(late.status, 'already_resolved');
    const [again] = await rows(db, 'select status, resolution_reason from notification_private.notifications where id=$1', [recur.id]);
    assert.deepEqual([again.status, again.resolution_reason], ['open', null]);
    const [kept] = await rows(db, 'select resolution_reason from notification_private.notifications where id=$1', [first.id]);
    assert.equal(kept.resolution_reason, 'business_resolved', 'original resolution evidence kept');
    // The id must belong to the same type and key; any mismatch is not_found.
    assert.equal((await resolve(db, recur.id, 'system.test_all', 'evt:other')).status, 'not_found');
    assert.equal((await resolve(db, recur.id, 'sales.test_manager', 'evt:1')).status, 'not_found');
    assert.equal((await resolve(db, null, 'system.test_all', 'evt:1')).status, 'invalid_input');
    // Direct duplicate open rows are impossible even outside the RPC.
    await assert.rejects(db.query(`insert into notification_private.notifications (type_code, domain, dedupe_key, severity, title_ko, title_vi, policy_revision)
      values ('system.test_all','system','evt:1','normal','a','b',1)`), /duplicate key/);
  } finally { await db.close(); }
});

test('reading never resolves; mark-all is per user and bounded by the shown id', async () => {
  const db = await fixture();
  try {
    const a = await upsert(db, 'system.test_all', 'evt:a');
    const b = await upsert(db, 'system.test_all', 'evt:b');
    assert.equal((await call(db, 'notification_mark_all_read_v1', [U.staffBar, b.id])).updated, 2);
    const c = await upsert(db, 'system.test_all', 'evt:c'); // arrives after the user's "mark all"
    assert.equal(await count(db, U.staffBar), 1, 'new notification after the boundary stays unread');
    assert.deepEqual(ids(await list(db, U.staffBar, 'unread')), [c.id]);
    assert.equal(await count(db, U.staffHall), 3, 'other users unaffected');
    // Boundary in the middle: only ids <= upToId.
    assert.equal((await call(db, 'notification_mark_all_read_v1', [U.staffHall, a.id])).updated, 1);
    assert.deepEqual(ids(await list(db, U.staffHall, 'unread')), [c.id, b.id]);
    const statuses = await rows(db, 'select status from notification_private.notifications order by id');
    assert.ok(statuses.every(s => s.status === 'open'), 'mark read / mark all never resolves');
    assert.deepEqual(ids(await list(db, U.staffBar, 'open')), [c.id, b.id, a.id]);
    await resolve(db, a.id, 'system.test_all', 'evt:a');
    assert.deepEqual(ids(await list(db, U.staffBar, 'resolved')), [a.id]);
    assert.deepEqual(ids(await list(db, U.staffBar, 'open')), [c.id, b.id]);
    assert.equal((await call(db, 'notification_mark_all_read_v1', [U.staffBar, null])).status, 'invalid_input');
  } finally { await db.close(); }
});

test('cross-user and id tampering: other users cannot read or mark notifications they did not receive', async () => {
  const db = await fixture();
  try {
    await setRules(db, 'sales.test_manager', { rules: { groups: [{ roles: ['owner'] }], userIds: [] } });
    const owners = await upsert(db, 'sales.test_manager', 'evt:owner-only');
    assert.deepEqual(await recipients(db, owners.id), [U.owner]);
    for (const user of [U.master, U.managerHall, U.staffBar]) {
      assert.equal((await call(db, 'notification_mark_read_v1', [user, owners.id])).status, 'not_found');
      assert.deepEqual(ids(await list(db, user)), []);
    }
    assert.equal((await call(db, 'notification_mark_read_v1', [U.owner, owners.id + 1000])).status, 'not_found');
    assert.equal((await call(db, 'notification_mark_read_v1', [U.owner, 0])).status, 'invalid_input');
    const [{ n }] = await rows(db, 'select count(*)::int n from notification_private.recipients where read_at is not null');
    assert.equal(n, 0, 'nothing was marked by the attempts');
    // mark-all for another user cannot reach the owner's row.
    await call(db, 'notification_mark_all_read_v1', [U.managerHall, 1e9]);
    assert.equal(await count(db, U.owner), 1);
    // Unknown / inactive / login-disabled actors are refused outright.
    for (const user of [U.unknown, U.staffKitchenInactive, U.staffHallNoLogin]) {
      for (const [fn, args] of [['notification_unread_count_v1', [user]], ['notification_list_v1', [user, 'all', null, 30]],
        ['notification_mark_read_v1', [user, owners.id]], ['notification_mark_all_read_v1', [user, 1]], ['notification_policy_list_v1', [user]]]) {
        assert.equal((await call(db, fn, args)).status, 'forbidden', `${fn} ${user}`);
      }
    }
  } finally { await db.close(); }
});

test('recipient rules: AND inside a group, OR across groups, personal allow list, NULL semantics, TS == SQL', async () => {
  const db = await fixture();
  try {
    const cases = [
      ['owner + master', { groups: [{ roles: ['owner', 'master'] }] }, [U.owner, U.master, U.masterNull]],
      ['BAR leader only', { groups: [{ roles: ['leader'], parts: ['bar'] }] }, [U.leaderBar]],
      ['kitchen leader only', { groups: [{ roles: ['leader'], parts: ['kitchen'] }] }, [U.leaderKitchen]],
      ['manager OR hall leader', { groups: [{ roles: ['manager'] }, { roles: ['leader'], parts: ['hall'] }] }, [U.managerHall, U.leaderHall]],
      ['one person', { groups: [], userIds: [U.staffBar] }, [U.staffBar]],
      ['all active staff', { groups: [{}] }, [1, 2, 3, 4, 5, 6, 7, 8, 9, 12]],
      ['rank is role: master with NULL legacy position/part is still a master', { groups: [{ roles: ['master'] }] }, [U.master, U.masterNull]],
      ['rank AND part: owner part only (master without part excluded)', { groups: [{ roles: ['owner', 'master'], parts: ['owner'] }] }, [U.owner, U.master]],
      ['part list never matches NULL part', { groups: [{ parts: ['owner', 'hall', 'bar', 'kitchen', 'cleaning', 'etc'] }] }, [1, 2, 4, 5, 6, 7, 8, 9]],
      ['empty part list matches NULL part', { groups: [{ roles: ['staff'] }] }, [U.staffBar, U.staffHall, U.staffNullPart]],
      ['group OR personal', { groups: [{ roles: ['leader'], parts: ['bar'] }], userIds: [U.owner] }, [U.owner, U.leaderBar]],
      ['inactive/login-off personal ids never receive', { groups: [], userIds: [U.staffKitchenInactive, U.staffHallNoLogin] }, []],
      ['nobody', { groups: [], userIds: [] }, []],
    ];
    const staff = await rows(db, `select a.id::int id, a.role, a.part from public.users u
      cross join lateral notification_private.actor(u.id) a`);
    let k = 0;
    for (const [label, rules, expected] of cases) {
      await setRules(db, 'system.test_all', { rules });
      const created = await upsert(db, 'system.test_all', `rules:${k++}`);
      assert.deepEqual(await recipients(db, created.id), expected, label);
      const ts = staff.filter(s => matchesRecipientRules(rules, s)).map(s => s.id).sort((a, b) => a - b);
      assert.deepEqual(ts, expected, `TS matcher agrees: ${label}`);
    }
  } finally { await db.close(); }
});

test('access ceiling: rules never widen business access (owner-only leave type, manager type)', async () => {
  const db = await fixture();
  try {
    await setRules(db, 'attendance.leave_request_pending', { rules: { groups: [{}], userIds: [U.staffBar, U.managerHall] } });
    const leave = await upsert(db, 'attendance.leave_request_pending', 'leave:2026-11');
    assert.deepEqual(await recipients(db, leave.id), [U.owner, U.master, U.masterNull]);
    await setRules(db, 'sales.test_manager', { rules: { groups: [{}], userIds: [U.leaderBar] } });
    const sales = await upsert(db, 'sales.test_manager', 'sales:1');
    assert.deepEqual(await recipients(db, sales.id), [U.owner, U.master, U.masterNull, U.managerHall]);
    // Sensitive domains are capped at owner/master by a constraint, even for migrations.
    await assert.rejects(db.query(`insert into notification_private.types (code, domain, access_roles) values ('payroll.x','payroll',array['owner','manager'])`), /types_sensitive_domain_ceiling/);
    await assert.rejects(db.query(`insert into notification_private.types (code, domain, access_roles) values ('ledger.x','ledger',array['staff'])`), /types_sensitive_domain_ceiling/);
    // Display re-checks the ceiling: even a stray recipient row for a staff member stays hidden.
    await db.query('insert into notification_private.recipients (notification_id, user_id) values ($1, $2)', [leave.id, U.staffBar]);
    assert.equal(await count(db, U.staffBar), 0);
    assert.equal((await call(db, 'notification_mark_read_v1', [U.staffBar, leave.id])).status, 'not_found');
  } finally { await db.close(); }
});

test('policy change contract: new rules apply to new events only; old events re-checked, never back-filled', async () => {
  const db = await fixture();
  try {
    await setRules(db, 'system.test_all', { rules: { groups: [{ roles: ['leader'], parts: ['bar'] }] } });
    const old = await upsert(db, 'system.test_all', 'old');
    assert.equal(await count(db, U.leaderBar), 1);
    // Switch to kitchen leader: bar leader loses the old one, kitchen leader is not back-filled.
    await setRules(db, 'system.test_all', { rules: { groups: [{ roles: ['leader'], parts: ['kitchen'] }] } });
    assert.equal(await count(db, U.leaderBar), 0, 'removed recipient no longer sees old events');
    assert.deepEqual(ids(await list(db, U.leaderBar)), []);
    assert.equal(await count(db, U.leaderKitchen), 0, 'no retroactive delivery');
    const fresh = await upsert(db, 'system.test_all', 'new');
    assert.deepEqual(await recipients(db, fresh.id), [U.leaderKitchen]);
    // Repeated observation of the old event does not add the new audience either.
    assert.equal((await upsert(db, 'system.test_all', 'old')).status, 'observed');
    assert.deepEqual(await recipients(db, old.id), [U.leaderBar]);
    // Restoring the rule restores visibility of the event the user originally received.
    await setRules(db, 'system.test_all', { rules: { groups: [{ roles: ['leader'] }] } });
    assert.deepEqual(ids(await list(db, U.leaderBar)), [old.id]);
    // Disabling the type hides everything and stops new events.
    await setRules(db, 'system.test_all', { enabled: false, rules: { groups: [{}] } });
    assert.equal(await count(db, U.leaderKitchen), 0);
    assert.equal((await upsert(db, 'system.test_all', 'while-disabled')).status, 'disabled');
    assert.equal((await rows(db, "select count(*)::int n from notification_private.notifications where dedupe_key='while-disabled'"))[0].n, 0);
    // In-app off: event recorded (for 01-B channels) but hidden from the in-app center.
    await setRules(db, 'system.test_all', { inAppEnabled: false, rules: { groups: [{}] } });
    const hidden = await upsert(db, 'system.test_all', 'inapp-off');
    assert.equal(hidden.status, 'created');
    assert.equal(await count(db, U.staffBar), 0);
    const [{ policy_revision }] = await rows(db, 'select policy_revision from notification_private.notifications where id=$1', [hidden.id]);
    assert.equal(policy_revision, 6, 'event records the policy revision it was fanned out with');
  } finally { await db.close(); }
});

test('account changes: deactivation, login off, role/part change are re-checked on every read', async () => {
  const db = await fixture();
  try {
    await setRules(db, 'sales.test_manager', { rules: { groups: [{}] } });
    const n = await upsert(db, 'sales.test_manager', 'acct');
    assert.equal(await count(db, U.managerHall), 1);
    await db.query("update public.users set role='leader', position='leader' where id=$1", [U.managerHall]);
    assert.equal(await count(db, U.managerHall), 0, 'demoted below the ceiling');
    assert.equal((await call(db, 'notification_mark_read_v1', [U.managerHall, n.id])).status, 'not_found');
    await db.query("update public.users set role='manager', position='manager' where id=$1", [U.managerHall]);
    assert.equal(await count(db, U.managerHall), 1, 'restored role sees it again');
    await setRules(db, 'system.test_all', { rules: { groups: [{ roles: ['leader'], parts: ['bar'] }] } });
    await upsert(db, 'system.test_all', 'part');
    await db.query("update public.users set part='hall' where id=$1", [U.leaderBar]);
    assert.equal(await count(db, U.leaderBar), 0, 'part change re-checked');
    await db.query('update public.users set is_active=false where id=$1', [U.owner]);
    assert.equal((await call(db, 'notification_unread_count_v1', [U.owner])).status, 'forbidden');
    await db.query('update public.users set is_active=true, app_login_enabled=false where id=$1', [U.owner]);
    assert.equal((await call(db, 'notification_list_v1', [U.owner, 'all', null, 30])).status, 'forbidden');
  } finally { await db.close(); }
});

test('writer validation: internal paths only, bounded payload, unknown type, no browser-supplied extras', async () => {
  const db = await fixture();
  try {
    for (const href of ['https://evil.test', '//evil.test', '/a/../admin', 'javascript:alert(1)', '/a\\b', 'admin', '/a b', '/x?y=1//z']) {
      assert.equal((await upsert(db, 'system.test_all', `href:${encodeURIComponent(href).replace(/%/g, '')}`, { href })).status, 'invalid_input', href);
    }
    assert.equal((await upsert(db, 'system.test_all', 'ok-href', { href: '/admin/sales/receipts?date=2026-11-26#line' })).status, 'created');
    assert.equal((await upsert(db, 'system.test_all', 'nohref', { href: null })).status, 'created');
    assert.equal((await upsert(db, 'system.test_all', 'long', { titleKo: 'x'.repeat(121) })).status, 'invalid_input');
    assert.equal((await upsert(db, 'system.test_all', 'sev', { severity: 'critical' })).status, 'invalid_input');
    assert.equal((await upsert(db, 'system.test_all', 'bad key with space')).status, 'invalid_input');
    assert.equal((await call(db, 'notification_upsert_v1', ['system.test_all', 'extra', j({ ...payload(), userId: 1 })])).status, 'invalid_input');
    assert.equal((await call(db, 'notification_upsert_v1', ['system.test_all', 'num', j({ ...payload(), titleKo: 5 })])).status, 'invalid_input');
    assert.equal((await upsert(db, 'nope.missing', 'x')).status, 'unknown_type');
    const okHref = (await rows(db, "select id::int id from notification_private.notifications where dedupe_key='ok-href'"))[0].id;
    assert.equal((await resolve(db, okHref, 'system.test_all', 'ok-href', 'Bad Reason')).status, 'invalid_input');
    assert.equal((await resolve(db, okHref, 'system.test_all', 'ok-href', 'ok', ['not-object'])).status, 'invalid_input');
    const [{ n }] = await rows(db, "select count(*)::int n from notification_private.notifications where status='open'");
    assert.equal(n, 2, 'only the two valid events exist');
  } finally { await db.close(); }
});

test('pagination: 30 per page with keyset cursor; unread count capped at 100', async () => {
  const db = await fixture();
  try {
    await setRules(db, 'system.test_all', { rules: { groups: [], userIds: [U.staffBar] } });
    for (let i = 0; i < 105; i++) await upsert(db, 'system.test_all', `p:${i}`);
    const p1 = await list(db, U.staffBar);
    assert.equal(p1.items.length, 30); assert.equal(p1.hasMore, true);
    assert.equal(p1.nextBeforeId, p1.items[29].id);
    const p2 = await list(db, U.staffBar, 'all', p1.nextBeforeId);
    assert.ok(p2.items.every(i => i.id < p1.nextBeforeId));
    let all = [...p1.items, ...p2.items], cursor = p2.nextBeforeId;
    while (cursor) { const p = await list(db, U.staffBar, 'all', cursor); all = all.concat(p.items); cursor = p.nextBeforeId; }
    assert.equal(new Set(all.map(i => i.id)).size, 105);
    const c = await call(db, 'notification_unread_count_v1', [U.staffBar]);
    assert.deepEqual([c.unreadCount, c.capped], [100, true]);
    assert.equal((await list(db, U.staffBar, 'all', null, 51)).status, 'invalid_input');
    assert.equal((await list(db, U.staffBar, 'weird')).status, 'invalid_input');
    const item = p1.items[0];
    assert.deepEqual(Object.keys(item).sort(), ['bodyKo', 'bodyVi', 'domain', 'firstObservedAt', 'href', 'id', 'lastObservedAt',
      'readAt', 'resolvedAt', 'severity', 'status', 'subjectId', 'subjectType', 'titleKo', 'titleVi', 'typeCode'].sort());
    const indexes = (await rows(db, "select indexname from pg_indexes where schemaname='notification_private' order by 1")).map(r => r.indexname);
    for (const name of ['notifications_open_event_unique', 'recipients_user_idx', 'recipients_user_unread_idx']) assert.ok(indexes.includes(name), name);
  } finally { await db.close(); }
});

test('policy administration: owner/master only, validation, optimistic revision, append-only audit', async () => {
  const db = await fixture({ testTypes: false });
  try {
    for (const user of [U.managerHall, U.leaderBar, U.staffBar, U.unknown]) {
      assert.equal((await call(db, 'notification_policy_list_v1', [user])).status, 'forbidden');
      assert.equal((await call(db, 'notification_policy_update_v1', [user, 'attendance.leave_request_pending', 1, j({ enabled: true, inAppEnabled: true, rules: { groups: [] } })])).status, 'forbidden');
    }
    const listed = await call(db, 'notification_policy_list_v1', [U.master]);
    assert.equal(listed.status, 'ok');
    assert.deepEqual(listed.types.map(t => [t.code, t.enabled, t.revision]),
      [['attendance.leave_request_pending', false, 1], ['inventory.pos_deduction_pending', false, 1]]);
    assert.deepEqual(listed.types[0].matchedUserIds, [U.owner, U.master, U.masterNull]);
    assert.deepEqual(listed.staff.map(s => s.id), [1, 2, 3, 4, 5, 6, 7, 8, 9, 12], 'only active login-enabled staff are selectable');
    assert.deepEqual(listed.staff.find(s => s.id === U.staffHall), { id: 9, name: 'Staff Hall', role: 'staff', part: 'hall' });
    const type = 'inventory.pos_deduction_pending';
    for (const bad of [
      { enabled: 'yes', inAppEnabled: true, rules: { groups: [] } },
      { enabled: true, inAppEnabled: true, rules: { groups: [{ parts: ['garden'] }] } },
      { enabled: true, inAppEnabled: true, rules: { groups: [{ roles: ['Owner'] }] } },
      { enabled: true, inAppEnabled: true, rules: { groups: [{ team: ['bar'] }] } },
      { enabled: true, inAppEnabled: true, rules: { groups: [{ positions: ['owner'] }] } },
      { enabled: true, inAppEnabled: true, rules: { groups: [], userIds: ['5'] } },
      { enabled: true, inAppEnabled: true, rules: { groups: [], userIds: [U.unknown] } },
      { enabled: true, inAppEnabled: true, rules: { groups: Array.from({ length: 21 }, () => ({})) } },
      { enabled: true, inAppEnabled: true, rules: { groups: [] }, pushEnabled: 'yes' },
    ]) assert.equal((await call(db, 'notification_policy_update_v1', [U.owner, type, 1, j(bad)])).status, 'invalid_input', JSON.stringify(bad));
    const ok = await call(db, 'notification_policy_update_v1', [U.owner, type, 1, j({ enabled: true, inAppEnabled: true,
      rules: { groups: [{ parts: ['bar', 'bar'], roles: ['leader'] }, { roles: ['leader'], parts: ['bar'] }], userIds: [8, 8, 4] } })]);
    assert.deepEqual(ok, { status: 'ok', revision: 2, rules: { groups: [{ roles: ['leader'], parts: ['bar'] }], userIds: [4, 8] } });
    const stale = await call(db, 'notification_policy_update_v1', [U.master, type, 1, j({ enabled: false, inAppEnabled: true, rules: { groups: [] } })]);
    assert.deepEqual(stale, { status: 'version_conflict', latestRevision: 2 });
    assert.equal((await call(db, 'notification_policy_update_v1', [U.owner, 'nope.type', 1, j({ enabled: true, inAppEnabled: true, rules: { groups: [] } })])).status, 'not_found');
    const audit = await rows(db, 'select type_code, revision, before_policy, after_policy, actor_user_id::int actor from notification_private.policy_audit');
    assert.equal(audit.length, 1);
    assert.deepEqual([audit[0].revision, audit[0].actor, audit[0].before_policy.enabled, audit[0].after_policy.enabled], [2, U.owner, false, true]);
    await assert.rejects(db.query('update notification_private.policy_audit set revision=9'), /append-only/);
    await assert.rejects(db.query('delete from notification_private.policy_audit'), /append-only/);
    await assert.rejects(db.query('truncate notification_private.policy_audit'), /append-only/);
    const relisted = await call(db, 'notification_policy_list_v1', [U.owner]);
    const pos = relisted.types.find(t => t.code === type);
    assert.deepEqual([pos.updatedByName, pos.matchedUserIds], ['Owner A', [U.managerHall, U.leaderBar]], 'staff personal id stays under the ceiling');
    assert.equal(relisted.audit[0].actorName, 'Owner A');
  } finally { await db.close(); }
});

test('seeded follow-up types stay disabled: no notification can be created before an owner enables them', async () => {
  const db = await fixture({ testTypes: false });
  try {
    for (const type of ['attendance.leave_request_pending', 'inventory.pos_deduction_pending']) {
      assert.equal((await upsert(db, type, 'seed-check')).status, 'disabled');
    }
    assert.equal((await rows(db, 'select count(*)::int n from notification_private.notifications'))[0].n, 0);
  } finally { await db.close(); }
});
