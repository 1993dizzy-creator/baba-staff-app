#!/usr/bin/env node
// Read-only inspection and isolated preparation. No push, deployment or DB execution.
import {createHash, randomUUID} from 'node:crypto';
import {existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, unlinkSync} from 'node:fs';
import {join, relative, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {
  AGENTS, AGENT_WORKFLOW_PATHS, HOT_FILES, POLICY_DOC, apiRouteOf, assertNoGitHooks, guardedGit, assertOwnedWorktree, committedChanges, commitFingerprint,
  dbObjectsIn, git, gitOut, identifyWorktree, insideRoot, listWorktrees, matchesAny, parseArgs, repoRoot,
  relatedTests, run, stateFingerprint, workingChanges, worktreeEnvironment, writeRecord,
} from './lib/common.mjs';
import {readTask} from './baba-start.mjs';
import {checkHandoff} from './lib/handoff-format.mjs';
import {verifyEvidence} from './lib/verify-evidence.mjs';
import {remoteMainState} from './lib/remote-main.mjs';

const SHA = /^[0-9a-f]{40}$/;
const fail = (code, message = code) => { throw Object.assign(new Error(message), {code}); };
const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const samePath = (a, b) => resolve(a).toLowerCase() === resolve(b).toLowerCase();
const sha = (root, ref) => gitOut(root, ['rev-parse', '--verify', `${ref}^{commit}`]);
const ancestor = (root, a, b) => {
  const result = git(root, ['merge-base', '--is-ancestor', a, b], {allowFail: true});
  if (![0, 1].includes(result.status)) fail('UNKNOWN_HISTORY');
  return result.status === 0;
};
const paths = entries => [...new Set(entries.flatMap(entry => [entry.path, entry.from].filter(Boolean)))];
const field = (text, name) => text.match(new RegExp(`^- ${name}: (.+)$`, 'm'))?.[1];

function noOperation(root) {
  for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-apply', 'rebase-merge', 'sequencer', 'BISECT_LOG']) {
    if (existsSync(resolve(root, gitOut(root, ['rev-parse', '--git-path', marker])))) fail('GIT_OPERATION_IN_PROGRESS');
  }
}

function contracts(root, changed, ref) {
  const result = {paths: changed, apis: [], tables: [], rpcs: [], schema: []};
  for (const path of changed) {
    const api = apiRouteOf(path);
    if (api) result.apis.push(api);
    if (/^(supabase\/|lib\/supabase\/)|\.sql$/i.test(path)) result.schema.push(path);
    if (!/^(app|lib)\/.*\.(tsx?|js)$/.test(path)) continue;
    const content = ref ? git(root, ['show', `${ref}:${path}`], {allowFail: true}).stdout
      : existsSync(insideRoot(root, path)) ? readFileSync(insideRoot(root, path), 'utf8') : '';
    const db = dbObjectsIn(content);
    result.tables.push(...db.tables); result.rpcs.push(...db.rpcs);
  }
  return result;
}

