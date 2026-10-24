import test from 'node:test';
import assert from 'node:assert/strict';
import {cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, symlinkSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {git, gitOut, run, sanitizedEnv, stateFingerprint} from '../scripts/agent/lib/common.mjs';

// All writes (including pushes) target disposable LOCAL repositories. Keep fixtures as evidence.
const source = resolve(fileURLToPath(new URL('..', import.meta.url)));
const fixtures = join(source, '.tmp-baba/start-fixtures');
mkdirSync(fixtures, {recursive: true});
function put(root, path, text) {
  const full = join(root, path);
  mkdirSync(resolve(full, '..'), {recursive: true});
  writeFileSync(full, text);
}
function commit(root, path, text) {
  put(root, path, text); git(root, ['add', '--', path]); git(root, ['commit', '-m', 'fixture']);
  return gitOut(root, ['rev-parse', 'HEAD']);
}
function fixture({failFinal = false} = {}) {
  const dir = mkdtempSync(join(fixtures, '한글 space-'));
  const main = join(dir, 'baba-staff-app'), codex = join(dir, 'baba-wt-codex'), claude = join(dir, 'baba-wt-claude');
  const remote = join(dir, 'origin.git');
  mkdirSync(main); git(main, ['init', '-b', 'main']);
  git(main, ['config', 'user.email', 'fixture@example.invalid']); git(main, ['config', 'user.name', 'Fixture']);
  git(main, ['init', '--bare', remote]);
  cpSync(join(source, 'scripts/agent'), join(main, 'scripts/agent'), {recursive: true});
  if (failFinal) {
    const script = join(main, 'scripts/agent/baba-preflight.mjs');
    writeFileSync(script, readFileSync(script, 'utf8') + '\nif (gitOut(root, ["branch", "--show-current"]).includes("-retry-") && !existsSync(join(root, ".tmp-baba/allow-final"))) process.exitCode = 2;\n');
  }
  put(main, '.gitignore', '.tmp-baba/\nnode_modules/\n');
  put(main, 'app/a.ts', 'export const a = 1;\n'); put(main, 'app/b.ts', 'export const b = 1;\n');
  put(main, 'docs/note.md', 'original\n'); put(main, 'package.json', '{"private":true}\n');
  git(main, ['add', '.']); git(main, ['commit', '-m', 'seed']);
  git(main, ['remote', 'add', 'origin', remote]); git(main, ['push', '-u', 'origin', 'main']);
  git(main, ['worktree', 'add', '--no-track', '-b', 'codex/ready-fixture', codex, 'main']);
  git(main, ['worktree', 'add', '--no-track', '-b', 'claude/ready-fixture', claude, 'main']);
  return {dir, main, codex, claude, remote, seed: gitOut(main, ['rev-parse', 'HEAD'])};
}
function start(root, args = []) {
  const result = run(process.execPath, [join(root, 'scripts/agent/baba-start.mjs'), ...args, '--json'],
    {cwd: root, env: sanitizedEnv().env, allowFail: true, timeout: 120000});
  let report;
  try { report = JSON.parse(result.stdout); } catch { assert.fail(`Invalid report: ${result.stdout} ${result.stderr}`); }
  assert.equal(result.status, report.status === 'BLOCKED' ? 2 : 0, JSON.stringify(report));
  return report;
}
const request = (task = 'alpha', files = 'app/a.ts') => ['--task', task, '--files', files];
const head = root => gitOut(root, ['rev-parse', 'HEAD']);
const branch = root => gitOut(root, ['branch', '--show-current']);
const refs = root => gitOut(root, ['show-ref', '--heads']);
function publisher(f) {
  const p = join(f.dir, 'publisher'); mkdirSync(p); git(p, ['init', '-b', 'main']);
  git(p, ['config', 'user.email', 'fixture@example.invalid']); git(p, ['config', 'user.name', 'Fixture']);
  git(p, ['remote', 'add', 'origin', f.remote]); git(p, ['fetch', 'origin', 'main']);
  git(p, ['switch', '-c', 'publish', 'FETCH_HEAD']);
  commit(p, 'remote.txt', 'remote-only\n'); git(p, ['push', 'origin', 'HEAD:main']); return head(p);
}

test('Codex and Claude start from local main on separate unique branches; originals survive', () => {
  const f = fixture(); put(f.main, 'docs/note.md', 'preserve dirty main\n');
  const c = start(f.codex, [...request('alpha', 'app\\a.ts'), '--agent', 'codex']);
  const a = start(f.claude, [...request('beta', 'app/b.ts'), '--agent', 'claude']);
  assert.equal(c.status, 'STARTED'); assert.equal(a.status, 'STARTED');
  assert.match(c.branch, /^codex\/\d{8}-alpha-01$/); assert.match(a.branch, /^claude\/\d{8}-beta-01$/);
  assert.equal(c.baseSha, f.seed); assert.equal(a.baseSha, f.seed); assert.equal(head(f.main), f.seed);
  assert.deepEqual(JSON.parse(readFileSync(join(f.codex, `.tmp-baba/start/tasks/${c.taskId}.json`), 'utf8')).files, ['app/a.ts']);
  assert.equal(readFileSync(join(f.main, 'docs/note.md'), 'utf8'), 'preserve dirty main\n');
  assert.equal(gitOut(f.main, ['rev-parse', 'codex/ready-fixture']), f.seed);
  assert.equal(gitOut(f.main, ['rev-parse', 'claude/ready-fixture']), f.seed);
  assert.ok(existsSync(join(f.codex, c.savedAs))); assert.equal(gitOut(f.codex, ['status', '--porcelain']), '');
});
test('existing branch and reserved record names are never overwritten', () => {
  const f = fixture(), d = new Date(), day = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
  git(f.codex, ['branch', `codex/${day}-alpha-01`, 'main']);
  const busy = join(f.dir, 'busy'); git(f.main, ['worktree', 'add', busy, `codex/${day}-alpha-01`]);
  put(f.codex, `.tmp-baba/start/tasks/${day}-alpha-02.json`, 'reserved');
  const r = start(f.codex, request()); assert.equal(r.status, 'STARTED'); assert.match(r.branch, /-03$/);
  assert.equal(readFileSync(join(f.codex, `.tmp-baba/start/tasks/${day}-alpha-02.json`), 'utf8'), 'reserved');
});
test('local main ahead of origin is authoritative', () => {
  const f = fixture(); const latest = commit(f.main, 'app/new.ts', 'local ahead\n');
  const r = start(f.codex, request()); assert.equal(r.status, 'STARTED'); assert.equal(r.baseSha, latest);
  assert.equal(r.synchronization.relation, 'local-ahead'); assert.equal(head(f.main), latest);
  assert.equal(readFileSync(join(f.codex, 'app/new.ts'), 'utf8'), 'local ahead\n');
});
test('remote ahead is fetched but main and own branches are preserved', () => {
  const f = fixture(), remote = publisher(f), before = refs(f.main);
  const r = start(f.codex, request()); assert.equal(r.code, 'REMOTE_AHEAD'); assert.equal(refs(f.main), before);
  assert.equal(r.synchronization.remoteMain, remote); assert.equal(r.synchronization.remoteOnly, 1);
  assert.equal(head(f.main), f.seed); assert.equal(branch(f.codex), 'codex/ready-fixture');
  assert.equal(gitOut(f.main, ['rev-parse', 'origin/main']), remote);
});
test('diverged main stops without merge', () => {
  const f = fixture(); publisher(f); const local = commit(f.main, 'local.txt', 'local\n');
  const before = refs(f.main), r = start(f.codex, request()); assert.equal(r.code, 'DIVERGED_MAIN');
  assert.equal(refs(f.main), before); assert.equal(head(f.main), local);
});
test('dirty current worktree stops before fetch and preserves file bytes', () => {
  const f = fixture(); publisher(f); put(f.codex, 'app/a.ts', 'uncommitted\n');
  const r = start(f.codex, request()); assert.equal(r.code, 'DIRTY_WORKTREE');
  assert.equal(gitOut(f.main, ['rev-parse', 'origin/main']), f.seed);
  assert.equal(readFileSync(join(f.codex, 'app/a.ts'), 'utf8'), 'uncommitted\n'); assert.equal(r.savedAs, null);
});
test('other worktree dirty overlap blocks while its source and branch remain untouched', () => {
  const f = fixture(); put(f.claude, 'app/a.ts', 'Claude work\n'); const before = refs(f.main);
  assert.equal(start(f.codex, request()).code, 'WORKTREE_CONFLICT'); assert.equal(refs(f.main), before);
  assert.equal(readFileSync(join(f.claude, 'app/a.ts'), 'utf8'), 'Claude work\n');
});
test('other worktree committed overlap and new files matching glob block', () => {
  const f = fixture(); commit(f.claude, 'app/a.ts', 'committed Claude\n');
  assert.equal(start(f.codex, request()).code, 'WORKTREE_CONFLICT');
  put(f.claude, 'app/new.ts', 'new Claude\n');
  assert.equal(start(f.codex, request('glob', 'app/new*.ts')).code, 'WORKTREE_CONFLICT');
});
test('repeated clean start and explicit resume reuse recorded branch including progress commits', () => {
  const f = fixture(), first = start(f.codex, request()); assert.equal(first.status, 'STARTED');
  const progress = commit(f.codex, 'app/a.ts', 'progress\n'), before = refs(f.main);
  const second = start(f.codex, request()), third = start(f.codex, ['--resume', first.taskId]);
  assert.equal(second.status, 'RESUMED'); assert.equal(third.status, 'RESUMED');
  assert.equal(second.branchCreated, false); assert.equal(third.branch, first.branch);
  assert.equal(head(f.codex), progress); assert.equal(refs(f.main), before);
  put(f.codex, 'app/a.ts', 'dirty resume\n'); assert.equal(start(f.codex, ['--resume', first.taskId]).code, 'DIRTY_WORKTREE');
});
test('a different task cannot replace unfinished or unrecorded work', () => {
  const f = fixture(); const first = start(f.codex, request());
  assert.equal(start(f.codex, request('different')).code, 'UNFINISHED_TASK'); assert.equal(branch(f.codex), first.branch);
  git(f.claude, ['switch', '-c', 'claude/legacy', 'main']);
  assert.equal(start(f.claude, request('legacy')).code, 'UNRECORDED_BRANCH');
});
test('wrong agent and original main are rejected before any record or branch write', () => {
  const f = fixture(), before = refs(f.main);
  assert.equal(start(f.codex, [...request(), '--agent', 'claude']).code, 'WRONG_WORKTREE');
  assert.equal(start(f.main, request()).code, 'WRONG_WORKTREE'); assert.equal(refs(f.main), before);
  assert.equal(existsSync(join(f.main, '.tmp-baba')), false);
});
test('resume branch checked out by another worktree is protected', () => {
  const f = fixture(), first = start(f.codex, request());
  git(f.codex, ['switch', 'codex/ready-fixture']); git(f.main, ['worktree', 'add', join(f.dir, 'busy'), first.branch]);
  assert.equal(start(f.codex, ['--resume', first.taskId]).code, 'BRANCH_IN_USE');
});
test('missing or inaccessible remote stops without creating a branch', () => {
  const f = fixture(); git(f.main, ['remote', 'set-url', 'origin', join(f.dir, 'absent.git')]);
  const before = refs(f.main); assert.equal(start(f.codex, request()).code, 'REMOTE_UNAVAILABLE'); assert.equal(refs(f.main), before);
});
test('live lock is preserved; explicit resume archives only demonstrably dead process lock', () => {
  const f = fixture(), first = start(f.codex, request()), lock = '.tmp-baba/start/start.lock';
  const live = JSON.stringify({pid: process.pid, nonce: 'live'}); put(f.codex, lock, live);
  assert.equal(start(f.codex, ['--resume', first.taskId]).code, 'START_LOCKED'); assert.equal(readFileSync(join(f.codex, lock), 'utf8'), live);
  const dead = JSON.stringify({pid: 2147483647, nonce: 'dead'}); put(f.codex, lock, dead);
  assert.equal(start(f.codex, ['--resume', first.taskId]).status, 'RESUMED');
  const archives = readdirSync(join(f.codex, '.tmp-baba/start')).filter(p => p.startsWith('abandoned-lock-'));
  assert.equal(archives.length, 1); assert.equal(readFileSync(join(f.codex, '.tmp-baba/start', archives[0]), 'utf8'), dead);
});
test('corrupt task record is preserved and cannot be silently adopted', () => {
  const f = fixture(), first = start(f.codex, request()), path = `.tmp-baba/start/tasks/${first.taskId}.json`;
  put(f.codex, path, '{broken'); const before = refs(f.main);
  assert.equal(start(f.codex, ['--resume', first.taskId]).code, 'INVALID_RECORD'); assert.equal(refs(f.main), before);
  assert.equal(readFileSync(join(f.codex, path), 'utf8'), '{broken');
});
test('failure after branch creation retains branch and immutable manifest for explicit resume', () => {
  const f = fixture({failFinal: true}), first = start(f.codex, request('retry'));
  assert.equal(first.code, 'PREFLIGHT_BLOCKED'); assert.equal(first.branchCreated, true);
  const manifest = readFileSync(join(f.codex, `.tmp-baba/start/tasks/${first.taskId}.json`), 'utf8');
  put(f.codex, '.tmp-baba/allow-final', 'yes'); const second = start(f.codex, ['--resume', first.taskId]);
  assert.equal(second.status, 'RESUMED'); assert.equal(second.branch, first.branch);
  assert.equal(readFileSync(join(f.codex, `.tmp-baba/start/tasks/${first.taskId}.json`), 'utf8'), manifest);
  assert.ok(existsSync(join(f.codex, first.savedAs)));
});
test('record junction escape and active checkout hooks are rejected without external writes', () => {
  const f = fixture(), outside = join(f.dir, 'outside'); mkdirSync(outside); mkdirSync(join(f.codex, '.tmp-baba'));
  symlinkSync(outside, join(f.codex, '.tmp-baba/start'), 'junction'); const before = refs(f.main);
  assert.equal(start(f.codex, request()).status, 'BLOCKED'); assert.deepEqual(readdirSync(outside), []); assert.equal(refs(f.main), before);
  const other = fixture(), hooks = resolve(other.main, gitOut(other.main, ['rev-parse', '--git-path', 'hooks']));
  put(hooks, 'post-checkout', '#!/bin/sh\nexit 1\n'); assert.equal(start(other.codex, request()).code, 'ACTIVE_GIT_HOOK');
});
test('completed integrated task permits next task from latest local main, without deleting previous refs', () => {
  const f = fixture(), first = start(f.codex, request()); const progress = commit(f.codex, 'app/a.ts', 'completed\n');
  // This merge occurs ONLY in the isolated fixture, never in a real worktree.
  git(f.main, ['merge', '--ff-only', first.branch]);
  const next = start(f.codex, request('next', 'app/b.ts')); assert.equal(next.status, 'STARTED');
  assert.equal(next.baseSha, progress); assert.notEqual(next.branch, first.branch);
  assert.equal(gitOut(f.main, ['rev-parse', first.branch]), progress);
});
test('missing registered worktree cannot silently bypass conflict inspection', () => {
  const f = fixture(); renameSync(f.claude, join(f.dir, 'moved-claude'));
  assert.equal(start(f.codex, request()).code, 'OTHER_WORKTREE_UNVERIFIED');
});
test('rename source conflicts are protected for both staged and committed changes', () => {
  const f = fixture(); git(f.claude, ['mv', 'app/a.ts', 'app/renamed.ts']);
  assert.equal(start(f.codex, request()).code, 'WORKTREE_CONFLICT');
  git(f.claude, ['commit', '-m', 'rename fixture']);
  assert.equal(start(f.codex, request()).code, 'WORKTREE_CONFLICT');
});
test('unfinished Git operation is preserved even when status is clean', () => {
  const f = fixture(), path = resolve(f.codex, gitOut(f.codex, ['rev-parse', '--git-path', 'CHERRY_PICK_HEAD']));
  writeFileSync(path, `${f.seed}\n`); assert.equal(start(f.codex, request()).code, 'GIT_OPERATION_IN_PROGRESS');
  assert.equal(readFileSync(path, 'utf8'), `${f.seed}\n`);
});
test('only a current checked Handoff permits a new unrelated task before integration', () => {
  const f = fixture(), first = start(f.codex, request()); commit(f.codex, 'app/a.ts', 'completed feature\n');
  put(f.codex, '.tmp-baba/verify/latest.json', JSON.stringify({root: f.codex, fingerprint: stateFingerprint(f.codex),
    verdict: 'PASS', checks: [], gaps: [], generatedAt: new Date().toISOString()}));
  const out = `docs/handoffs/${first.branch.replace('/', '-')}.md`;
  const draft = run(process.execPath, [join(f.codex, 'scripts/agent/baba-handoff.mjs'), '--task-name', 'alpha', '--out', out], {cwd: f.codex});
  assert.equal(draft.status, 0);
  const text = readFileSync(join(f.codex, out), 'utf8').replace(/<!-- TODO[\s\S]*?-->/g, 'isolated fixture checked');
  // Verify the Windows CRLF completion path too. This synthetic report is confined to the fixture.
  put(f.codex, out, text.replace(/\n/g, '\r\n'));
  git(f.codex, ['add', '--', out]); git(f.codex, ['commit', '-m', 'fixture handoff']);
  const r = start(f.codex, request('next', 'app/b.ts')); assert.equal(r.status, 'STARTED');
  assert.equal(r.baseSha, f.seed); assert.equal(head(f.main), f.seed);
  assert.ok(gitOut(f.main, ['rev-parse', first.branch]));
});
test('missing option values and positional arguments fail before any side effects', () => {
  const f = fixture(), before = refs(f.main);
  for (const extra of [['--resume'], ['--resume='], ['unexpected'], ['--files', '--json']]) {
    const r = run(process.execPath, [join(f.codex, 'scripts/agent/baba-start.mjs'), ...request(), ...extra], {cwd: f.codex, allowFail: true});
    assert.equal(r.status, 2); assert.equal(refs(f.main), before);
    assert.equal(existsSync(join(f.codex, '.tmp-baba/start')), false);
  }
});
