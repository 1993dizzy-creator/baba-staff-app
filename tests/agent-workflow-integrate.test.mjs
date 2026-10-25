import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {integrate} from '../scripts/agent/baba-integrate.mjs';
import {git, gitOut, insideRoot, run, sanitizedEnv, worktreeEnvironment, writeRecord} from '../scripts/agent/lib/common.mjs';
import {verifyEvidence} from '../scripts/agent/lib/verify-evidence.mjs';

// Everything, including fixture main merges, is confined to the owning source worktree.
const source = resolve(fileURLToPath(new URL('..', import.meta.url)));
const parent = insideRoot(source, '.tmp-baba/integrate-fixtures'); mkdirSync(parent, {recursive: true});
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const put = (root, path, text) => { const full = insideRoot(root, path); mkdirSync(resolve(full, '..'), {recursive: true}); writeFileSync(full, text); };
const head = root => gitOut(root, ['rev-parse', 'HEAD']);
const commit = (root, path, content) => { put(root, path, content); git(root, ['add', '--', path]); git(root, ['commit', '-m', 'fixture']); return head(root); };
const cli = (root, script, args = []) => run(process.execPath, [join(root, 'scripts/agent', script), ...args],
  {cwd: root, env: sanitizedEnv().env, allowFail: true, timeout: 120000});

function fixture({preexisting = false} = {}) {
  const directory = mkdtempSync(join(parent, '한글 space-'));
  const main = join(directory, 'baba-staff-app'), codex = join(directory, 'baba-wt-codex'), claude = join(directory, 'baba-wt-claude');
  mkdirSync(main); git(main, ['init', '-b', 'main']);
  git(main, ['config', 'user.name', 'Fixture']); git(main, ['config', 'user.email', 'fixture@example.invalid']);
  cpSync(join(source, 'scripts/agent'), join(main, 'scripts/agent'), {recursive: true});
  put(main, '.gitignore', '.tmp-baba/\nnode_modules/\n');
  put(main, 'package.json', '{"private":true}\n');
  put(main, 'app/a.ts', 'export const a = 1;\n'); put(main, 'app/b.ts', 'export const b = 1;\n');
  put(main, 'tests/check.test.mjs', `import test from 'node:test'; import assert from 'node:assert/strict'; import {readFileSync} from 'node:fs';
    // app/a.ts and app/b.ts are both covered by this fixture.
    test('fixture assertion', () => assert.equal(readFileSync('app/a.ts','utf8').includes('bad'), false));\n`);
  if (preexisting) put(main, 'app/a.ts', 'bad baseline\n');
  git(main, ['add', '.']); git(main, ['commit', '-m', 'isolated seed']);
  const taskId = '20261025-integration-fixture-01', branch = `codex/${taskId}`;
  git(main, ['worktree', 'add', '--no-track', '-b', branch, codex, 'main']);
  git(main, ['worktree', 'add', '--no-track', '-b', 'claude/ready-fixture', claude, 'main']);
  const seed = head(main), task = 'Integration fixture', slug = 'integration-fixture';
  writeRecord(codex, `.tmp-baba/start/tasks/${taskId}.json`, {version: 1, root: codex, agent: 'codex', task, slug,
    taskKey: hash(`${task}\0${slug}`), files: ['app/b.ts'], taskId, branch, baseSha: seed, createdAt: new Date().toISOString()});
  // Tiny deterministic toolchain ONLY in this fixture. The real Verify CLI, TAP assertions,
  // baseline snapshots, Handoff CLI and integration implementation are actually executed.
  put(codex, 'node_modules/next/dist/bin/next', 'process.exit(0);\n');
  put(codex, 'node_modules/eslint/bin/eslint.js', "console.log('[]');\n");
  put(codex, 'node_modules/typescript/lib/tsc.js', "process.exit(0);\n");
  return {directory, main, codex, claude, seed, taskId, branch};
}
function verify(f, extra = []) {
  const result = cli(f.codex, 'baba-verify.mjs', ['--base', 'main', '--tests', 'tests/check.test.mjs', '--build', '--json', ...extra]);
  return {result, report: JSON.parse(result.stdout)};
}
function finish(f) {
  const checked = verify(f);
  assert.equal(checked.result.status, 0, checked.result.stderr + JSON.stringify(checked.report));
  const path = `docs/handoffs/${f.branch.replace('/', '-')}.md`;
  assert.equal(cli(f.codex, 'baba-handoff.mjs', ['--task-name', 'Integration fixture', '--base', 'main']).status, 0);
  const text = readFileSync(join(f.codex, path), 'utf8').replace(/<!-- TODO[\s\S]*?-->/g, 'isolated fixture executed');
  put(f.codex, path, text);
  assert.equal(cli(f.codex, 'baba-handoff.mjs', ['--check', path]).status, 0);
  git(f.codex, ['add', '--', path]); git(f.codex, ['commit', '-m', 'fixture handoff']);
  return {path, verify: checked.report};
}
function ready(options) { const f = fixture(options); commit(f.codex, 'app/b.ts', 'export const b = 2;\n'); finish(f); return f; }
const inspect = f => integrate({branch: f.branch}, f.codex);
const prepare = f => integrate({_: ['prepare'], branch: f.branch}, f.codex);
function approval(f, prepared) {
  const path = `.tmp-baba/user-approval-${prepared.id}.json`;
  writeRecord(f.codex, path, {version: 1, action: 'merge-local-main', approvedBy: 'user', approvedAt: new Date().toISOString(),
    ...prepared.approvalRequired, preparedDigest: hash(prepared)});
  return path;
}

