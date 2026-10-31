import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {integrate} from '../scripts/agent/baba-integrate.mjs';
import {assertNoGitHooks, guardedGit, git, gitOut, run, sanitizedEnv, stateFingerprint, writeRecord} from '../scripts/agent/lib/common.mjs';
import {remoteMainState} from '../scripts/agent/lib/remote-main.mjs';

import {source, parent, put, head, commit, cli, fixture, verify, finish, ready, inspect, prepare, approval} from './agent-workflow-integrate-fixture.mjs';

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
