import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import test from 'node:test';
import {createBaseline} from '../scripts/agent/lib/baseline.mjs';
import {insideRoot, sanitizedEnv, stateFingerprint} from '../scripts/agent/lib/common.mjs';

const source = process.cwd();
const parent = join(source, '.tmp-baba', 'safety-fixtures');
mkdirSync(parent, {recursive: true});
const {env} = sanitizedEnv();
const git = (root, ...args) => {
  const result = spawnSync('git', ['--no-optional-locks', '-C', root, ...args], {env, encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
const run = (root, script, ...args) => spawnSync(process.execPath, [join(root, 'scripts/agent', script), ...args], {cwd: root, env, encoding: 'utf8', timeout: 60000});
function fixture() {
  const container = mkdtempSync(join(parent, 'run-'));
  const root = join(container, 'baba-wt-codex');
  mkdirSync(root);
  cpSync(join(source, 'scripts/agent'), join(root, 'scripts/agent'), {recursive: true});
  mkdirSync(join(root, 'node_modules'));
  writeFileSync(join(root, 'node_modules/sentinel'), 'dependency data');
  mkdirSync(join(root, 'tests'));
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n.tmp-baba/\n');
  writeFileSync(join(root, 'tests/regression.test.mjs'), "import test from 'node:test'; import assert from 'node:assert/strict'; test('same name',()=>assert.equal(1,2));\n");
  git(root, 'init', '-b', 'codex/fixture');
  git(root, 'add', '.');
  git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=NUL', 'commit', '-m', 'isolated baseline');
  git(root, 'branch', 'main');
  return root;
}

test('private baseline junction cleanup preserves real dependencies and other concurrent snapshots', () => {
  const root = fixture();
  const sha = git(root, 'rev-parse', 'HEAD');
  const first = createBaseline(root, sha, env);
  const second = createBaseline(root, sha, env);
  assert.notEqual(first.dir, second.dir);
  assert.ok(lstatSync(join(first.dir, 'node_modules')).isSymbolicLink());
  first.release();
  first.release();
  assert.equal(existsSync(join(first.dir, 'node_modules')), false);
  assert.ok(lstatSync(join(second.dir, 'node_modules')).isSymbolicLink());
  assert.equal(readFileSync(join(root, 'node_modules/sentinel'), 'utf8'), 'dependency data');
  second.release();
  assert.equal(readFileSync(join(root, 'node_modules/sentinel'), 'utf8'), 'dependency data');
});

test('cleanup refuses a replacement real directory and retains its sentinel', () => {
  const root = fixture();
  const snapshot = createBaseline(root, git(root, 'rev-parse', 'HEAD'), env);
  const link = join(snapshot.dir, 'node_modules');
  unlinkSync(link);
  mkdirSync(link);
  writeFileSync(join(link, 'sentinel'), 'do not delete');
  assert.throws(snapshot.release, /refusing cleanup/);
  assert.equal(readFileSync(join(link, 'sentinel'), 'utf8'), 'do not delete');
  assert.equal(readFileSync(join(root, 'node_modules/sentinel'), 'utf8'), 'dependency data');
});

test('path validation rejects traversal and junction escapes', () => {
  const root = fixture();
  assert.throws(() => insideRoot(root, '../other/file.md'), /inside/);
  const outside = mkdtempSync(join(parent, 'outside-'));
  symlinkSync(outside, join(root, 'escape'), 'junction');
  assert.throws(() => insideRoot(root, 'escape/new.md'), /outside/);
  unlinkSync(join(root, 'escape'));
  symlinkSync(join(outside, 'missing'), join(root, 'dangling'), 'junction');
  assert.throws(() => insideRoot(root, 'dangling/new.md'));
  unlinkSync(join(root, 'dangling'));
});

test('verify distinguishes multiline changed assertions with identical test names and rejects missing explicit tests', () => {
  const root = fixture();
  writeFileSync(join(root, 'tests/regression.test.mjs'), "import test from 'node:test'; import assert from 'node:assert/strict'; test('same name',()=>assert.deepEqual({value:1},{value:2}));\n");
  git(root, 'add', 'tests/regression.test.mjs');
  git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=NUL', 'commit', '-m', 'multiline failure baseline');
  writeFileSync(join(root, 'tests/regression.test.mjs'), "import test from 'node:test'; import assert from 'node:assert/strict'; test('same name',()=>assert.deepEqual({value:1},{value:3}));\n");
  const result = run(root, 'baba-verify.mjs', '--base', 'HEAD', '--tests', 'tests/regression.test.mjs', '--skip-lint', '--skip-tsc', '--json');
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  const regression = report.checks.find(check => check.name === '회귀 테스트');
  assert.deepEqual(regression.newFailures, ['tests/regression.test.mjs']);
  assert.equal(regression.files[0].classification, 'new');
  assert.equal(readFileSync(join(root, 'node_modules/sentinel'), 'utf8'), 'dependency data');
  assert.equal(existsSync(join(report.baselineDir, 'node_modules')), false);
  const missing = run(root, 'baba-verify.mjs', '--tests', 'tests/missing.test.mjs', '--skip-lint', '--skip-tsc');
  assert.notEqual(missing.status, 0);
});

test('handoff cannot escape docs/handoffs or overwrite an existing artifact, including force', () => {
  const root = fixture();
  const out = 'docs/handoffs/protected.md';
  mkdirSync(join(root, 'docs/handoffs'), {recursive: true});
  writeFileSync(join(root, out), 'preserve original');
  for (const extra of [[], ['--force']]) {
    const result = run(root, 'baba-handoff.mjs', '--task-name', 'fixture', '--out', out, ...extra);
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(join(root, out), 'utf8'), 'preserve original');
  }
  for (const outPath of ['../escape.md', 'AGENTS.md', 'docs/handoffs/../../escape.md']) {
    assert.notEqual(run(root, 'baba-handoff.mjs', '--task-name', 'fixture', '--out', outPath).status, 0);
  }
});

test('handoff check recomputes current fingerprint instead of trusting a saved success sentence', () => {
  const root = fixture();
  const fingerprint = stateFingerprint(root);
  mkdirSync(join(root, '.tmp-baba/verify'), {recursive: true});
  writeFileSync(join(root, '.tmp-baba/verify/latest.json'), JSON.stringify({root, fingerprint, verdict: 'PASS', checks: [], gaps: [], generatedAt: new Date().toISOString()}));
  const out = 'docs/handoffs/complete.md';
  const draft = run(root, 'baba-handoff.mjs', '--task-name', 'fixture', '--out', out);
  assert.equal(draft.status, 0, draft.stderr + draft.stdout);
  const full = join(root, out);
  writeFileSync(full, readFileSync(full, 'utf8').replace(/<!-- TODO[\s\S]*?-->/g, 'fixture checked'));
  assert.equal(run(root, 'baba-handoff.mjs', '--check', out).status, 0);
  writeFileSync(join(root, 'tests/regression.test.mjs'), '// changed after verification\n');
  const changed = run(root, 'baba-handoff.mjs', '--check', out);
  assert.notEqual(changed.status, 0);
  assert.match(changed.stdout, /지문/);
});

test('verify refuses environment files without reading their values', () => {
  const root = fixture();
  writeFileSync(join(root, '.env.local'), 'LOCAL_FIXTURE=do-not-print-fixture-value');
  const result = run(root, 'baba-verify.mjs', '--skip-lint', '--skip-tsc');
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout + result.stderr, /do-not-print-fixture-value/);
  assert.match(result.stderr, /Environment files/);
});