test('actual Verify → committed Handoff → inspect → prepare is non-destructive and merge requires exact approval', () => {
  const f = ready(), refs = gitOut(f.main, ['show-ref']), status = gitOut(f.main, ['status', '--porcelain']);
  assert.equal(inspect(f).status, 'INSPECTED');
  const prepared = prepare(f); assert.equal(prepared.status, 'PREPARED', JSON.stringify(prepared));
  assert.equal(prepared.merge.strategy, 'fast-forward'); assert.equal(prepared.integratedVerdict, 'PASS');
  assert.equal(gitOut(f.main, ['show-ref']), refs); assert.equal(gitOut(f.main, ['status', '--porcelain']), status);
  assert.equal(integrate({_: ['merge'], branch: f.branch}, f.codex).code, 'LOCAL_MERGE_APPROVAL_REQUIRED');
  assert.equal(head(f.main), f.seed);
  const approved = approval(f, prepared);
  const merged = integrate({_: ['merge'], prepared: prepared.savedAs, approval: approved}, f.codex);
  assert.equal(merged.status, 'MERGED_LOCAL', JSON.stringify(merged)); // disposable fixture main only
  assert.equal(head(f.main), head(f.codex));
  assert.equal(shaBranch(f.main, 'claude/ready-fixture'), f.seed);
});
const shaBranch = (root, branch) => gitOut(root, ['rev-parse', branch]);

test('non-fast-forward candidate is merged and built in an independent environment before local approval', () => {
  const f = ready(); commit(f.main, 'docs/main-progress.md', 'new main\n'); const before = head(f.main);
  const prepared = prepare(f); assert.equal(prepared.status, 'PREPARED', JSON.stringify(prepared));
  assert.equal(prepared.merge.strategy, 'merge'); assert.equal(prepared.inspection.revalidationRequired, true);
  assert.equal(head(f.main), before);
  const merged = integrate({_: ['merge'], prepared: prepared.savedAs, approval: approval(f, prepared)}, f.codex);
  assert.equal(merged.status, 'MERGED_LOCAL', JSON.stringify(merged));
  assert.deepEqual(gitOut(f.main, ['rev-list', '--parents', '-n', '1', 'HEAD']).split(' ').slice(1), [before, head(f.codex)]);
});

test('first finished task integrates individually; a later Claude task is revalidated against updated main', () => {
  const f = ready(), taskId = '20261025-later-fixture-01', branch = `claude/${taskId}`;
  git(f.claude, ['switch', '-c', branch]);
  writeRecord(f.claude, `.tmp-baba/start/tasks/${taskId}.json`, {version: 1, root: f.claude, agent: 'claude',
    task: 'later', slug: 'later-fixture', taskKey: hash('later\0later-fixture'), taskId, branch, baseSha: f.seed, files: ['app/a.ts']});
  const first = prepare(f); assert.equal(first.status, 'PREPARED', JSON.stringify(first));
  const merged = integrate({_: ['merge'], prepared: first.savedAs, approval: approval(f, first)}, f.codex);
  assert.equal(merged.status, 'MERGED_LOCAL', JSON.stringify(merged));
  const updatedMain = head(f.main);
  cpSync(join(f.codex, 'node_modules'), join(f.claude, 'node_modules'), {recursive: true});
  commit(f.claude, 'app/a.ts', 'export const a = 2;\n');
  const later = {...f, codex: f.claude, taskId, branch}; finish(later);
  const next = prepare(later); assert.equal(next.status, 'PREPARED', JSON.stringify(next));
  assert.equal(next.inspection.main.head, updatedMain); assert.equal(next.inspection.revalidationRequired, true);
  assert.equal(next.merge.strategy, 'merge'); assert.equal(head(f.main), updatedMain);
});