// Validate committed handoff + immutable report, even after the owner starts another task.
function candidateEvidence(root, trees, branch, handoffPath) {
  const match = branch?.match(/^(codex|claude)\/(\d{8}-[a-z0-9]+(?:-[a-z0-9]+)*-\d{2,})$/);
  if (!match) fail('INVALID_CANDIDATE_BRANCH');
  const [, agent, taskId] = match;
  const owner = trees.find(tree => identifyWorktree(tree.path).agent === agent);
  if (!owner || !existsSync(owner.path)) fail('CANDIDATE_OWNER_UNAVAILABLE');
  const record = readTask(owner.path, agent, taskId);
  const head = sha(root, `refs/heads/${branch}`);
  if (!ancestor(root, record.baseSha, head)) fail('TASK_HISTORY_MISMATCH');
  if (owner.branch === branch && workingChanges(owner.path).length) fail('DIRTY_CANDIDATE');
  const stem = `docs/handoffs/${branch.replace('/', '-')}`;
  const handoff = handoffPath || `${stem}.md`;
  if (!(handoff === `${stem}.md` || handoff.startsWith(`${stem}-`)) || !handoff.endsWith('.md') || handoff.includes('..') || handoff.includes('\\')) fail('HANDOFF_PATH_INVALID');
  const raw = git(root, ['show', `${head}:${handoff}`], {allowFail: true});
  if (raw.status !== 0) fail('HANDOFF_MISSING');
  const text = raw.stdout.replace(/\r\n/g, '\n');
  if (checkHandoff(text).length) fail('HANDOFF_INVALID');
  if (field(text, '작업 ID') !== taskId || field(text, '작업 브랜치') !== branch ||
      field(text, '담당 AI') !== (agent === 'codex' ? 'Codex' : 'Claude Code')) fail('HANDOFF_IDENTITY_MISMATCH');
  const codeHead = field(text, 'HEAD SHA');
  if (!SHA.test(codeHead || '') || git(root, ['rev-parse', '--verify', '--quiet', `${codeHead}^{commit}`], {allowFail: true}).status !== 0 || !ancestor(root, codeHead, head) ||
      paths(committedChanges(root, codeHead, head)).some(path => path !== handoff)) fail('HANDOFF_SHA_MISMATCH');
  const fingerprint = commitFingerprint(root, head).digest('hex').slice(0, 16);
  if (field(text, '검증 상태 지문') !== fingerprint) fail('HANDOFF_FINGERPRINT_MISMATCH');
  const savedAs = text.match(/^- baba-verify 판정: \*\*(PASS(?:_WITH_PREEXISTING)?)\*\* \([^,]+, (\.tmp-baba\/verify\/[^\s()]+\.json)\)$/m);
  if (!savedAs || savedAs[2].endsWith('/latest.json')) fail('VERIFY_ARCHIVE_MISSING');
  const archive = insideRoot(owner.path, savedAs[2]);
  const verify = readJson(archive);
  const problems = verifyEvidence(owner.path, verify, {head: codeHead, branch, fingerprint});
  if (!SHA.test(verify.baseSha || '') || git(root, ['cat-file', '-e', `${verify.baseSha}^{commit}`], {allowFail: true}).status !== 0 ||
      !ancestor(root, record.baseSha, verify.baseSha) || !ancestor(root, verify.baseSha, 'refs/heads/main') ||
      gitOut(root, ['merge-base', codeHead, verify.baseSha]) !== verify.mergeBase) problems.push('VERIFY_BASE_SHA_MISMATCH');
  const withoutHandoffs = entries => paths(entries).filter(path => !path.startsWith('docs/handoffs/')).sort();
  if (SHA.test(verify.mergeBase || '') && JSON.stringify(withoutHandoffs(committedChanges(root, verify.mergeBase, codeHead))) !==
      JSON.stringify(withoutHandoffs(verify.changedFiles || []))) problems.push('VERIFY_CHANGED_SCOPE_MISMATCH');
  if (savedAs[1] !== verify.verdict || verify.savedAs !== savedAs[2]) problems.push('VERIFY_ARCHIVE_MISMATCH');
  if (problems.length) fail('VERIFY_EVIDENCE_REJECTED', problems.join('; '));
  return {agent, taskId, branch, head, codeHead, baseSha: record.baseSha, owner: owner.path,
    handoff, handoffDigest: digest(text), verify: savedAs[2], verifyDigest: digest(verify), verdict: verify.verdict,
    testSelection: verify.testSelection, verifiedBase: verify.baseSha};
}

