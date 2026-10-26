import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {git, gitOut, insideRoot, run, sanitizedEnv} from '../scripts/agent/lib/common.mjs';
import {collectStatus} from '../scripts/agent/baba-status.mjs';

// Every scenario runs in a disposable local repository with a local bare "origin".
const source = resolve(fileURLToPath(new URL('..', import.meta.url)));
const fixtures = insideRoot(source, '.tmp-baba/status-fixtures');
mkdirSync(fixtures, {recursive: true});
const created = [];
test.after(() => { for (const dir of created) rmSync(dir, {recursive: true, force: true}); });

function put(root, path, text) {
  const full = join(root, path);
  mkdirSync(resolve(full, '..'), {recursive: true});
  writeFileSync(full, text);
}
function commit(root, path, text, message = 'fixture') {
  put(root, path, text); git(root, ['add', '--', path]); git(root, ['commit', '-m', message]);
  return gitOut(root, ['rev-parse', 'HEAD']);
}
function fixture() {
  const dir = mkdtempSync(join(fixtures, '한글 space-'));
  created.push(dir);
  const main = join(dir, 'baba-staff-app'), codex = join(dir, 'baba-wt-codex'), claude = join(dir, 'baba-wt-claude');
  const remote = join(dir, 'origin.git');
  mkdirSync(main); git(main, ['init', '-b', 'main']);
  git(main, ['config', 'user.email', 'fixture@example.invalid']); git(main, ['config', 'user.name', 'Fixture']);
  git(main, ['init', '--bare', remote]);
  cpSync(join(source, 'scripts/agent'), join(main, 'scripts/agent'), {recursive: true});
  put(main, '.gitignore', '.tmp-baba/\nnode_modules/\n');
  put(main, 'app/a.ts', 'export const a = 1;\n');
  git(main, ['add', '.']); git(main, ['commit', '-m', 'seed']);
  git(main, ['remote', 'add', 'origin', remote]); git(main, ['push', '-u', 'origin', 'main']);
  git(main, ['worktree', 'add', '--no-track', '-b', 'codex/ready-fixture', codex, 'main']);
  git(main, ['worktree', 'add', '--no-track', '-b', 'claude/ready-fixture', claude, 'main']);
  return {dir, main, codex, claude, remote};
}
const status = (f, options = {}) => collectStatus({root: f.main, cwd: f.main, ...options});
const tree = (report, label) => report.trees.find(item => item.label === label);
const finding = (report, target, pattern) => report.findings.find(item => item.target === target && pattern.test(item.cause));
function cli(f, args = [], cwd = f.main) {
  const result = run(process.execPath, [join(f.main, 'scripts/agent/baba-status.mjs'), ...args], {cwd, env: sanitizedEnv().env, allowFail: true, timeout: 120000});
  return {...result, report: args.includes('--json') ? JSON.parse(result.stdout) : null};
}
function snapshot(dir) {
  const files = {};
  const walk = path => {
    for (const entry of readdirSync(path, {withFileTypes: true})) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) walk(full);
      else files[full] = `${statSync(full).size}:${createHash('sha256').update(readFileSync(full)).digest('hex')}`;
    }
  };
  walk(dir);
  return files;
}

test('1. clean and integrated worktrees pass every Git check but never claim test or deploy approval', () => {
  const f = fixture();
  const result = cli(f);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /main {4}CLEAN/);
  assert.match(result.stdout, /Claude {2}CLEAN .* 미통합 0/);
  assert.match(result.stdout, /Codex {3}CLEAN .* 미통합 0/);
  assert.match(result.stdout, /GitHub {2}동기화됨 .*원격 직접 확인/);
  assert.match(result.stdout, /통합 검사: PASS\nGit 상태: PASS/);
  assert.match(result.stdout, /테스트·보안 검증: 이 도구 범위 아님/);
  assert.match(result.stdout, /배포 승인: 별도 필요/);
  assert.match(result.stdout, /실행 위치 {2}main \/ main → 직렬 모드/);
});

