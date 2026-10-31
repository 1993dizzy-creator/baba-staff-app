import test from 'node:test';
import assert from 'node:assert/strict';
import {cpSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {integrate} from '../scripts/agent/baba-integrate.mjs';
import {git, gitOut, run, worktreeEnvironment, writeRecord} from '../scripts/agent/lib/common.mjs';
import {verifyEvidence} from '../scripts/agent/lib/verify-evidence.mjs';

import {hash, put, head, commit, fixture, verify, finish, ready, inspect, prepare, approval, shaBranch} from './agent-workflow-integrate-fixture.mjs';

test('actual Verify → committed Handoff → inspect → prepare is non-destructive and merge requires exact approval', () => {
  const f = ready(), refs = gitOut(f.main, ['show-ref']), status = gitOut(f.main, ['status', '--porcelain']);
  assert.equal(inspect(f).status, 'INSPECTED');
  const prepared = prepare(f); assert.equal(prepared.status, 'PREPARED', JSON.stringify(prepared));
  assert.equal(prepared.merge.strategy, 'fast-forward'); assert.equal(prepared.integratedVerdict, 'PASS');
  assert.equal(gitOut(f.main, ['show-ref']), refs); assert.equal(gitOut(f.main, ['status', '--porcelain']), status);
  assert.equal(integrate({_: ['merge'], branch: f.branch}, f.codex).code, 'LOCAL_MAIN_EXECUTION_DISABLED');
  assert.equal(head(f.main), f.seed);
  const approved = approval(f, prepared);
  const merged = integrate({_: ['merge'], prepared: prepared.savedAs, approval: approved}, f.codex);
  assert.equal(merged.code, 'LOCAL_MAIN_EXECUTION_DISABLED', JSON.stringify(merged));
  assert.equal(head(f.main), f.seed);
  assert.equal(shaBranch(f.main, 'claude/ready-fixture'), f.seed);
});

test('non-fast-forward candidate is merged and built in an independent environment before local approval', () => {
  const f = ready(); commit(f.main, 'docs/main-progress.md', 'new main\n'); const before = head(f.main);
  git(f.main, ['push', 'origin', 'main']);
  const prepared = prepare(f); assert.equal(prepared.status, 'PREPARED', JSON.stringify(prepared));
  assert.equal(prepared.merge.strategy, 'merge'); assert.equal(prepared.inspection.revalidationRequired, true);
  assert.equal(head(f.main), before);
  const merged = integrate({_: ['merge'], prepared: prepared.savedAs, approval: approval(f, prepared)}, f.codex);
  assert.equal(merged.code, 'LOCAL_MAIN_EXECUTION_DISABLED', JSON.stringify(merged));
  assert.deepEqual(gitOut(join(f.codex, prepared.environment), ['rev-list', '--parents', '-n', '1', 'HEAD']).split(' ').slice(1), [before, head(f.codex)]);
});

test('first finished task integrates individually; a later Claude task is revalidated against updated main', () => {
  const f = ready(), taskId = '20261025-later-fixture-01', branch = `claude/${taskId}`;
  git(f.claude, ['switch', '-c', branch]);
  writeRecord(f.claude, `.tmp-baba/start/tasks/${taskId}.json`, {version: 1, root: f.claude, agent: 'claude',
    task: 'later', slug: 'later-fixture', taskKey: hash('later\0later-fixture'), taskId, branch, baseSha: f.seed, files: ['app/a.ts']});
  const first = prepare(f); assert.equal(first.status, 'PREPARED', JSON.stringify(first));
  const merged = integrate({_: ['merge'], prepared: first.savedAs, approval: approval(f, first)}, f.codex);
  assert.equal(merged.code, 'LOCAL_MAIN_EXECUTION_DISABLED', JSON.stringify(merged));
  // Simulate a user's DIRECT execution, only in this disposable fixture.
  git(f.main, ['merge', '--ff-only', f.branch]); git(f.main, ['push', 'origin', 'main']);
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
  git(f.main, ['push', 'origin', 'main']);
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
  git(f.main, ['push', 'origin', 'main']);
  assert.equal(integrate({_: ['merge'], prepared: first.savedAs, approval: approved}, f.codex).code, 'REMOTE_OR_MAIN_CHANGED_REVALIDATE');
  assert.equal(head(f.main), newer);
  const second = prepare(f); assert.equal(second.status, 'PREPARED', JSON.stringify(second));
  // The earlier approval cannot be transferred to a new preparation.
  assert.equal(integrate({_: ['merge'], prepared: second.savedAs, approval: approved}, f.codex).code, 'LOCAL_MAIN_EXECUTION_DISABLED');
  commit(f.codex, 'app/b.ts', 'export const b = 3;\n');
  const changed = integrate({_: ['merge'], prepared: second.savedAs, approval: approval(f, second)}, f.codex);
  assert.equal(changed.status, 'BLOCKED'); assert.equal(changed.code, 'LOCAL_MAIN_EXECUTION_DISABLED');
  assert.equal(inspect(f).code, 'HANDOFF_SHA_MISMATCH');
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