export function inspectCandidate(root, branch, handoff) {
  assertNoGitHooks(root);
  const trees = listWorktrees(root);
  const main = trees.find(tree => tree.branch === 'main' && identifyWorktree(tree.path).isOriginal);
  if (!main || !existsSync(main.path)) fail('MAIN_WORKTREE_UNAVAILABLE');
  assertNoGitHooks(main.path);
  noOperation(main.path);
  if (workingChanges(main.path).length) fail('DIRTY_MAIN');
  const mainHead = sha(root, 'refs/heads/main');
  if (sha(main.path, 'HEAD') !== mainHead) fail('MAIN_HEAD_MISMATCH');
  const candidate = candidateEvidence(root, trees, branch, handoff);
  const base = gitOut(root, ['merge-base', mainHead, candidate.head]);
  if (ancestor(root, candidate.head, mainHead)) fail('ALREADY_IN_MAIN');
  const changed = paths(committedChanges(root, base, candidate.head));
  const contract = contracts(root, changed, candidate.head);
  const blockers = [];
  if (contract.schema.length) blockers.push({code: 'SCHEMA_REVIEW_REQUIRED', paths: contract.schema});
  if (contract.apis.length) blockers.push({code: 'SHARED_API_REVIEW_REQUIRED', apis: contract.apis});
  const others = [];
  for (const tree of trees) {
    if (samePath(tree.path, main.path) || tree.branch === branch) continue;
    if (!existsSync(tree.path)) fail('OTHER_WORKTREE_UNAVAILABLE');
    assertNoGitHooks(tree.path);
    noOperation(tree.path);
    const otherHead = sha(tree.path, 'HEAD');
    const otherBase = gitOut(root, ['merge-base', mainHead, otherHead]);
    const changes = [...committedChanges(root, otherBase, otherHead), ...workingChanges(tree.path)];
    const changedOther = paths(changes).filter(path => !path.startsWith('docs/handoffs/'));
    const identity = identifyWorktree(tree.path);
    const waiting = identity.agent && (tree.branch === `${identity.agent}/idle` || tree.branch.startsWith(`${identity.agent}/ready-`));
    let scope = [], active = !waiting && Boolean(identity.agent);
    if (active) {
      const id = tree.branch.slice(AGENTS[identity.agent].branchPrefix.length);
      try { scope = readTask(tree.path, identity.agent, id).files; }
      catch { fail('OTHER_ACTIVE_TASK_UNKNOWN'); }
    }
    const overlap = changed.filter(path => !path.startsWith('docs/handoffs/') &&
      (changedOther.includes(path) || (active && matchesAny(path, scope))));
    const otherContract = contracts(tree.path, changedOther);
    const shared = {tables: contract.tables.filter(x => otherContract.tables.includes(x)), rpcs: contract.rpcs.filter(x => otherContract.rpcs.includes(x))};
    if (overlap.length || shared.tables.length || shared.rpcs.length) blockers.push({code: 'ACTIVE_WORKTREE_CONFLICT', branch: tree.branch, overlap, shared});
    others.push({path: tree.path, branch: tree.branch, head: otherHead, active, scope, changed: changedOther, overlap, shared});
  }
  return {main: {path: main.path, head: mainHead}, candidate, base, changed, contracts: contract,
    hotFiles: changed.filter(path => matchesAny(path, HOT_FILES)), others, blockers,
    strategy: ancestor(root, mainHead, candidate.head) ? 'fast-forward' : 'merge',
    revalidationRequired: !ancestor(root, mainHead, candidate.head)};
}

function stable(root, inspection) {
  const next = inspectCandidate(root, inspection.candidate.branch, inspection.candidate.handoff);
  // Other active work and immutable verification evidence are approval inputs too.
  if (digest(next) !== digest(inspection)) fail('INPUT_CHANGED_REVALIDATE');
  if (next.blockers.length) fail('INTEGRATION_BLOCKED');
}

export function prepareTestSelection(root, changed, mainChanged, selection) {
  const agentChanged = changed.some(path => matchesAny(path, AGENT_WORKFLOW_PATHS));
  // Already-integrated tool history is not a reason to rerun its fixtures for a UI candidate.
  const relevantMain = mainChanged.filter(path => agentChanged || !matchesAny(path, AGENT_WORKFLOW_PATHS));
  const coverage = relatedTests(root, [...new Set([...changed, ...relevantMain])].filter(path => !path.startsWith('docs/handoffs/')));
  const required = new Set([...(selection.explicit || []), ...Object.values(selection.exercised || {}).flat()]);
  const inherited = selection.executed.filter(test => agentChanged || !test.startsWith('tests/agent-workflow-') || required.has(test));
  return {coverage, testPaths: [...new Set([...inherited, ...coverage.tests.map(test => test.path)])].sort()};
}