test('code conflict retains environment and unmerged evidence without touching main', () => {
  const f = ready(); commit(f.main, 'app/b.ts', 'export const b = 9;\n'); const before = head(f.main);
  const result = prepare(f); assert.equal(result.code, 'CODE_CONFLICT', JSON.stringify(result));
  assert.equal(head(f.main), before); assert.ok(existsSync(join(f.codex, result.environment)));
  assert.match(gitOut(join(f.codex, result.environment), ['diff', '--name-only', '--diff-filter=U']), /app\/b.ts/);
});

test('dirty original main blocks inspect and prepare and preserves exact file bytes', () => {
  const f = ready(); put(f.main, 'app/b.ts', 'preserve user data\n');
  assert.equal(inspect(f).code, 'DIRTY_MAIN'); assert.equal(prepare(f).code, 'DIRTY_MAIN');
  assert.equal(readFileSync(join(f.main, 'app/b.ts'), 'utf8'), 'preserve user data\n');
});

test('main or candidate SHA changes revoke a prepared approval; later task can reprepare', () => {
  const f = ready(), first = prepare(f); assert.equal(first.status, 'PREPARED', JSON.stringify(first));
  const approved = approval(f, first); const newer = commit(f.main, 'docs/other.md', 'later main\n');
  assert.equal(integrate({_: ['merge'], prepared: first.savedAs, approval: approved}, f.codex).code, 'INPUT_CHANGED_REVALIDATE');
  assert.equal(head(f.main), newer);
  const second = prepare(f); assert.equal(second.status, 'PREPARED', JSON.stringify(second));
  // The earlier approval cannot be transferred to a new preparation.
  assert.equal(integrate({_: ['merge'], prepared: second.savedAs, approval: approved}, f.codex).code, 'APPROVAL_SCOPE_MISMATCH');
  commit(f.codex, 'app/b.ts', 'export const b = 3;\n');
  const changed = integrate({_: ['merge'], prepared: second.savedAs, approval: approval(f, second)}, f.codex);
  assert.equal(changed.status, 'BLOCKED'); assert.equal(changed.code, 'HANDOFF_SHA_MISMATCH');
});

test('Handoff missing, wrong SHA, wrong task, and unknown/missing Verify evidence fail closed', () => {
  const f = fixture(); commit(f.codex, 'app/b.ts', 'export const b = 2;\n');
  assert.equal(inspect(f).code, 'HANDOFF_MISSING');
  const completed = finish(f), original = readFileSync(join(f.codex, completed.path), 'utf8');
  commit(f.codex, completed.path, original.replace(/HEAD SHA: [a-f0-9]{40}/, `HEAD SHA: ${'0'.repeat(40)}`));
  assert.equal(inspect(f).code, 'HANDOFF_SHA_MISMATCH');
  commit(f.codex, completed.path, original.replace(`작업 ID: ${f.taskId}`, '작업 ID: wrong'));
  assert.equal(inspect(f).code, 'HANDOFF_IDENTITY_MISMATCH');
  commit(f.codex, completed.path, original);
  const archive = join(f.codex, completed.verify.savedAs), saved = readFileSync(archive, 'utf8');
  writeFileSync(archive, JSON.stringify({...completed.verify, verdict: 'UNKNOWN'}));
  assert.equal(inspect(f).code, 'VERIFY_EVIDENCE_REJECTED');
  writeFileSync(archive, saved);
  const invalid = {...completed.verify, checks: []}; writeFileSync(archive, JSON.stringify(invalid));
  assert.equal(inspect(f).code, 'VERIFY_EVIDENCE_REJECTED');
});

test('actual preexisting TAP failure is accepted only with retained baseline evidence; new failure is rejected', () => {
  const f = ready({preexisting: true});
  const report = JSON.parse(readFileSync(join(f.codex, '.tmp-baba/verify/latest.json'), 'utf8'));
  assert.equal(report.verdict, 'PASS_WITH_PREEXISTING'); assert.equal(inspect(f).status, 'INSPECTED');
  const prepared = prepare(f); assert.equal(prepared.status, 'PREPARED', JSON.stringify(prepared));
  const incomplete = {...report, baselineDir: '.tmp-baba/missing-baseline'};
  assert.ok(verifyEvidence(f.codex, incomplete).includes('VERIFY_BASELINE_SNAPSHOT_MISSING'));
  const noDetails = structuredClone(report); noDetails.checks.find(c => c.name === '회귀 테스트').files[0].baseline.failureDetails = [];
  assert.ok(verifyEvidence(f.codex, noDetails).includes('VERIFY_TEST_BASELINE_INVALID'));
  commit(f.codex, 'tests/check.test.mjs', readFileSync(join(f.codex, 'tests/check.test.mjs'), 'utf8').replace('false)', "'new expectation')"));
  const checked = verify(f); assert.equal(checked.result.status, 1); assert.equal(checked.report.verdict, 'FAIL');
  assert.equal(checked.report.checks.find(c => c.name === '회귀 테스트').files[0].classification, 'new');
});