test('2. uncommitted Claude edits are listed with staged, modified and untracked files', () => {
  const f = fixture();
  put(f.claude, 'app/a.ts', 'export const a = 2;\n');
  put(f.claude, 'app/new.ts', 'export {};\n');
  put(f.claude, 'app/staged.ts', 'export {};\n'); git(f.claude, ['add', 'app/staged.ts']);
  const report = status(f);
  const claude = tree(report, 'Claude');
  assert.equal(claude.clean, false);
  assert.deepEqual(claude.changed.sort(), ['A app/staged.ts', 'M app/a.ts']);
  assert.deepEqual(claude.untracked, ['app/new.ts']);
  assert.ok(finding(report, 'Claude', /미커밋 변경 3건/));
  assert.equal(report.verdicts.integration, 'WARN');
});

test('3. a clean Codex worktree with commits missing from main is not reported as integrated', () => {
  const f = fixture();
  git(f.codex, ['switch', '--no-track', '-c', 'codex/20261026-task-01']);
  const sha = commit(f.codex, 'app/a.ts', 'export const a = 3;\n', 'codex work');
  let report = status(f);
  const codex = tree(report, 'Codex');
  assert.equal(codex.clean, true);
  assert.deepEqual(codex.unintegrated.map(c => [c.sha, c.subject, c.equivalent]), [[sha, 'codex work', false]]);
  assert.ok(finding(report, 'Codex', /커밋 1개 — 인계서가 없다/));
  assert.equal(report.verdicts.integration, 'WARN');
  assert.match(cli(f).stdout, /\+ [0-9a-f]{7} codex work/);

  commit(f.codex, 'docs/handoffs/codex-20261026-task-01.md', '# handoff\n');
  report = status(f);
  assert.ok(finding(report, 'Codex', /인계서가 있다/));

  // Same patch already on main: flagged as a probable duplicate, still for review.
  git(f.main, ['cherry-pick', sha]);
  git(f.main, ['cherry-pick', gitOut(f.codex, ['rev-parse', 'HEAD'])]);
  report = status(f);
  assert.ok(finding(report, 'Codex', /패치 동일/));
  assert.ok(tree(report, 'Codex').unintegrated.every(c => c.equivalent));
});

test('4. worktrees older than main are reported; unintegrated work behind main needs re-verification', () => {
  const f = fixture();
  commit(f.main, 'app/a.ts', 'export const a = 4;\n');
  let report = status(f);
  assert.equal(tree(report, 'Claude').behind, 1);
  assert.equal(finding(report, 'Claude', /1커밋 오래됨/).level, 'INFO');
  assert.equal(report.verdicts.integration, 'PASS');

  git(f.codex, ['switch', '--no-track', '-c', 'codex/20261026-old-01']);
  commit(f.codex, 'app/b.ts', 'export {};\n');
  report = status(f);
  assert.equal(finding(report, 'Codex', /main이 1커밋 앞서/).level, 'WARN');
});

