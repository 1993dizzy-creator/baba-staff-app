#!/usr/bin/env node
// Read-only inspection and isolated preparation. No push, deployment or DB execution.
import {createHash, randomUUID} from 'node:crypto';
import {existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, unlinkSync} from 'node:fs';
import {join, relative, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {
  AGENTS, HOT_FILES, POLICY_DOC, apiRouteOf, assertOwnedWorktree, committedChanges, commitFingerprint,
  dbObjectsIn, git, gitOut, identifyWorktree, insideRoot, listWorktrees, matchesAny, parseArgs, repoRoot,
  run, stateFingerprint, workingChanges, worktreeEnvironment, writeRecord,
} from './lib/common.mjs';
import {readTask} from './baba-start.mjs';
import {checkHandoff} from './lib/handoff-format.mjs';
import {verifyEvidence} from './lib/verify-evidence.mjs';

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
function candidateEvidence(root, trees, branch) {
  const match = branch?.match(/^(codex|claude)\/(\d{8}-[a-z0-9]+(?:-[a-z0-9]+)*-\d{2,})$/);
  if (!match) fail('INVALID_CANDIDATE_BRANCH');
  const [, agent, taskId] = match;
  const owner = trees.find(tree => identifyWorktree(tree.path).agent === agent);
  if (!owner || !existsSync(owner.path)) fail('CANDIDATE_OWNER_UNAVAILABLE');
  const record = readTask(owner.path, agent, taskId);
  const head = sha(root, `refs/heads/${branch}`);
  if (!ancestor(root, record.baseSha, head)) fail('TASK_HISTORY_MISMATCH');
  if (owner.branch === branch && workingChanges(owner.path).length) fail('DIRTY_CANDIDATE');
  const handoff = `docs/handoffs/${branch.replace('/', '-')}.md`;
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
  if (savedAs[1] !== verify.verdict || verify.savedAs !== savedAs[2]) problems.push('VERIFY_ARCHIVE_MISMATCH');
  if (problems.length) fail('VERIFY_EVIDENCE_REJECTED', problems.join('; '));
  return {agent, taskId, branch, head, codeHead, baseSha: record.baseSha, owner: owner.path,
    handoff, handoffDigest: digest(text), verify: savedAs[2], verifyDigest: digest(verify), verdict: verify.verdict};
}

export function inspectCandidate(root, branch) {
  const trees = listWorktrees(root);
  const main = trees.find(tree => tree.branch === 'main' && identifyWorktree(tree.path).isOriginal);
  if (!main || !existsSync(main.path)) fail('MAIN_WORKTREE_UNAVAILABLE');
  noOperation(main.path);
  if (workingChanges(main.path).length) fail('DIRTY_MAIN');
  const mainHead = sha(root, 'refs/heads/main');
  if (sha(main.path, 'HEAD') !== mainHead) fail('MAIN_HEAD_MISMATCH');
  const candidate = candidateEvidence(root, trees, branch);
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
  const next = inspectCandidate(root, inspection.candidate.branch);
  // Other active work and immutable verification evidence are approval inputs too.
  if (digest(next) !== digest(inspection)) fail('INPUT_CHANGED_REVALIDATE');
  if (next.blockers.length) fail('INTEGRATION_BLOCKED');
}

function preparation(root, inspection, report) {
  const parent = insideRoot(root, '.tmp-baba/integrate/environments');
  mkdirSync(parent, {recursive: true});
  const directory = mkdtempSync(join(parent, 'prepare-'));
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
  git(sandbox, ['config', 'user.name', 'BABA isolated integration'], options);
  git(sandbox, ['config', 'user.email', 'integration@example.invalid'], options);
  // Independent object database/index/refs: fetching a LOCAL path never mutates source refs.
  for (const [ref, head] of [['main', inspection.main.head], ['candidate', inspection.candidate.head]]) {
    git(sandbox, ['-c', 'protocol.file.allow=always', 'fetch', '--no-tags', '--no-recurse-submodules', root, `${head}:refs/heads/${ref}`], options);
  }
  git(sandbox, ['switch', '-c', `${identifyWorktree(root).agent}/integration-${report.id}`, 'main'], options);
  const merged = git(sandbox, ['merge', '--no-edit', ...(inspection.strategy === 'fast-forward' ? ['--ff-only'] : ['--no-ff']), 'candidate'], {...options, allowFail: true});
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
    // Use the caller's verifier, not a modified candidate copy of the approval gate.
    const checked = run(process.execPath, [join(root, 'scripts/agent/baba-verify.mjs'), '--base', 'main', '--build', '--json'],
      {cwd: sandbox, env: worktreeEnvironment(root, env, sandbox), allowFail: true, timeout: 60 * 60 * 1000});
    let verify;
    try { verify = JSON.parse(checked.stdout); } catch { fail('INTEGRATED_VERIFY_MISSING'); }
    report.integratedVerify = relative(root, join(sandbox, verify.savedAs || '.tmp-baba/verify/latest.json')).split('\\').join('/');
    report.integratedVerifyDigest = digest(verify);
    const problems = verifyEvidence(sandbox, verify, {head: report.mergedHead, fingerprint: stateFingerprint(sandbox), build: true});
    if (checked.status !== 0 || problems.length) fail('INTEGRATED_VERIFY_FAILED', problems.join('; ') || 'baba-verify FAIL');
    report.integratedVerdict = verify.verdict;
  } finally {
    const current = lstatSync(link, {bigint: true});
    if (!current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino || realpathSync(link) !== dependencyTarget) fail('DEPENDENCY_LINK_CHANGED');
    unlinkSync(link); // Only the link made by this run; preserve every source/dependency file.
  }
  stable(root, inspection);
  return sandbox;
}