test('TypeScript preexisting diagnostics require concrete comparable evidence and a snapshot', () => {
  const f = ready(); const report = JSON.parse(readFileSync(join(f.codex, '.tmp-baba/verify/latest.json'), 'utf8'));
  const types = report.checks.find(c => c.name === 'TypeScript (tsc --noEmit)');
  report.verdict = 'PASS_WITH_PREEXISTING'; types.status = 'passed-with-preexisting'; types.preexisting = 1;
  assert.ok(verifyEvidence(f.codex, report).includes('VERIFY_BASELINE_EVIDENCE_MISSING:types'));
  types.baselineEvidence = {sha: report.mergeBase, current: ['new error'], before: ['old error']};
  assert.ok(verifyEvidence(f.codex, report).includes('VERIFY_BASELINE_DIFFERS:types'));
});

test('disjoint active work is allowed, declared overlap and shared DB objects are blocked', () => {
  const f = ready(); git(f.claude, ['switch', '-c', 'claude/20261025-active-01']);
  const task = 'active', slug = 'active', taskId = '20261025-active-01';
  const record = {version: 1, root: f.claude, agent: 'claude', task, slug, taskKey: hash(`${task}\0${slug}`), taskId,
    branch: `claude/${taskId}`, baseSha: f.seed, files: ['docs/other.md']};
  writeRecord(f.claude, `.tmp-baba/start/tasks/${taskId}.json`, record);
  assert.equal(inspect(f).status, 'INSPECTED');
  writeRecord(f.claude, `.tmp-baba/start/tasks/${taskId}.json`, {...record, files: ['app/b.ts']}, {replace: true});
  assert.equal(inspect(f).inspection.blockers[0].code, 'ACTIVE_WORKTREE_CONFLICT');
  assert.equal(head(f.claude), f.seed);
});

test('SQL/Migration and shared API changes are reported and never executed', () => {
  for (const path of ['supabase/migrations/20261025000000_fixture.sql', 'app/api/shared/route.ts']) {
    const f = fixture(); commit(f.codex, path, path.endsWith('.sql') ? '-- fixture SQL, never executed\n' : 'export const GET = () => null;\n'); finish(f);
    const result = prepare(f); assert.equal(result.code, 'INTEGRATION_BLOCKED');
    assert.equal(result.inspection.blockers[0].code, path.endsWith('.sql') ? 'SCHEMA_REVIEW_REQUIRED' : 'SHARED_API_REVIEW_REQUIRED');
    assert.equal(head(f.main), f.seed); assert.equal(result.environment, undefined);
  }
});

test('relative/absolute external output, symlink, junction, dangling links, cwd and TEMP/TMP boundaries', () => {
  const f = fixture(), outside = join(f.directory, 'outside'); mkdirSync(outside);
  for (const path of ['../outside/probe.json', join(outside, 'probe.json'), 'file:stream', 'C:drive-relative.json']) assert.throws(() => writeRecord(f.codex, path, {}));
  for (const type of ['junction']) {
    const path = `escape-${type}`; symlinkSync(outside, join(f.codex, path), type);
    assert.throws(() => writeRecord(f.codex, `${path}/probe.json`, {}));
  }
  symlinkSync(join(outside, 'absent'), join(f.codex, 'dangling'), 'junction');
  assert.throws(() => writeRecord(f.codex, 'dangling/probe.json', {}));
  assert.throws(() => worktreeEnvironment(f.codex, {}, outside));
  const env = worktreeEnvironment(f.codex, {TEMP: outside, TMP: outside, TMPDIR: outside});
  for (const key of ['TEMP', 'TMP', 'TMPDIR']) assert.equal(env[key], join(f.codex, '.tmp-baba/tmp'));
  const result = run(process.execPath, ['-e', "require('node:fs').writeFileSync(require('node:path').join(require('node:os').tmpdir(),'child-probe'),'ok')"], {cwd: f.codex, env: {...process.env, ...env}});
  assert.equal(result.status, 0); assert.ok(existsSync(join(f.codex, '.tmp-baba/tmp/child-probe')));
  assert.deepEqual(readdirSync(outside), []);
  writeRecord(f.codex, '.tmp-baba/normal.json', {ok: true}); assert.ok(existsSync(join(f.codex, '.tmp-baba/normal.json')));
  symlinkSync(outside, join(f.codex, '.tmp-baba/redirected'), 'junction');
  assert.throws(() => worktreeEnvironment(f.codex, {}, join(f.codex, '.tmp-baba/redirected')));
});

