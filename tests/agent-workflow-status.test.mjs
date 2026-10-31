import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {git, gitOut, identifyWorktree, insideRoot, run, sanitizedEnv} from '../scripts/agent/lib/common.mjs';
import {collectStatus} from '../scripts/agent/baba-status.mjs';
import {detectTerminal, displayWidth, renderStatus, stripAnsi} from '../scripts/agent/lib/status-view.mjs';

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
function fixture({mainName = 'baba-staff-app'} = {}) {
  const dir = mkdtempSync(join(fixtures, '한글 space-'));
  created.push(dir);
  const main = join(dir, mainName), codex = join(dir, 'baba-wt-codex'), claude = join(dir, 'baba-wt-claude');
  const remote = join(dir, 'origin.git');
  mkdirSync(main); git(main, ['init', '-b', 'main']);
  git(main, ['config', 'user.email', 'fixture@example.invalid']); git(main, ['config', 'user.name', 'Fixture']);
  git(main, ['init', '--bare', remote]);
  cpSync(join(source, 'scripts/agent'), join(main, 'scripts/agent'), {recursive: true});
  cpSync(join(source, 'baba-status.cmd'), join(main, 'baba-status.cmd'));
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
// Child output is piped, so the default view must be plain text unless color is forced.
const plainEnv = (extra = {}) => {
  const env = {...sanitizedEnv().env, ...extra};
  for (const name of ['FORCE_COLOR', 'NO_COLOR', 'CI', 'WT_SESSION', 'TERM_PROGRAM']) if (!(name in extra)) delete env[name];
  return env;
};
function cli(f, args = [], cwd = f.main, env = {}) {
  const result = run(process.execPath, [join(f.main, 'scripts/agent/baba-status.mjs'), ...args], {cwd, env: plainEnv(env), allowFail: true, timeout: 120000});
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
  assert.doesNotMatch(result.stdout, /\x1b\[/);
  assert.match(result.stdout, /\| main +\| [0-9a-f]{7} \| main +\| CLEAN +\| +- \| +- \|/);
  assert.match(result.stdout, /\| Claude +\| [0-9a-f]{7} \| claude\/ready-fixture +\| CLEAN +\| +0 \| +0 \|/);
  assert.match(result.stdout, /\| Codex +\| [0-9a-f]{7} \| codex\/ready-fixture +\| CLEAN +\| +0 \| +0 \|/);
  assert.match(result.stdout, /\| 원격 확인 +\| 성공 +\|/);
  assert.match(result.stdout, /\| 동기화 +\| 동기화됨 +\|/);
  assert.match(result.stdout, /\| 활성 Worktree 통합 \| PASS +\|\n\| 기타 로컬 브랜치 +\| 정상 +\|\n\| Git 상태 +\| PASS +\|/);
  assert.match(result.stdout, /\| GitHub Push +\| 대기 0, Push 불필요 +\|/);
  assert.match(result.stdout, /\| 테스트\/보안 검증 +\| Git 검사와 별개/);
  assert.doesNotMatch(result.stdout, /기타 로컬 브랜치의 통합을 뜻하지 않는다/);
  assert.match(result.stdout, /\| 배포 승인 +\| 별도 필요 +\|/);
  assert.match(result.stdout, /실행 위치 {2}main \/ main → 직렬 모드/);
});

test('a same-named detached QA worktree is never the original, even when the original has another name', () => {
  for (const mainName of ['baba-staff-app', 'renamed-original']) {
    const f = fixture({mainName});
    const qa = join(f.dir, 'qa', 'baba-staff-app');
    git(f.main, ['worktree', 'add', '--detach', qa, 'main']);
    commit(f.main, 'app/a.ts', 'export const a = 2;\n', 'one pending commit');
    const before = snapshot(f.dir);
    assert.equal(identifyWorktree(f.main).isOriginal, true);
    assert.equal(identifyWorktree(qa).isOriginal, false);
    for (const root of [f.main, qa, f.codex]) {
      const report = collectStatus({root, cwd: root});
      assert.deepEqual(report.trees.filter(item => item.role === 'main').map(item => item.path), [f.main]);
      const extra = report.trees.find(item => item.path === qa);
      assert.equal(extra.role, 'other');
      assert.equal(extra.branch, '(detached)');
      assert.equal(report.verdicts.git, 'WARN', 'the extra worktree is a warning, not a false FAIL');
      assert.ok(!report.findings.some(item => item.level === 'FAIL'));
      assert.equal(report.github.verified, true);
      assert.equal(report.github.ahead, 1);
      assert.equal(report.github.relation, 'local-ahead');
    }
    const result = cli(f, ['--no-color']);
    assert.match(result.stdout, /대기 1커밋, Push 가능\(사용자 승인 필요\)/);
    assert.doesNotMatch(result.stdout, /Push 보류|원본 폴더가 main이 아닌/);
    assert.equal((result.stdout.match(/\| main +\| [0-9a-f]{7} \| main +\|/g) || []).length, 1);
    assert.deepEqual(snapshot(f.dir), before, 'status and identity checks change no files, index or refs');

    git(f.main, ['switch', '-c', 'feature/original']);
    const wrongBranch = snapshot(f.dir);
    const failed = cli(f, ['--json']);
    assert.equal(failed.status, 2);
    assert.equal(failed.report.verdicts.git, 'FAIL');
    assert.ok(finding(failed.report, 'main', /main이 아닌 feature\/original/));
    assert.equal(failed.report.trees.filter(item => item.role === 'main').length, 1);
    assert.deepEqual(snapshot(f.dir), wrongBranch);
  }
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
  assert.match(out, /\| 동기화 +\| Push 대기 2커밋 +\|/);
  assert.match(out, /\| GitHub Push +\| 대기 2커밋, Push 가능\(사용자 승인 필요\) +\|/);
});

test('6. unreachable remote is marked unverified; remote HEAD mismatch and divergence are detected', () => {
  const f = fixture();
  git(f.main, ['remote', 'set-url', 'origin', join(f.dir, 'missing.git')]);
  let report = status(f);
  assert.equal(report.github.verified, false);
  assert.equal(report.github.relation, 'equal');
  assert.ok(finding(report, 'GitHub', /원격 상태 미확인/));
  assert.match(cli(f).stdout, /\| 원격 확인 +\| 실패\(원격 연결 실패\), 마지막 fetch 기준 +\|/);
  assert.match(cli(f, ['--offline']).stdout, /\| 원격 확인 +\| 생략\(--offline\), 마지막 fetch 기준 +\|/);
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

// Display: every border of a table block sits in the same terminal column, counting Hangul as two cells.
function borderColumns(line) {
  const columns = [];
  let width = 0;
  for (const char of line) {
    if ('|+┌┬┐├┼┤└┴┘│'.includes(char)) columns.push(width);
    width += displayWidth(char);
  }
  return columns;
}
function assertAligned(text) {
  const blocks = [];
  let current = null;
  for (const line of stripAnsi(text).split('\n')) {
    if (/^[|+┌├└│]/.test(line)) (current ||= blocks[blocks.push([]) - 1]).push(line);
    else current = null;
  }
  assert.ok(blocks.length >= 3, 'worktree, GitHub and result tables');
  for (const block of blocks) {
    const expected = borderColumns(block[0]);
    for (const line of block) assert.deepEqual(borderColumns(line), expected, `${line}\n${block[0]}`);
    assert.equal(new Set(block.map(displayWidth)).size, 1);
  }
}
function koreanFixture() {
  const f = fixture();
  git(f.claude, ['switch', '--no-track', '-c', 'claude/20261026-한글-정렬-01']);
  commit(f.claude, 'app/한글 파일.ts', 'export {};\n', '한글 커밋 제목');
  put(f.codex, 'app/a.ts', 'dirty\n');
  return f;
}

test('display width counts Hangul as two cells and ignores ANSI codes', () => {
  assert.equal(displayWidth('abc'), 3);
  assert.equal(displayWidth('한글'), 4);
  assert.equal(displayWidth('main 대비 뒤처짐'), 16);
  assert.equal(displayWidth('\x1b[32m통과\x1b[0m'), 4);
});

test('Korean branches and labels keep table borders aligned in Unicode and ASCII layouts', () => {
  const f = koreanFixture();
  const report = status(f);
  for (const unicode of [true, false]) {
    for (const color of [true, false]) assertAligned(renderStatus(report, {unicode, color}));
  }
  const ascii = renderStatus(report, {unicode: false});
  assert.match(ascii, /\| Claude +\| [0-9a-f]{7} \| claude\/20261026-한글-정렬-01 \| CLEAN +\| +1 \|/);
  assert.match(ascii, /\| Codex +\| [0-9a-f]{7} \| codex\/ready-fixture +\| DIRTY\(1\) +\|/);
  assert.match(ascii, /\+ [0-9a-f]{7} 한글 커밋 제목/);
  assert.doesNotMatch(ascii, /[┌│─]/);
  assert.match(renderStatus(report, {unicode: true}), /┌─+┬/);
});

test('colors mark status but the plain text is identical without ANSI', () => {
  const f = koreanFixture();
  const report = status(f);
  const colored = renderStatus(report, {color: true, unicode: false});
  const plain = renderStatus(report, {color: false, unicode: false});
  assert.doesNotMatch(plain, /\x1b\[/);
  assert.equal(stripAnsi(colored), plain);
  assert.match(colored, /\x1b\[32mCLEAN/);
  assert.match(colored, /\x1b\[33mDIRTY\(1\)/);
  assert.match(colored, /\x1b\[33mWARN 검토 필요/);
  assert.match(colored, /\x1b\[36mclaude\/20261026-한글-정렬-01/);
  assert.match(colored, /\x1b\[33m\[WARN\]/);
  git(f.main, ['switch', '-c', 'feature']);
  const failed = renderStatus(status(f), {color: true, unicode: false});
  assert.match(failed, /\x1b\[31m\[FAIL\]/);
  assert.match(failed, /\x1b\[31m대기 0커밋, Push 보류\(Git 상태 FAIL\)/);
});

test('terminal detection: no color for CI, redirects, NO_COLOR or dumb terminals; ASCII borders in legacy Windows console', () => {
  const tty = {isTTY: true, columns: 120, hasColors: () => true};
  assert.deepEqual(detectTerminal({stream: tty, env: {WT_SESSION: 'x'}, platform: 'win32'}), {color: true, unicode: true, columns: 120});
  assert.deepEqual(detectTerminal({stream: tty, env: {}, platform: 'win32'}), {color: true, unicode: false, columns: 120});
  assert.equal(detectTerminal({stream: tty, env: {CI: 'true'}, platform: 'win32'}).color, false);
  assert.equal(detectTerminal({stream: tty, env: {NO_COLOR: '1', FORCE_COLOR: '1'}, platform: 'win32'}).color, false);
  assert.equal(detectTerminal({stream: tty, env: {TERM: 'dumb'}, platform: 'linux'}).color, false);
  assert.equal(detectTerminal({stream: {isTTY: true, columns: 80, hasColors: () => false}, env: {}, platform: 'win32'}).color, false);
  assert.deepEqual(detectTerminal({stream: {isTTY: false}, env: {}, platform: 'win32'}), {color: false, unicode: false, columns: null});
  assert.equal(detectTerminal({stream: {isTTY: false}, env: {FORCE_COLOR: '1'}, platform: 'win32'}).color, true);
});

test('narrow terminals switch to a compact layout without table borders', () => {
  const f = koreanFixture();
  const report = status(f);
  const wide = renderStatus(report, {unicode: false, columns: 200});
  const narrow = renderStatus(report, {unicode: false, columns: 60});
  assert.match(wide, /^\+-+\+/m);
  assert.doesNotMatch(narrow, /^[+|]/m);
  assert.match(narrow, /^Claude +CLEAN [0-9a-f]{7} {2}미통합 1 · 뒤처짐 0 · ahead 1$/m);
  assert.match(narrow, /^ {7}claude\/20261026-한글-정렬-01$/m);
  assert.match(narrow, /^ {2}활성 Worktree 통합 +WARN 검토 필요$/m);
  for (const line of narrow.split('Worktree 상세\n')[1].split('\n').slice(0, 6)) assert.ok(displayWidth(line) <= 60, line);
});

test('other local branches are reviewed separately from active worktree integration', () => {
  const f = fixture();
  git(f.main, ['switch', '-q', '-c', 'old/parked']); commit(f.main, 'old.txt', 'x\n'); git(f.main, ['switch', '-q', 'main']);
  const result = cli(f);
  const plain = result.stdout;
  assert.equal(result.status, 0, 'parked branches do not change the exit code');
  assert.match(plain, /\| 활성 Worktree 통합 \| PASS +\|\n\| 기타 로컬 브랜치 +\| 검토 필요 1개 +\|/);
  assert.match(plain, /활성 Worktree 통합은 main·Claude·Codex만 판정한다\. 기타 로컬 브랜치의 통합을 뜻하지 않는다\./);
  assert.match(plain, /\[INFO\] 기타 로컬 브랜치 1개가 main에 미통합이다\. 필요·중복·폐기 여부를 검토한다 \(목록: baba-status --branches\)\./);
  assert.doesNotMatch(plain, /old\/parked/);
  assert.match(cli(f, ['--branches']).stdout, /검토한다\.\n {7}old\/parked/);
  assertAligned(plain);
  const report = cli(f, ['--json']).report;
  assert.deepEqual(report.parked, ['old/parked']);
  assert.equal(report.verdicts.integration, 'PASS');
  assert.equal(report.verdicts.overall, 'PASS');
  const colored = renderStatus(status(f), {color: true, unicode: false});
  assert.match(colored, /\x1b\[33m검토 필요 1개/);
  assert.match(colored, /\x1b\[32m정상|\x1b\[32mPASS/);
});

test('--json keeps the previous fields and stays free of ANSI codes', () => {
  const f = koreanFixture();
  const {report, stdout} = cli(f, ['--json'], f.main, {FORCE_COLOR: '1'});
  assert.doesNotMatch(stdout, /\x1b\[/);
  for (const key of ['tool', 'readOnly', 'generatedAt', 'root', 'location', 'requestedMode', 'main', 'trees', 'github', 'findings', 'verdicts', 'notCovered']) assert.ok(key in report, key);
  assert.deepEqual(Object.keys(report.trees[0]).sort(), ['agent', 'behind', 'branch', 'changed', 'clean', 'conflicted', 'exists', 'handoff', 'head', 'label', 'operation', 'path', 'role', 'unintegrated', 'untracked', 'waiting']);
  assert.deepEqual(Object.keys(report.verdicts).sort(), ['git', 'github', 'integration', 'overall']);
  assert.ok(report.findings.some(item => item.target === 'Codex' && /미커밋 변경/.test(item.cause)));
});

test('Windows CMD: baba-status.cmd prints the table, honors color settings and returns the exit code', {skip: process.platform !== 'win32'}, () => {
  const f = koreanFixture();
  const cmd = (args, extra = {}) => {
    const env = plainEnv(extra);
    delete env.NoDefaultCurrentDirectoryInExePath;
    return run('cmd.exe', ['/d', '/c', `baba-status ${args}`], {cwd: f.main, env, allowFail: true, timeout: 120000});
  };
  const plain = cmd('--offline');
  assert.equal(plain.status, 1, plain.stderr);
  assert.doesNotMatch(plain.stdout, /\x1b\[/);
  assert.match(plain.stdout, /\| Claude +\| [0-9a-f]{7} \| claude\/20261026-한글-정렬-01 \|/);
  assertAligned(plain.stdout.replace(/\r\n/g, '\n'));
  const colored = cmd('--offline', {FORCE_COLOR: '1'});
  assert.match(colored.stdout, /\x1b\[32mCLEAN/);
  assert.equal(stripAnsi(colored.stdout).replace(/\d\d:\d\d/, ''), plain.stdout.replace(/\d\d:\d\d/, ''));
  assert.doesNotMatch(cmd('--offline --no-color', {FORCE_COLOR: '1'}).stdout, /\x1b\[/);
  assert.doesNotMatch(cmd('--offline', {FORCE_COLOR: '1', NO_COLOR: '1'}).stdout, /\x1b\[/);
  assert.equal(cmd('--mode parallel --offline').status, 2);
  assert.equal(JSON.parse(cmd('--offline --json').stdout).trees.length, 3);
});

test('relationship graph shows the shared fork and advances the Worktree pointer without changing main',()=>{
  const f=fixture();const a=gitOut(f.main,['rev-parse','HEAD']);
  const b=commit(f.main,'shared.txt','b\n');git(f.codex,['switch','--no-track','-c','codex/graph-fixture',b]);
  const c=commit(f.main,'main-only.txt','c\n');
  const d=commit(f.codex,'candidate.txt','d\n');const e=commit(f.codex,'candidate.txt','e\n');
  let report=status(f,{offline:true});let relation=report.relationships.find(r=>r.path===f.codex);
  assert.deepEqual(relation.bases,[b]);assert.deepEqual(relation.shared,[a,b]);assert.equal(relation.ahead,2);assert.equal(relation.behind,1);
  let view=renderStatus(report,{unicode:false});
  assert.ok(view.indexOf('요약')<view.indexOf('main 기준 브랜치 관계도'));assert.ok(view.indexOf('main 기준 브랜치 관계도')<view.indexOf('Worktree 상세'));
  assert.ok(view.includes([a,b,c].map(s=>s.slice(0,7)).join(' -- ')));
  assert.ok(view.includes([a,b,d,e].map(s=>s.slice(0,7)).join(' -- ')));assert.match(view,/\^ codex\/graph-fixture/);
  const next=commit(f.codex,'candidate.txt','f\n');report=status(f,{offline:true});view=renderStatus(report,{unicode:false});
  assert.ok(view.includes([a,b,d,e,next].map(s=>s.slice(0,7)).join(' -- ')));assert.equal(gitOut(f.main,['rev-parse','HEAD']),c);
});

test('relationship graph retains merge edges and identifies detached and shared HEADs',()=>{
  const f=fixture();const initial=status(f,{offline:true});assert.match(renderStatus(initial,{unicode:false}),/같은 HEAD/);
  const seed=gitOut(f.main,['rev-parse','HEAD']);commit(f.main,'main-only.txt','main\n');commit(f.codex,'candidate.txt','work\n');
  git(f.codex,['merge','--no-edit','main']);git(f.claude,['switch','--detach',seed]);
  const report=status(f,{offline:true});const detached=report.relationships.find(r=>r.path===f.claude);assert.equal(detached.detached,true);
  const view=renderStatus(report,{unicode:false});assert.match(view,/merge 포함 \/ 실제 Git 연결선/);assert.match(view,/\[detached HEAD\]/);
  assert.ok(view.includes(gitOut(f.codex,['rev-parse','HEAD']).slice(0,7)));
});