function approvedMerge(root, args, report) {
  if (!args.approval || !args.prepared) fail('LOCAL_MERGE_APPROVAL_REQUIRED');
  const preparedPath = insideRoot(root, args.prepared);
  const prepared = readJson(preparedPath);
  if (prepared.tool !== 'baba-integrate' || prepared.root !== root || prepared.mode !== 'prepare' || prepared.status !== 'PREPARED') fail('PREPARED_EVIDENCE_INVALID');
  const approval = readJson(insideRoot(root, args.approval));
  const inspection = prepared.inspection;
  if (approval.version !== 1 || approval.action !== 'merge-local-main' || approval.approvedBy !== 'user' || !Number.isFinite(Date.parse(approval.approvedAt)) ||
      approval.branch !== inspection.candidate.branch || approval.candidateHead !== inspection.candidate.head || approval.mainHead !== inspection.main.head ||
      approval.preparedId !== prepared.id || approval.preparedDigest !== digest(prepared)) fail('APPROVAL_SCOPE_MISMATCH');
  if (args.branch && args.branch !== inspection.candidate.branch) fail('APPROVAL_SCOPE_MISMATCH');
  report.inspection = inspection;
  stable(root, inspection);
  const sandbox = insideRoot(root, prepared.environment);
  const verify = readJson(insideRoot(root, prepared.integratedVerify));
  if (digest(verify) !== prepared.integratedVerifyDigest || sha(sandbox, 'HEAD') !== prepared.mergedHead ||
      gitOut(sandbox, ['rev-parse', 'HEAD^{tree}']) !== prepared.mergedTree || workingChanges(sandbox).length ||
      verifyEvidence(sandbox, verify, {head: prepared.mergedHead, fingerprint: stateFingerprint(sandbox), build: true}).length) fail('PREPARED_STATE_CHANGED');
  const parents = gitOut(sandbox, ['rev-list', '--parents', '-n', '1', prepared.mergedHead]).split(' ').slice(1);
  if (inspection.strategy === 'fast-forward' ? prepared.mergedHead !== inspection.candidate.head :
    JSON.stringify(parents) !== JSON.stringify([inspection.main.head, inspection.candidate.head])) fail('PREPARED_PARENTS_MISMATCH');
  // Never run original worktree hooks automatically, even with a valid merge approval.
  const configured = git(root, ['config', '--get', 'core.hooksPath'], {allowFail: true});
  const hooks = configured.status === 0 ? resolve(inspection.main.path, configured.stdout.trim())
    : resolve(root, gitOut(root, ['rev-parse', '--git-path', 'hooks']));
  if (['pre-merge-commit', 'post-merge', 'reference-transaction'].some(hook => existsSync(join(hooks, hook)))) fail('ACTIVE_GIT_HOOK');
  git(root, ['fetch', '--no-write-fetch-head', '--no-tags', '--no-recurse-submodules', sandbox, prepared.mergedHead]);
  stable(root, inspection);
  // Only mutation of original main in this tool. It is explicitly outside inspect/prepare.
  git(inspection.main.path, ['merge', '--ff-only', prepared.mergedHead]);
  report.mainHeadAfter = sha(root, 'refs/heads/main');
  if (report.mainHeadAfter !== prepared.mergedHead) fail('MERGED_HEAD_UNEXPECTED');
  report.approval = {path: relative(root, insideRoot(root, args.approval)), digest: digest(approval)};
  report.status = 'MERGED_LOCAL';
}

