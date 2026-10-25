import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {apiRouteOf, dbObjectsIn, globToRegExp, parseStatusZ, relatedTests} from '../scripts/agent/lib/common.mjs';
import {checkHandoff, REQUIRED_SECTIONS} from '../scripts/agent/lib/handoff-format.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const node = (args, options = {}) => spawnSync(process.execPath, args, {cwd: root, encoding: 'utf8', ...options});
const status = () => spawnSync('git', ['--no-optional-locks', 'status', '--porcelain=v1', '--untracked-files=all'], {cwd: root, encoding: 'utf8'}).stdout;

test('offline guard blocks non-loopback fetch and sockets but allows loopback', () => {
  const guard = pathToFileURL(`${root}/scripts/agent/lib/offline-guard.mjs`).href;
  const script = `
    import net from 'node:net';
    const out = [];
    try { await fetch('https://example.supabase.co/rest/v1/'); out.push('fetch-open'); } catch (e) { out.push(e.code); }
    await new Promise(done => { const s = net.connect(443, 'api.example.com'); s.on('error', e => { out.push(e.code); done(); }); s.on('connect', () => { out.push('socket-open'); s.destroy(); done(); }); });
    const server = net.createServer(c => c.end()).listen(0, '127.0.0.1');
    await new Promise(r => server.on('listening', r));
    await new Promise(done => { const s = net.connect(server.address().port, '127.0.0.1'); s.on('connect', () => { out.push('loopback-open'); s.destroy(); done(); }); s.on('error', e => { out.push(e.code); done(); }); });
    server.close();
    console.log(JSON.stringify(out));`;
  const result = node([`--import=${guard}`, '--input-type=module', '-e', script]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), ['BABA_OFFLINE_BLOCKED', 'BABA_OFFLINE_BLOCKED', 'loopback-open']);
});

test('handoff format check rejects TODO, missing sections and mismatched verification', () => {
  const sha = 'a'.repeat(40);
  const complete = [...REQUIRED_SECTIONS, `- 작업 ID: 20261024-x-01`, '- 담당 AI: Codex', `- HEAD SHA: ${sha}`, '- 현재 상태와 일치: 예'].join('\n');
  assert.deepEqual(checkHandoff(complete), []);
  assert.match(checkHandoff(`${complete}\n- <!-- TODO: 기능 -->`).join(), /TODO 1건/);
  assert.match(checkHandoff(complete.replace('## 5. DB·Migration', '')).join(), /DB·Migration/);
  assert.match(checkHandoff(complete.replace('예', '**아니오** — 재검증')).join(), /재실행/);
  assert.match(checkHandoff(complete.replace('Codex', 'GPT')).join(), /담당 AI/);
});

test('glob, status and static DB extraction helpers', () => {
  assert.ok(globToRegExp('supabase/migrations/**').test('supabase/migrations/2026_x.sql'));
  assert.ok(globToRegExp('app/**/layout.tsx').test('app/layout.tsx'));
  assert.ok(globToRegExp('app/**/layout.tsx').test('app/(protected)/admin/layout.tsx'));
  assert.ok(!globToRegExp('lib/supabase/**').test('lib/supabase-like.ts'));
  assert.deepEqual(parseStatusZ(' M a.ts\0R  new.ts\0old.ts\0?? b c.md\0'), [{code: ' M', path: 'a.ts'}, {code: 'R ', path: 'new.ts', from: 'old.ts'}, {code: '??', path: 'b c.md'}]);
  assert.equal(apiRouteOf('app/api/admin/ledger/route.ts'), '/api/admin/ledger');
  assert.equal(apiRouteOf('app/(protected)/admin/page.tsx'), null);
  const db = dbObjectsIn(`supabase.from("inventory").update({a:1}).eq("id",1); supabase.from('users').select('*'); supabase.rpc('ledger_post_v1');
    create or replace function public.inventory_fix_v2() returns void; insert into inventory_logs values (1);`);
  assert.deepEqual(db.tables, ['inventory', 'users']);
  assert.deepEqual(db.rpcs, ['inventory_fix_v2', 'ledger_post_v1']);
  assert.deepEqual(db.writes, ['inventory.update', 'inventory_logs.sql-write']);
});

test('related tests follow source paths and migration files through helper fixtures', () => {
  const viaHelper = relatedTests(root, ['supabase/migrations/20261010140729_atomic_inventory_edit_and_versioned_correction.sql']);
  assert.ok(viaHelper.tests.some(t => t.path === 'tests/inventory-atomic-edit-db.test.mjs'));
  const sibling = relatedTests(root, ['lib/ledger/entries.ts']);
  assert.ok(sibling.tests.some(t => t.path === 'lib/ledger/entries-presentation.test.ts'));
  assert.deepEqual(relatedTests(root, ['docs/agents/baba-agent-workflow.md']).untested, []);
});

test('Codex and Claude skill definitions stay in sync', () => {
  const result = node(['scripts/agent/check-agent-skills.mjs']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /문제 없음/);
});

test('handoff draft has every required section, the real HEAD SHA and only TODO gaps', () => {
  const before = status();
  const result = node(['scripts/agent/baba-handoff.mjs', '--task-name', 'format check', '--stdout']);
  assert.equal(result.status, 0, result.stderr);
  for (const section of REQUIRED_SECTIONS) assert.ok(result.stdout.includes(section), section);
  const head = spawnSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).stdout.trim();
  assert.ok(result.stdout.includes(`HEAD SHA: ${head}`));
  assert.ok(checkHandoff(result.stdout).some(problem => /TODO/.test(problem)));
  assert.equal(status(), before);
});

test('preflight is read-only and reports machine-readable JSON', () => {
  const before = status();
  const result = node(['scripts/agent/baba-preflight.mjs', '--task', 'read-only check', '--files', 'lib/ledger/entries.ts', '--json']);
  assert.ok([0, 2].includes(result.status), result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.readOnly, true);
  assert.ok(['가능', '조건부 가능', '불가'].includes(report.verdict));
  assert.ok(report.tests.tests.some(t => t.path === 'lib/ledger/entries-presentation.test.ts'));
  assert.equal(status(), before);
});
