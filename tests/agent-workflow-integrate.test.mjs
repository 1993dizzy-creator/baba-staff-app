import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {integrate} from '../scripts/agent/baba-integrate.mjs';
import {assertNoGitHooks, guardedGit, git, gitOut, insideRoot, run, sanitizedEnv, stateFingerprint, worktreeEnvironment, writeRecord} from '../scripts/agent/lib/common.mjs';
import {verifyEvidence} from '../scripts/agent/lib/verify-evidence.mjs';
import {remoteMainState} from '../scripts/agent/lib/remote-main.mjs';

// Everything, including fixture main merges, is confined to the owning source worktree.
const source = resolve(fileURLToPath(new URL('..', import.meta.url)));
const parent = insideRoot(source, '.tmp-baba/integrate-fixtures'); mkdirSync(parent, {recursive: true});
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const put = (root, path, text) => { const full = insideRoot(root, path); mkdirSync(resolve(full, '..'), {recursive: true}); writeFileSync(full, text); };
const head = root => gitOut(root, ['rev-parse', 'HEAD']);
const commit = (root, path, content) => { put(root, path, content); git(root, ['add', '--', path]); git(root, ['commit', '-m', 'fixture']); return head(root); };
const cli = (root, script, args = []) => run(process.execPath, [join(root, 'scripts/agent', script), ...args],
  {cwd: root, env: sanitizedEnv().env, allowFail: true, timeout: 120000});

function fixture({preexisting = false, explicitGuard = false, dynamicImport = false, deep = false} = {}) {
  const temporary = mkdtempSync(join(parent, '한글 space-'));
  const directory = deep ? join(temporary, 'd'.repeat(Math.max(8, 161 - temporary.length - 15))) : temporary;
  if (deep) mkdirSync(directory);
  const main = join(directory, 'baba-staff-app'), codex = join(directory, 'baba-wt-codex'), claude = join(directory, 'baba-wt-claude');
  mkdirSync(main); git(main, ['init', '-b', 'main']);
  git(main, ['config', 'user.name', 'Fixture']); git(main, ['config', 'user.email', 'fixture@example.invalid']);
  cpSync(join(source, 'scripts/agent'), join(main, 'scripts/agent'), {recursive: true});
  put(main, '.gitignore', '.tmp-baba/\nnode_modules/\n');
  put(main, 'package.json', '{"private":true}\n');
  put(main, 'app/a.ts', 'export const a = 1;\n'); put(main, 'app/b.ts', 'export const b = 1;\n');
  put(main, 'tests/check.test.mjs', `import test from 'node:test'; import assert from 'node:assert/strict'; import {existsSync,readFileSync} from 'node:fs';
    test('fixture assertion', () => assert.equal(readFileSync('app/a.ts','utf8').includes('bad'), false));
    test('fixture secondary source',()=>assert.equal(readFileSync('app/b.ts','utf8').includes('invalid'),false));
    test('policy resources are inspected only as text',()=>{
      for(const file of ['supabase/migrations/20261025000000_fixture.sql','app/api/shared/route.ts','lib/candidate.ts']) {
        if(existsSync(file))assert.ok(readFileSync(file,'utf8').length>0);
      }
    });\n`);
  if (preexisting) put(main, 'app/a.ts', 'bad baseline\n');
  if (explicitGuard) put(main, 'tests/manual-extra.test.mjs', `import test from 'node:test'; import assert from 'node:assert/strict'; import {readFileSync} from 'node:fs';
    test('explicit invariant',()=>assert.equal(readFileSync('app/'+'a.ts','utf8').includes('= 9;') && readFileSync('app/'+'b.ts','utf8').includes('= 2;'),false));\n`);
  // Loads modules by directory listing, so no source path is named and auto-matching finds nothing.
  if (dynamicImport) put(main, 'tests/dynamic-exercise.test.mjs', `import test from 'node:test'; import assert from 'node:assert/strict';
    import {readdirSync} from 'node:fs'; import {join} from 'node:path'; import {pathToFileURL} from 'node:url';
    test('every listed module loads', async () => {
      for (const name of readdirSync('app').filter(name => name.endsWith('.ts')))
        assert.ok(await import(pathToFileURL(join(process.cwd(), 'app', name)).href));
    });\n`);
  git(main, ['add', '.']); git(main, ['commit', '-m', 'isolated seed']);
  const origin = join(directory, 'origin.git');
  git(main, ['init', '--bare', origin]); git(main, ['remote', 'add', 'origin', origin]);
  git(main, ['push', 'origin', 'main']); // disposable LOCAL bare fixture, never GitHub
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
  return {directory, main, codex, claude, seed, taskId, branch, origin};
}
function verify(f, extra = []) {
  const result = cli(f.codex, 'baba-verify.mjs', ['--base', 'main', '--tests', 'tests/check.test.mjs', '--build', '--json', ...extra]);
  return {result, report: JSON.parse(result.stdout)};
}
function finish(f, extra = []) {
  const checked = verify(f, extra);
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
  assert.equal(integrate({_: ['merge'], branch: f.branch}, f.codex).code, 'LOCAL_MAIN_EXECUTION_DISABLED');
  assert.equal(head(f.main), f.seed);
  const approved = approval(f, prepared);
  const merged = integrate({_: ['merge'], prepared: prepared.savedAs, approval: approved}, f.codex);
  assert.equal(merged.code, 'LOCAL_MAIN_EXECUTION_DISABLED', JSON.stringify(merged));
  assert.equal(head(f.main), f.seed);
  assert.equal(shaBranch(f.main, 'claude/ready-fixture'), f.seed);
});
const shaBranch = (root, branch) => gitOut(root, ['rev-parse', branch]);

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
  assert.equal(gitOut(f.main, ['show-ref']), refs); assert.equal(gitOut(f.main, ['remote']), 'origin');
});