export function integrate(args, cwd = process.cwd()) {
  const report = {tool: 'baba-integrate', version: 1, policy: POLICY_DOC, id: randomUUID(),
    generatedAt: new Date().toISOString(), mode: args._?.[0] || 'inspect', status: 'BLOCKED',
    permissions: {push: false, productionDeploy: false, productionDb: false, migrationApply: false}};
  let root;
  try {
    root = repoRoot(cwd); assertOwnedWorktree(root); report.root = root;
    insideRoot(root, cwd);
    if (!['inspect', 'prepare', 'merge'].includes(report.mode)) fail('UNSUPPORTED_ACTION_NO_REMOTE_OR_DB');
    if (args._?.length > 1 || Object.keys(args).some(key => !['_', 'branch', 'approval', 'prepared', 'json'].includes(key))) fail('INVALID_ARGUMENTS');
    if (report.mode === 'merge') approvedMerge(root, args, report);
    else {
      if (args.approval || args.prepared) fail('APPROVAL_ONLY_FOR_EXPLICIT_MERGE');
      const inspection = inspectCandidate(root, args.branch); report.inspection = inspection;
      if (inspection.blockers.length) fail('INTEGRATION_BLOCKED', inspection.blockers.map(b => b.code).join('; '));
      report.status = 'INSPECTED';
      if (report.mode === 'prepare') {
        preparation(root, inspection, report);
        report.status = 'PREPARED';
        report.approvalRequired = {action: 'merge-local-main', branch: inspection.candidate.branch,
          candidateHead: inspection.candidate.head, mainHead: inspection.main.head, preparedId: report.id};
      }
    }
  } catch (error) {
    report.status = 'BLOCKED'; report.code = error.code || 'UNVERIFIED_STATE';
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
    const args = parseArgs(process.argv.slice(2), {branch: 'string', approval: 'string', prepared: 'string', json: 'boolean', help: 'boolean'});
    if (args.help) console.log('node scripts/agent/baba-integrate.mjs [inspect|prepare] --branch <agent/task> [--json]\nnode scripts/agent/baba-integrate.mjs merge --prepared <local-report.json> --approval <local-user-approval.json>');
    else {
      if (['branch', 'approval', 'prepared'].some(key => Object.hasOwn(args, key) &&
          (typeof args[key] !== 'string' || !args[key] || args[key].startsWith('--')))) fail('INVALID_ARGUMENTS');
      const result = integrate(args);
      console.log(args.json ? JSON.stringify(result, null, 2) : `BABA Integrate: ${result.status}\n${result.code || ''} ${result.reason || ''}\n기록: ${result.savedAs || '없음'}`);
      process.exitCode = result.status === 'BLOCKED' ? 2 : 0;
    }
  } catch { console.error('옵션이 잘못됐다. --help를 확인한다.'); process.exitCode = 2; }
}