test('5. main committed but not pushed shows pending push commits', () => {
  const f = fixture();
  commit(f.main, 'app/a.ts', 'export const a = 5;\n');
  commit(f.main, 'app/a.ts', 'export const a = 6;\n');
  const report = status(f);
  assert.equal(report.github.relation, 'local-ahead');
  assert.equal(report.github.ahead, 2);
  assert.equal(report.github.verified, true);
  const out = cli(f).stdout;
  assert.match(out, /GitHub {2}Push 대기 2커밋/);
  assert.match(out, /Push 전 검토: 필요\(2커밋/);
});

test('6. unreachable remote is marked unverified; remote HEAD mismatch and divergence are detected', () => {
  const f = fixture();
  git(f.main, ['remote', 'set-url', 'origin', join(f.dir, 'missing.git')]);
  let report = status(f);
  assert.equal(report.github.verified, false);
  assert.equal(report.github.relation, 'equal');
  assert.ok(finding(report, 'GitHub', /원격 상태 미확인/));
  assert.match(cli(f).stdout, /미확인 — 마지막 fetch 기준 추정/);
  assert.equal(status(f, {offline: true}).github.reason, '--offline');

  git(f.main, ['remote', 'set-url', 'origin', f.remote]);
  const publisher = join(f.dir, 'publisher');
  git(f.dir, ['clone', '-q', f.remote, publisher]);
  git(publisher, ['config', 'user.email', 'fixture@example.invalid']); git(publisher, ['config', 'user.name', 'Fixture']);
  commit(publisher, 'remote.txt', 'remote-only\n'); git(publisher, ['push', 'origin', 'HEAD:main']);
  report = status(f);
  assert.equal(report.github.relation, 'remote-ahead');
  assert.equal(report.github.trackingStale, true);
  assert.ok(finding(report, 'GitHub', /로컬에 없는 커밋/));
  assert.ok(finding(report, 'GitHub', /참조.*실제 원격/));

  git(f.main, ['fetch', '-q', 'origin']);
  commit(f.main, 'app/a.ts', 'export const a = 7;\n');
  report = status(f);
  assert.equal(report.github.relation, 'diverged');
  assert.equal(report.verdicts.github, 'FAIL');
});

test('7. wrong worktree paths, branches and modes fail with a reason and an action', () => {
  const f = fixture();
  assert.equal(status(f, {mode: 'serial'}).verdicts.git, 'PASS');
  assert.equal(status(f, {cwd: f.claude, mode: 'parallel'}).location.mode, 'parallel');
  let report = status(f, {mode: 'parallel'});
  assert.ok(finding(report, '실행 위치', /선택한 모드\(병렬\)와 실행 경로가 맞지 않는다/).action.includes('baba-start'));
  assert.ok(finding(status(f, {cwd: f.dir}), '실행 위치', /Worktree 밖/));

  git(f.codex, ['switch', '--no-track', '-c', 'claude/wrong-place']);
  git(f.main, ['switch', '-c', 'feature']);
  const extra = join(f.dir, 'scratch-tree'); git(f.main, ['worktree', 'add', '--no-track', '-b', 'scratch', extra, 'feature']);
  rmSync(f.claude, {recursive: true, force: true});
  report = status(f, {mode: 'serial'});
  assert.ok(finding(report, 'main', /main이 아닌 feature/));
  assert.ok(finding(report, 'Codex', /codex\/ 접두사가 아닌 브랜치/));
  assert.ok(finding(report, 'Claude', /등록된 경로가 없다/));
  assert.ok(finding(report, 'scratch-tree', /추가 Worktree/));
  assert.ok(finding(report, '실행 위치', /선택한 모드\(직렬\)/));
  assert.equal(report.verdicts.git, 'FAIL');
  assert.equal(cli(f).status, 2);
});

test('8. running baba-status changes no HEAD, index, ref or file in any worktree', () => {
  const f = fixture();
  put(f.claude, 'app/a.ts', 'dirty\n');
  git(f.codex, ['switch', '--no-track', '-c', 'codex/20261026-ro-01']); commit(f.codex, 'app/c.ts', 'export {};\n');
  const before = snapshot(f.dir);
  for (const args of [[], ['--json'], ['--offline'], ['--mode', 'parallel']]) cli(f, args);
  cli(f, [], f.codex);
  assert.deepEqual(snapshot(f.dir), before);
});

test('real repository: offline status is read-only and machine-readable', () => {
  const state = () => ['status --porcelain=v1 --untracked-files=all', 'rev-parse HEAD', 'show-ref'].map(cmd => gitOut(source, cmd.split(' '))).join('\n');
  const before = state();
  const result = run(process.execPath, ['scripts/agent/baba-status.mjs', '--offline', '--json'], {cwd: source, env: sanitizedEnv().env, allowFail: true});
  const report = JSON.parse(result.stdout);
  assert.equal(report.readOnly, true);
  assert.ok(report.trees.some(item => item.label === 'main'));
  assert.equal(state(), before);
});