test('native directory symlinks also reject output escape when the OS permits creating them', t => {
  const f = fixture(), outside = join(f.directory, 'native-outside'); mkdirSync(outside);
  try { symlinkSync(outside, join(f.codex, 'native-link'), 'dir'); }
  catch (error) { if (error.code === 'EPERM') return t.skip('Windows does not permit native symlink creation; junction coverage runs separately'); throw error; }
  assert.throws(() => writeRecord(f.codex, 'native-link/escape.json', {}));
  assert.deepEqual(readdirSync(outside), []);
});

test('symlinked output directory cannot redirect an integrate result outside its worktree', () => {
  const f = ready(), outside = join(f.directory, 'outside'); mkdirSync(outside);
  symlinkSync(outside, join(f.codex, '.tmp-baba/integrate'), 'junction');
  assert.equal(inspect(f).code, 'OUTPUT_BOUNDARY_OR_WRITE_FAILED'); assert.deepEqual(readdirSync(outside), []);
});

test('a latest pointer hardlink cannot overwrite an archived record or external file', () => {
  const f = fixture(), target = join(f.directory, 'preserve.json'); writeFileSync(target, 'original bytes');
  mkdirSync(join(f.codex, '.tmp-baba/records'), {recursive: true});
  linkSync(target, join(f.codex, '.tmp-baba/records/latest.json'));
  assert.throws(() => writeRecord(f.codex, '.tmp-baba/records/latest.json', {bad: true}, {replace: true}), /unshared regular/);
  assert.equal(readFileSync(target, 'utf8'), 'original bytes');
});

test('shared DB references conflict across different source paths', () => {
  const f = fixture(); commit(f.codex, 'lib/candidate.ts', "export const query = db => db.from('shared_table').select('*');\n"); finish(f);
  put(f.claude, 'lib/other.ts', "export const other = db => db.from('shared_table').select('*');\n");
  const result = inspect(f); assert.equal(result.code, 'INTEGRATION_BLOCKED', JSON.stringify(result));
  assert.deepEqual(result.inspection.blockers[0].shared.tables, ['shared_table']);
  assert.equal(head(f.main), f.seed);
});

test('push, deploy, DB and malformed CLI actions cannot mutate main or create a remote', () => {
  const f = ready(), refs = gitOut(f.main, ['show-ref']);
  for (const action of ['push', 'deploy', 'production', 'db', 'migration']) {
    assert.equal(integrate({_: [action], branch: f.branch}, f.codex).code, 'UNSUPPORTED_ACTION_NO_REMOTE_OR_DB');
  }
  for (const args of [['--branch'], ['prepare', '--push'], ['merge', '--approval='], ['inspect', 'extra']]) {
    assert.equal(cli(f.codex, 'baba-integrate.mjs', args).status, 2);
  }
  assert.equal(gitOut(f.main, ['show-ref']), refs); assert.equal(gitOut(f.main, ['remote']), '');
});

test('tampered prepared tree, wrong approval digest and skipped checks cannot authorize merge', () => {
  const f = ready(), prepared = prepare(f); assert.equal(prepared.status, 'PREPARED', JSON.stringify(prepared));
  const path = approval(f, prepared), valid = JSON.parse(readFileSync(join(f.codex, path), 'utf8'));
  writeRecord(f.codex, path, {...valid, preparedDigest: 'wrong'}, {replace: true});
  assert.equal(integrate({_: ['merge'], prepared: prepared.savedAs, approval: path}, f.codex).code, 'APPROVAL_SCOPE_MISMATCH');
  writeRecord(f.codex, path, valid, {replace: true});
  put(join(f.codex, prepared.environment), 'app/b.ts', 'tampered\n');
  assert.equal(integrate({_: ['merge'], prepared: prepared.savedAs, approval: path}, f.codex).code, 'PREPARED_STATE_CHANGED');
  assert.equal(head(f.main), f.seed);
});