function preparation(root, inspection, report) {
  report.remote = remoteMainState(root, {allowLocalAhead: true});
  // Keep nested prepare + fixture + baseline paths below native temporary-path limits.
  const parent = insideRoot(root, '.tmp-baba/i');
  mkdirSync(parent, {recursive: true});
  const directory = mkdtempSync(join(parent, 'p-'));
  const sandbox = insideRoot(root, join(directory, AGENTS[identifyWorktree(root).agent].worktreeDir));
  mkdirSync(sandbox);
  report.environment = relative(root, sandbox).split('\\').join('/');
  const env = worktreeEnvironment(root);
  for (const name of Object.keys(env)) if (/^GIT_/i.test(name)) delete env[name];
  env.GIT_TERMINAL_PROMPT = '0'; env.GCM_INTERACTIVE = 'never';
  const options = {env};
  git(sandbox, ['init', '-b', `${identifyWorktree(root).agent}/bootstrap`], options);
  const hooks = insideRoot(root, join(sandbox, '.tmp-baba/empty-hooks'));
  mkdirSync(hooks, {recursive: true});
  git(sandbox, ['config', 'core.hooksPath', hooks], options);
  guardedGit(sandbox, ['config', 'user.name', 'BABA isolated integration'], options);
  guardedGit(sandbox, ['config', 'user.email', 'integration@example.invalid'], options);
  // Independent object database/index/refs: fetching a LOCAL path never mutates source refs.
  for (const [ref, head] of [['main', inspection.main.head], ['candidate', inspection.candidate.head]]) {
    guardedGit(sandbox, ['-c', 'protocol.file.allow=always', 'fetch', '--no-tags', '--no-recurse-submodules', root, `${head}:refs/heads/${ref}`], options);
  }
  guardedGit(sandbox, ['switch', '-c', `${identifyWorktree(root).agent}/integration-${report.id}`, 'main'], options);
  const merged = guardedGit(sandbox, ['merge', '--no-edit', ...(inspection.strategy === 'fast-forward' ? ['--ff-only'] : ['--no-ff']), 'candidate'], {...options, allowFail: true});
  report.merge = {strategy: inspection.strategy, exitCode: merged.status};
  writeRecord(root, join(directory, 'merge.json'), {exitCode: merged.status, unmerged: gitOut(sandbox, ['diff', '--name-only', '--diff-filter=U'])});
  if (merged.status !== 0) fail('CODE_CONFLICT', '격리된 병합 실패. 충돌 환경과 증거를 보존했다.');
  report.mergedHead = sha(sandbox, 'HEAD');
  report.mergedTree = gitOut(sandbox, ['rev-parse', 'HEAD^{tree}']);
  const dependencies = insideRoot(root, 'node_modules');
  if (!existsSync(dependencies)) fail('DEPENDENCIES_MISSING');
  const dependencyTarget = realpathSync(dependencies);
  const link = insideRoot(root, join(sandbox, 'node_modules'));
  symlinkSync(dependencyTarget, link, 'junction');
  const identity = lstatSync(link, {bigint: true});
  try {
    const mainChanged = paths(committedChanges(root, inspection.base, inspection.main.head));
    const {coverage, testPaths} = prepareTestSelection(sandbox, inspection.changed, mainChanged, inspection.candidate.testSelection);
    // Unreferenced files pass only with the candidate's recorded execution evidence (D2), which the
    // integrated Verify below must reproduce on the merged tree. No evidence still blocks.
    const inherited = inspection.candidate.testSelection.exercised || {};
    const unproven = coverage.untested.filter(path => !inherited[path]?.length);
    if (unproven.length) fail('TEST_SCOPE_INSUFFICIENT', unproven.join(', '));
    for (const path of testPaths) if (!existsSync(insideRoot(sandbox, path))) fail('PREPARE_TEST_MISSING');
    if (!testPaths.length) fail('PREPARE_TESTS_EMPTY');
    report.testSelection = {inherited: inspection.candidate.testSelection, executed: testPaths, mainChanged};
    // Use the caller's verifier, not a modified candidate copy of the approval gate.
    const checked = run(process.execPath, [join(root, 'scripts/agent/baba-verify.mjs'), '--base', 'main', '--build', '--json',
      '--tests', testPaths.join(','), ...(inspection.candidate.testSelection.allTests ? ['--all-tests'] : [])],
      {cwd: sandbox, env: worktreeEnvironment(root, env, sandbox), allowFail: true, timeout: 60 * 60 * 1000});
    let verify;
    try { verify = JSON.parse(checked.stdout); } catch { fail('INTEGRATED_VERIFY_MISSING'); }
    report.integratedVerify = relative(root, join(sandbox, verify.savedAs || '.tmp-baba/verify/latest.json')).split('\\').join('/');
    report.integratedVerifyDigest = digest(verify);
    const problems = verifyEvidence(sandbox, verify, {head: report.mergedHead, fingerprint: stateFingerprint(sandbox), build: true});
    if (verify.baseSha !== inspection.main.head || testPaths.some(path => !verify.testSelection?.executed?.includes(path))) problems.push('PREPARE_TEST_EVIDENCE_MISMATCH');
    if (coverage.untested.some(path => !verify.testSelection?.exercised?.[path]?.length)) problems.push('PREPARE_EXERCISE_NOT_REPRODUCED');
    if (checked.status !== 0 || problems.length) fail('INTEGRATED_VERIFY_FAILED', problems.join('; ') || 'baba-verify FAIL');
    report.integratedVerdict = verify.verdict;
  } finally {
    const current = lstatSync(link, {bigint: true});
    if (!current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino || realpathSync(link) !== dependencyTarget) fail('DEPENDENCY_LINK_CHANGED');
    unlinkSync(link); // Only the link made by this run; preserve every source/dependency file.
  }
  stable(root, inspection);
  if (digest(remoteMainState(root, {allowLocalAhead: true})) !== digest(report.remote)) fail('REMOTE_CHANGED_REVALIDATE');
  return sandbox;
}