test('tampered prepared tree, wrong approval digest and skipped checks cannot authorize merge', () => {
  const f = ready(), prepared = prepare(f); assert.equal(prepared.status, 'PREPARED', JSON.stringify(prepared));
  const path = approval(f, prepared), valid = JSON.parse(readFileSync(join(f.codex, path), 'utf8'));
  writeRecord(f.codex, path, {...valid, preparedDigest: 'wrong'}, {replace: true});
  assert.equal(integrate({_: ['merge'], prepared: prepared.savedAs, approval: path}, f.codex).code, 'LOCAL_MAIN_EXECUTION_DISABLED');
  writeRecord(f.codex, path, valid, {replace: true});
  put(join(f.codex, prepared.environment), 'app/b.ts', 'tampered\n');
  assert.equal(integrate({_: ['merge'], prepared: prepared.savedAs, approval: path}, f.codex).code, 'LOCAL_MAIN_EXECUTION_DISABLED');
  assert.equal(head(f.main), f.seed);
});

test('D1: post-index-change file hook is blocked before index writes; isolated positive control proves the hook is executable', () => {
  const f = fixture(), marker = join(f.directory, 'file-hook-ran.txt');
  const hooks = gitOut(f.codex, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks']);
  put(hooks, 'post-index-change', `#!/bin/sh\nprintf ran > '${marker.replaceAll('\\', '/')}'\n`);
  const before = readFileSync(join(hooks, 'post-index-change'), 'utf8');
  put(f.codex, 'app/b.ts', 'changed\n');
  assert.throws(() => guardedGit(f.codex, ['add', '--', 'app/b.ts']), error => error.code === 'ACTIVE_GIT_HOOK');
  assert.equal(prepare(f).code, 'ACTIVE_GIT_HOOK'); assert.equal(existsSync(marker), false);
  assert.equal(readFileSync(join(hooks, 'post-index-change'), 'utf8'), before);
  // Positive control ONLY in this disposable fixture, after checking the protected path.
  git(f.codex, ['add', '--', 'app/b.ts']); assert.ok(existsSync(marker));
  assert.equal(head(f.main), f.seed);
});

test('D1: Git 2.55 config hooks remain blocked even with an empty core.hooksPath', () => {
  const f = fixture(), marker = join(f.directory, 'config-hook-ran.txt'), empty = join(f.directory, 'empty-hooks'); mkdirSync(empty);
  git(f.codex, ['config', 'core.hooksPath', empty]);
  git(f.codex, ['config', 'hook.probe.command', `printf ran > '${marker.replaceAll('\\', '/')}'`]);
  git(f.codex, ['config', 'hook.probe.event', 'post-index-change']);
  put(f.codex, 'app/b.ts', 'changed\n');
  assert.throws(() => guardedGit(f.codex, ['add', '--', 'app/b.ts']), error => error.code === 'ACTIVE_CONFIG_GIT_HOOK');
  assert.equal(prepare(f).code, 'ACTIVE_CONFIG_GIT_HOOK'); assert.equal(existsSync(marker), false);
  git(f.codex, ['add', '--', 'app/b.ts']); assert.ok(existsSync(marker));
});

test('D1: effective include, includeIf future contexts, environment overrides and malformed config fail closed', () => {
  for (const condition of ['include.path', 'includeIf.onbranch:codex/**.path', 'includeIf.onbranch:not-current.path']) {
    const f = fixture(), included = join(f.directory, 'included.config');
    writeFileSync(included, '[hook "probe"]\n command = echo forbidden\n event = post-index-change\n');
    git(f.codex, ['config', condition, included]);
    assert.throws(() => assertNoGitHooks(f.codex), error => ['ACTIVE_CONFIG_GIT_HOOK', 'GIT_CONFIG_CONTEXT_UNVERIFIED'].includes(error.code));
    assert.equal(prepare(f).status, 'BLOCKED'); assert.equal(head(f.main), f.seed);
  }
  const f = fixture();
  for (const override of [{GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'hook.probe.event',GIT_CONFIG_VALUE_0:'post-index-change'},
    {GIT_CONFIG_GLOBAL:join(f.directory,'mask.config')}, {GIT_CONFIG_PARAMETERS:'unknown'}, {GIT_DIR:join(f.directory,'other.git')},
    {GIT_INDEX_FILE:join(f.codex,'.tmp-baba/foreign-index')}]) {
    assert.throws(() => assertNoGitHooks(f.codex, {env:{...sanitizedEnv().env,...override}}), error => error.code === 'GIT_ENVIRONMENT_UNVERIFIED');
  }
  const config = gitOut(f.codex, ['rev-parse', '--path-format=absolute', '--git-path', 'config']);
  writeFileSync(config, '[malformed\n');
  assert.throws(() => assertNoGitHooks(f.codex), error => error.code === 'GIT_CONFIG_UNVERIFIED');
});

test('D2: unchanged explicitly selected test is inherited and catches a regression introduced by new main', () => {
  const f = fixture({explicitGuard:true}); commit(f.codex, 'app/b.ts', 'export const b = 2;\n');
  const completed = finish(f, ['--tests','tests/manual-extra.test.mjs']);
  assert.deepEqual(completed.verify.testSelection.explicit, ['tests/manual-extra.test.mjs']);
  const first = prepare(f); assert.equal(first.status, 'PREPARED', JSON.stringify(first));
  assert.ok(first.testSelection.executed.includes('tests/manual-extra.test.mjs'));
  commit(f.main,'app/a.ts','export const a = 9;\n'); git(f.main,['push','origin','main']);
  const second = prepare(f); assert.equal(second.code, 'INTEGRATED_VERIFY_FAILED', JSON.stringify(second));
  const report = JSON.parse(readFileSync(join(f.codex,second.integratedVerify),'utf8'));
  assert.equal(report.checks.find(c=>Array.isArray(c.files)).files.find(t=>t.path==='tests/manual-extra.test.mjs').status,'failed');
});

test('D2: archived changed-file scope, base SHA and test selection are bound to candidate evidence', () => {
  const f=ready(), archive=JSON.parse(readFileSync(join(f.codex,'.tmp-baba/verify/latest.json'),'utf8'));
  const path=join(f.codex,archive.savedAs);
  for(const change of [{changedFiles:[]},{baseSha:'0'.repeat(40)},
    {baseSha:archive.head,mergeBase:archive.head,changedFiles:[]},
    {testSelection:{explicit:[],executed:[],allTests:false}}]) {
    writeFileSync(path,JSON.stringify({...archive,...change}));
    assert.equal(inspect(f).code,'VERIFY_EVIDENCE_REJECTED');
  }
});

test('D2: Verify pins its initial base SHA and fails if main changes during execution', () => {
  const f=fixture(); commit(f.codex,'app/b.ts','export const b = 2;\n');
  const next=commit(f.claude,'docs/later-main.md','external update\n');
  put(f.codex,'node_modules/next/dist/bin/next',`const {execFileSync}=require('node:child_process');
    if(process.argv.includes('build'))execFileSync('git',['-C',${JSON.stringify(f.codex)},'update-ref','refs/heads/main',${JSON.stringify(next)}]);\n`);
  const checked=verify(f); assert.equal(checked.report.baseSha,f.seed);
  assert.equal(checked.report.verdict,'FAIL');
  assert.ok(checked.report.checks.some(check=>check.error==='VERIFY_INPUT_CHANGED'));
});

test('D3: equality and ancestor local-ahead permit inspect/prepare without main execution authority', () => {
  const f=ready(); assert.equal(remoteMainState(f.codex).relation,'equal');
  commit(f.main,'docs/local.txt','local only\n');
  writeRecord(f.codex,'.tmp-baba/forged-approval.json',{approvedBy:'user',mainHead:head(f.main)});
  assert.equal(remoteMainState(f.codex,{allowLocalAhead:true}).relation,'local-ahead');
  assert.throws(()=>remoteMainState(f.codex),e=>e.code==='LOCAL_AHEAD_APPROVAL_UNVERIFIABLE');
  assert.equal(inspect(f).status,'INSPECTED');
  const before=head(f.main),refs=gitOut(f.main,['show-ref']);
  const result=prepare(f); assert.equal(result.status,'PREPARED',JSON.stringify(result));
  assert.equal(result.remote.relation,'local-ahead');assert.equal(result.merge.strategy,'merge');
  assert.equal(head(f.main),before);assert.equal(gitOut(f.main,['show-ref']),refs);
  assert.equal(integrate({_:['merge'],branch:f.branch},f.codex).status,'BLOCKED');
});

test('D3: stale origin/main cache cannot hide remote-ahead, divergence or unavailable remote', () => {
  for(const mode of ['remote-ahead','diverged','unavailable']) {
    const f=ready();
    if(mode==='unavailable')git(f.codex,['remote','set-url','origin',join(f.directory,'absent.git')]);
    else {
      commit(f.claude,'app/a.ts','export const a = 8;\n'); git(f.claude,['push','origin','HEAD:main']);
      git(f.codex,['update-ref','refs/remotes/origin/main',f.seed]);
      if(mode==='diverged')commit(f.main,'docs/local.txt','local\n');
    }
    const before=head(f.main), result=prepare(f);
    assert.equal(result.code,mode==='remote-ahead'?'REMOTE_MAIN_AHEAD':mode==='diverged'?'DIVERGED_MAIN':'REMOTE_MAIN_UNAVAILABLE',JSON.stringify(result));
    assert.equal(head(f.main),before); assert.equal(result.environment,undefined);
    assert.equal(inspect(f).code,result.code);
  }
});

test('D3/R1: stale preparation is invalidated at merge entry, and forged user receipts never enable execution', () => {
  const f=ready(), prepared=prepare(f); assert.equal(prepared.status,'PREPARED',JSON.stringify(prepared));
  const receipt=approval(f,prepared), before=head(f.main);
  assert.equal(integrate({_:['merge'],prepared:prepared.savedAs,approval:receipt},f.codex).code,'LOCAL_MAIN_EXECUTION_DISABLED');
  assert.equal(head(f.main),before);
  commit(f.main,'docs/new-main.md','new public main\n'); git(f.main,['push','origin','main']);
  const stale=integrate({_:['merge'],prepared:prepared.savedAs,approval:receipt},f.codex);
  assert.equal(stale.code,'REMOTE_OR_MAIN_CHANGED_REVALIDATE'); assert.equal(stale.permissions.localMainMerge,false);
});

const slash = path => path.split('\\').join('/');
const NEUTRALIZED = ['GIT_EDITOR', 'GIT_SEQUENCE_EDITOR', 'GIT_ASKPASS', 'SSH_ASKPASS'];

test('Windows Git subprocesses read long object paths and write long refs without changing config', () => {
  const directory = mkdtempSync(join(parent, 'longpaths-'));
  const root = join(directory, 'x'.repeat(Math.max(8, 210 - directory.length - 1)));
  mkdirSync(root);
  git(root, ['init', '-b', 'fixture']);
  git(root, ['config', '--local', 'core.longpaths', 'false']);
  const config = readFileSync(join(root, '.git/config'));
  const sha = gitOut(root, ['hash-object', '-w', '--stdin'], {input: 'long path control\n'});
  const object = join(root, '.git/objects', sha.slice(0, 2), sha.slice(2));
  assert.ok(object.length > 260);
  assert.ok(readFileSync(object).length > 0); // Node can read the same long file Git must open.
  if (process.platform === 'win32') {
    const disabled = git(root, ['-c', 'core.longpaths=false', 'cat-file', '-p', sha], {allowFail: true});
    assert.notEqual(disabled.status, 0);
    assert.match(disabled.stderr, /Filename too long/);
  }
  assert.equal(gitOut(root, ['cat-file', '-p', sha]), 'long path control');
  const ref = 'refs/heads/codex/long-path-regression-' + 'r'.repeat(32);
  // Use a tag ref: a branch must point to a commit, whereas this fixture object is a blob.
  const tag = ref.replace('refs/heads/', 'refs/tags/');
  assert.ok(join(root, '.git', tag + '.lock').length > 260);
  guardedGit(root, ['update-ref', tag, sha]);
  assert.equal(gitOut(root, ['rev-parse', tag]), sha);
  assert.equal(readFileSync(join(root, '.git', tag), 'utf8').trim(), sha);
  assert.equal(gitOut(root, ['config', '--local', '--get', 'core.longpaths']), 'false');
  assert.deepEqual(readFileSync(join(root, '.git/config')), config);
});

test('deep prepare preserves real baseline comparison without exhausting native temporary paths', () => {
  const f = ready({preexisting: true, deep: true});
  assert.ok(f.codex.length >= 161);
  const prepared = prepare(f);
  assert.equal(prepared.status, 'PREPARED', JSON.stringify(prepared));
  assert.match(prepared.environment, /^\.tmp-baba\/i\/p-[^/]+\/baba-wt-codex$/);
  assert.equal(prepared.integratedVerdict, 'PASS_WITH_PREEXISTING');
  const verified = JSON.parse(readFileSync(join(f.codex, prepared.integratedVerify), 'utf8'));
  assert.ok(verified.baselineDir);
  assert.ok(existsSync(join(verified.baselineDir, '.baba-baseline.json')));
  assert.deepEqual(verified.checks.find(check => check.name === '회귀 테스트').newFailures, []);
  assert.equal(head(f.main), f.seed);
});

test('N1: agent-shell editor/askpass variables are neutralized for Git while other Git overrides stay rejected', () => {
  const f = ready(), marker = join(f.directory, 'editor-or-askpass-ran.txt'), program = `printf ran > '${slash(marker)}'`;
  const agentEnv = {...sanitizedEnv().env, ...Object.fromEntries(NEUTRALIZED.map(name => [name, program]))};
  assert.doesNotThrow(() => assertNoGitHooks(f.codex, {env: agentEnv}));
  // An alias shell shows the environment Git hands to programs it starts: the variables are gone.
  const seen = gitOut(f.codex, ['-c', 'alias.probe-env=!env', 'probe-env'], {env: agentEnv});
  for (const name of NEUTRALIZED) assert.doesNotMatch(seen, new RegExp(`^${name}=`, 'm'));
  assert.match(seen, /^GIT_TERMINAL_PROMPT=0$/m);
  const inspected = run(process.execPath, [join(f.codex, 'scripts/agent/baba-integrate.mjs'), '--branch', f.branch, '--json'],
    {cwd: f.codex, env: agentEnv, allowFail: true, timeout: 120000});
  assert.equal(JSON.parse(inspected.stdout).status, 'INSPECTED', inspected.stdout);
  const prepared = run(process.execPath, [join(f.codex, 'scripts/agent/baba-integrate.mjs'), 'prepare', '--branch', f.branch, '--json'],
    {cwd: f.codex, env: agentEnv, allowFail: true, timeout: 300000});
  assert.equal(JSON.parse(prepared.stdout).status, 'PREPARED', prepared.stdout);
  assert.equal(existsSync(marker), false);
  for (const override of [{GIT_SSH_COMMAND: program}, {GIT_EXEC_PATH: f.directory}, {GIT_CONFIG_NOSYSTEM: '1'}, {GIT_TRACE: '1'}]) {
    assert.throws(() => assertNoGitHooks(f.codex, {env: {...agentEnv, ...override}}), error => error.code === 'GIT_ENVIRONMENT_UNVERIFIED');
  }
});

test('D1: core.fsmonitor and diff textconv programs never run in tool Git subprocesses; positive controls prove they are live', () => {
  const f = ready(), monitor = join(f.directory, 'fsmonitor-ran.txt'), converted = join(f.directory, 'textconv-ran.txt');
  git(f.main, ['config', 'core.fsmonitor', `printf ran >> '${slash(monitor)}'; :`]);
  git(f.main, ['config', 'diff.probe.textconv', `printf ran >> '${slash(converted)}'; cat`]);
  const prepared = prepare(f); assert.equal(prepared.status, 'PREPARED', JSON.stringify(prepared));
  put(f.claude, '.gitattributes', '*.ts diff=probe\n'); put(f.claude, 'app/a.ts', 'export const a = 3;\n');
  assert.match(stateFingerprint(f.claude), /^[0-9a-f]{16}$/);
  assert.equal(cli(f.codex, 'baba-handoff.mjs', ['--stdout', '--task-name', 'probe', '--base', 'main']).status, 0);
  assert.equal(existsSync(monitor), false); assert.equal(existsSync(converted), false);
  // Positive controls ONLY in this disposable fixture: plain Git runs both configured programs.
  run('git', ['status', '--porcelain'], {cwd: f.claude}); assert.ok(existsSync(monitor));
  run('git', ['diff'], {cwd: f.claude}); assert.ok(existsSync(converted));
  assert.equal(head(f.main), f.seed);
});

function exercisedCandidate(tests = 'tests/dynamic-exercise.test.mjs') {
  const f = fixture({dynamicImport: true}); commit(f.codex, 'app/exercised-only.ts', 'export const exercised = 1;\n');
  return {f, completed: finish(f, ['--tests', tests])};
}

test('D2: zero auto-matched tests are accepted only with recorded execution evidence, then reproduced on the merged tree', () => {
  const {f, completed} = exercisedCandidate();
  assert.deepEqual(completed.verify.testSelection.explicit, ['tests/dynamic-exercise.test.mjs']);
  assert.deepEqual(completed.verify.testSelection.exercised, {'app/exercised-only.ts': ['tests/dynamic-exercise.test.mjs']});
  assert.equal(completed.verify.gaps.some(gap => /테스트가 참조하지 않는 변경 파일/.test(gap)), false);
  assert.equal(inspect(f).status, 'INSPECTED');
  const prepared = prepare(f); assert.equal(prepared.status, 'PREPARED', JSON.stringify(prepared));
  const merged = JSON.parse(readFileSync(join(f.codex, prepared.integratedVerify), 'utf8'));
  assert.deepEqual(merged.testSelection.exercised, {'app/exercised-only.ts': ['tests/dynamic-exercise.test.mjs']});
  // New main stops loading the file: the inherited evidence is not reproduced and prepare is blocked.
  commit(f.main, 'tests/dynamic-exercise.test.mjs', `import test from 'node:test'; import assert from 'node:assert/strict';
    test('loads nothing', () => assert.ok(true));\n`); git(f.main, ['push', 'origin', 'main']);
  const stale = prepare(f); assert.equal(stale.code, 'INTEGRATED_VERIFY_FAILED', JSON.stringify(stale));
  assert.match(stale.reason, /PREPARE_EXERCISE_NOT_REPRODUCED|VERIFY_TEST_SCOPE_INSUFFICIENT/);
});

test('D2: tests that do not load the changed code, read it only, or forged evidence stay blocked', () => {
  const unrelated = exercisedCandidate('tests/check.test.mjs');
  assert.ok(unrelated.completed.verify.gaps.some(gap => /app\/exercised-only\.ts/.test(gap)));
  assert.equal(inspect(unrelated.f).code, 'VERIFY_EVIDENCE_REJECTED');
  // Reading source text is not execution evidence for a code file.
  const f = fixture({dynamicImport: true}); commit(f.codex, 'app/exercised-only.ts', 'export const exercised = 1;\n');
  commit(f.codex, 'tests/read-only.test.mjs', `import test from 'node:test'; import assert from 'node:assert/strict'; import {readdirSync, readFileSync} from 'node:fs';
    test('reads sources', () => { for (const name of readdirSync('app')) assert.ok(readFileSync('app/' + name, 'utf8').length); });\n`);
  const readOnly = finish(f, ['--tests', 'tests/read-only.test.mjs']);
  assert.equal(readOnly.verify.testSelection.exercised['app/exercised-only.ts'], undefined);
  assert.equal(inspect(f).code, 'VERIFY_EVIDENCE_REJECTED');
  const good = exercisedCandidate(), archive = JSON.parse(readFileSync(join(good.f.codex, '.tmp-baba/verify/latest.json'), 'utf8'));
  const path = join(good.f.codex, archive.savedAs);
  for (const exercised of [{'app/exercised-only.ts': ['tests/check.test.mjs']}, {'app/a.ts': ['tests/dynamic-exercise.test.mjs']},
    {'app/exercised-only.ts': []}, []]) {
    writeFileSync(path, JSON.stringify({...archive, testSelection: {...archive.testSelection, exercised}}));
    const result = inspect(good.f); assert.equal(result.code, 'VERIFY_EVIDENCE_REJECTED', JSON.stringify(exercised));
  }
});

test('D2: access recorder logs only listed targets, separating module import from file read', () => {
  const directory = mkdtempSync(join(parent, 'recorder-'));
  put(directory, 'code.mjs', 'export const value = 1;\n'); put(directory, 'data.sql', 'select 1;\n'); put(directory, 'other.mjs', 'export {};\n');
  put(directory, 'main.mjs', `import {readFileSync} from 'node:fs'; await import('./code.mjs'); await import('./other.mjs');
    readFileSync(new URL('./data.sql', import.meta.url), 'utf8');\n`);
  const log = join(directory, 'access.log'), recorder = join(source, 'scripts/agent/lib/access-recorder.mjs');
  const targets = ['code.mjs', 'data.sql'].map(name => join(directory, name));
  const result = run(process.execPath, ['--import', `file:///${slash(recorder)}`, join(directory, 'main.mjs')],
    {cwd: directory, env: {...sanitizedEnv().env, BABA_ACCESS_LOG: log, BABA_ACCESS_TARGETS: JSON.stringify(targets)}, allowFail: true});
  assert.equal(result.status, 0, result.stderr);
  const entries = readFileSync(log, 'utf8').trim().split('\n').flatMap(line => JSON.parse(line).entries);
  const kinds = Object.fromEntries(entries.map(entry => [entry.path, entry.kinds]));
  // The ESM loader reads source through fs too, so an imported file is also "read"; only import marks execution.
  assert.deepEqual(Object.keys(kinds).sort(), [...targets].sort());
  assert.ok(kinds[targets[0]].includes('import')); assert.deepEqual(kinds[targets[1]], ['read']);
  // Without a log path the preload is inert and writes nothing.
  const inert = run(process.execPath, ['--import', `file:///${slash(recorder)}`, join(directory, 'main.mjs')],
    {cwd: directory, env: sanitizedEnv().env, allowFail: true});
  assert.equal(inert.status, 0, inert.stderr); assert.equal(readdirSync(directory).filter(name => name.endsWith('.log')).length, 1);
});