export function integrate(args, cwd = process.cwd()) {
  const report = {tool: 'baba-integrate', version: 1, policy: POLICY_DOC, id: randomUUID(),
    generatedAt: new Date().toISOString(), mode: args._?.[0] || 'inspect', status: 'BLOCKED',
    permissions: {localMainMerge: false, push: false, productionDeploy: false, productionDb: false, migrationApply: false}};
  let root;
  try {
    root = repoRoot(cwd); assertOwnedWorktree(root); report.root = root;
    assertNoGitHooks(root);
    insideRoot(root, cwd);
    if (!['inspect', 'prepare', 'merge'].includes(report.mode)) fail('UNSUPPORTED_ACTION_NO_REMOTE_OR_DB');
    if (args._?.length > 1 || Object.keys(args).some(key => !['_', 'branch', 'handoff', 'approval', 'prepared', 'json'].includes(key))) fail('INVALID_ARGUMENTS');
    if (report.mode === 'merge') {
      report.remote = remoteMainState(root);
      if (args.prepared) {
        const prepared = readJson(insideRoot(root, args.prepared));
        if (prepared.remote?.remote !== report.remote.remote || prepared.inspection?.main?.head !== report.remote.local) fail('REMOTE_OR_MAIN_CHANGED_REVALIDATE');
      }
      fail('LOCAL_MAIN_EXECUTION_DISABLED', 'Full Access files cannot authenticate user approval. Execute main integration directly or use an independent authority.');
    }
    else {
      if (args.approval || args.prepared) fail('APPROVAL_ONLY_FOR_EXPLICIT_MERGE');
      const inspection = inspectCandidate(root, args.branch, args.handoff); report.inspection = inspection;
      if (inspection.blockers.length) fail('INTEGRATION_BLOCKED', inspection.blockers.map(b => b.code).join('; '));
      report.remote = remoteMainState(root, {allowLocalAhead: true});
      report.status = 'INSPECTED';
      if (report.mode === 'prepare') {
        preparation(root, inspection, report);
        report.status = 'PREPARED';
        report.approvalRequired = {action: 'merge-local-main', branch: inspection.candidate.branch,
          candidateHead: inspection.candidate.head, mainHead: inspection.main.head, preparedId: report.id, executionDisabled: true};
      }
    }
  } catch (error) {
    report.status = 'BLOCKED'; report.code = error.code || 'UNVERIFIED_STATE';
    if (error.remote) report.remote = error.remote;
    report.reason = error.code ? error.message : '확인할 수 없는 파일·Git·증거 상태. 기존 결과를 보존하고 중단한다.';
  }
  // Only the owning worktree receives managed output. No report in original main or Claude.
  if (root && report.root) {
    try {
      if (git(root, ['check-ignore', '-q', '--no-index', '.tmp-baba/integrate'], {allowFail: true}).status !== 0) fail('OUTPUT_NOT_IGNORED');
      report.savedAs = `.tmp-baba/integrate/runs/${report.generatedAt.replace(/[:.]/g, '-')}-${report.id}.json`;
      writeRecord(root, report.savedAs, report);
      writeRecord(root, '.tmp-baba/integrate/latest.json', report, {replace: true});
    } catch { report.status = 'BLOCKED'; report.code = 'OUTPUT_BOUNDARY_OR_WRITE_FAILED'; report.savedAs = null; }
  }
  return report;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = parseArgs(process.argv.slice(2), {branch: 'string', handoff: 'string', approval: 'string', prepared: 'string', json: 'boolean', help: 'boolean'});
    if (args.help) console.log('node scripts/agent/baba-integrate.mjs [inspect|prepare] --branch <agent/task> [--handoff docs/handoffs/file.md] [--json]\nmerge is disabled: independent user authentication is unavailable.');
    else {
      if (['branch', 'handoff', 'approval', 'prepared'].some(key => Object.hasOwn(args, key) &&
          (typeof args[key] !== 'string' || !args[key] || args[key].startsWith('--')))) fail('INVALID_ARGUMENTS');
      const result = integrate(args);
      console.log(args.json ? JSON.stringify(result, null, 2) : `BABA Integrate: ${result.status}\n${result.code || ''} ${result.reason || ''}\n기록: ${result.savedAs || '없음'}`);
      process.exitCode = result.status === 'BLOCKED' ? 2 : 0;
    }
  } catch { console.error('옵션이 잘못됐다. --help를 확인한다.'); process.exitCode = 2; }
}
