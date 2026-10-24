#!/usr/bin/env node
// Prepare/resume one task in the calling agent's worktree. Never move main or discard work.
import {createHash, randomUUID} from 'node:crypto';
import {existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync} from 'node:fs';
import {join, relative, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {
  AGENTS, POLICY_DOC, assertOwnedWorktree, committedChanges, git, gitOut, identifyWorktree, insideRoot,
  listWorktrees, matchesAny, parseArgs, repoRoot, run, splitList, workingChanges,
} from './lib/common.mjs';

const RECORD_DIR = '.tmp-baba/start';
const TASK_ID = /^\d{8}-[a-z0-9]+(?:-[a-z0-9]+)*-\d{2,}$/;
const digest = text => createHash('sha256').update(text).digest('hex');
const samePath = (a, b) => resolve(a).toLowerCase() === resolve(b).toLowerCase();
const fail = (code, message) => { throw Object.assign(new Error(message), {code}); };
const readJson = path => {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { fail('INVALID_RECORD', '작업/잠금 기록을 읽을 수 없다. 기존 파일을 보존하고 확인한다.'); }
};
const branchAt = root => gitOut(root, ['branch', '--show-current']);
const shaAt = (root, ref) => gitOut(root, ['rev-parse', '--verify', `${ref}^{commit}`]);
const ancestor = (root, older, newer) => {
  const result = git(root, ['merge-base', '--is-ancestor', older, newer], {allowFail: true});
  if (![0, 1].includes(result.status)) fail('UNKNOWN_HISTORY', '커밋 관계를 확인할 수 없다.');
  return result.status === 0;
};

function readTask(root, agent, taskId) {
  if (!TASK_ID.test(taskId)) fail('INVALID_TASK_ID', '재개 작업 ID 형식이 잘못됐다.');
  const path = insideRoot(root, `${RECORD_DIR}/tasks/${taskId}.json`);
  if (!existsSync(path)) fail('MISSING_RECORD', '기존 작업 기록이 없다. 브랜치를 임의로 채택하지 않는다.');
  const record = readJson(path);
  if (record.version !== 1 || record.agent !== agent || record.taskId !== taskId ||
      record.branch !== `${agent}/${taskId}` || !samePath(record.root || '', root) ||
      !/^[0-9a-f]{40}$/.test(record.baseSha || '') || typeof record.task !== 'string' ||
      !Array.isArray(record.files) || !record.files.length || typeof record.slug !== 'string' ||
      record.taskKey !== digest(`${record.task}\0${record.slug}`)) {
    fail('INVALID_RECORD', '작업 기록의 소유권·브랜치·기준 SHA가 일치하지 않는다.');
  }
  return record;
}

function preflight(root, agent, task, files) {
  const result = run(process.execPath, [join(root, 'scripts/agent/baba-preflight.mjs'), '--task', task,
    '--agent', agent, '--files', files.join(','), '--base', 'main', '--json'], {cwd: root, allowFail: true, timeout: 120000});
  let report;
  try { report = JSON.parse(result.stdout); } catch { fail('PREFLIGHT_ERROR', 'Preflight 결과를 해석할 수 없다.'); }
  if (result.status !== 0 || report.verdict === '불가' || !Array.isArray(report.others)) {
    fail('PREFLIGHT_BLOCKED', `Preflight 차단: ${(report.blockers || []).join('; ')}`);
  }
  for (const other of report.others) {
    if (other.error) fail('OTHER_WORKTREE_UNVERIFIED', '다른 Worktree 상태를 확인하지 못했다. 충돌 검사를 생략하지 않는다.');
    if (!existsSync(other.path)) fail('OTHER_WORKTREE_UNVERIFIED', '등록된 다른 Worktree가 없어 상태를 확인할 수 없다.');
    const otherHead = shaAt(other.path, 'HEAD');
    const base = gitOut(root, ['merge-base', 'refs/heads/main', otherHead]);
    // Include rename sources: a future edit of the old filename also conflicts.
    const changed = [...workingChanges(other.path), ...committedChanges(root, base, otherHead)]
      .flatMap(entry => [entry.path, entry.from].filter(Boolean));
    // Preflight supplies changed paths; retain glob intent for files not yet present here.
    const overlap = [...new Set([...other.overlap, ...other.uncommitted, ...other.committed, ...changed].filter(path =>
      other.overlap.includes(path) || matchesAny(path, files)))];
    if (overlap.length) fail('WORKTREE_CONFLICT', `${other.branch} 작업과 겹치는 파일: ${overlap.join(', ')}`);
  }
  return report;
}

function synchronize(root, report) {
  const advertised = git(root, ['ls-remote', '--exit-code', 'origin', 'refs/heads/main'], {allowFail: true, timeout: 60000});
  if (advertised.status !== 0) fail('REMOTE_UNAVAILABLE', 'origin/main을 읽지 못했다. 원격 URL·인증·연결을 확인한다(비밀값 미출력).');
  const remote = advertised.stdout.match(/^([0-9a-f]{40})\s+refs\/heads\/main\s*$/)?.[1];
  if (!remote) fail('REMOTE_UNKNOWN', '원격 main SHA가 불명확하다.');
  const cached = git(root, ['rev-parse', '--verify', 'refs/remotes/origin/main'], {allowFail: true});
  let fetched = false;
  if (cached.status !== 0 || cached.stdout.trim() !== remote) {
    const result = git(root, ['fetch', '--no-tags', 'origin', 'refs/heads/main:refs/remotes/origin/main'], {allowFail: true, timeout: 120000});
    if (result.status !== 0) fail('FETCH_FAILED', 'main 참조 fetch 실패. 강제 갱신·prune·이력 복구를 시도하지 않는다.');
    fetched = true;
  }
  const tracked = shaAt(root, 'refs/remotes/origin/main');
  if (tracked !== remote) fail('REMOTE_CHANGED', '원격 main이 조사 중 변경됐다. 재확인이 필요하다.');
  const local = shaAt(root, 'refs/heads/main');
  const [localOnly, remoteOnly] = gitOut(root, ['rev-list', '--left-right', '--count', `${local}...${remote}`]).split(/\s+/).map(Number);
  report.synchronization = {localMain: local, remoteMain: remote, localOnly, remoteOnly, fetched,
    relation: remoteOnly ? (localOnly ? 'diverged' : 'remote-ahead') : localOnly ? 'local-ahead' : 'equal'};
  if (!ancestor(root, remote, local)) {
    if (ancestor(root, local, remote)) fail('REMOTE_AHEAD', `원격에만 ${remoteOnly}커밋이 있다. main을 자동 병합/변경하지 않는다.`);
    fail('DIVERGED_MAIN', `로컬에만 ${localOnly}, 원격에만 ${remoteOnly}커밋이 있다. main을 변경하지 않고 중단한다.`);
  }
  return report.synchronization;
}

function acquireLock(root, resume) {
  const path = insideRoot(root, `${RECORD_DIR}/start.lock`);
  if (existsSync(path)) {
    const original = lstatSync(path, {bigint: true});
    if (!original.isFile() || original.isSymbolicLink()) fail('START_LOCKED', '일반 파일이 아닌 잠금은 변경하지 않는다.');
    const previous = readJson(path);
    let absent = false;
    if (Number.isSafeInteger(previous.pid) && previous.pid > 0) {
      try { process.kill(previous.pid, 0); } catch (error) { absent = error.code === 'ESRCH'; }
    }
    if (!resume || !absent) fail('START_LOCKED', '다른 시작 실행 또는 잠금 기록이 있다. 활성/불명확 잠금은 제거하지 않는다.');
    const current = lstatSync(path, {bigint: true});
    if (current.dev !== original.dev || current.ino !== original.ino || JSON.stringify(readJson(path)) !== JSON.stringify(previous)) fail('START_LOCKED', '검사 중 잠금이 변경됐다.');
    const archive = insideRoot(root, `${RECORD_DIR}/abandoned-lock-${randomUUID()}.json`);
    renameSync(path, archive); // Preserve dead-process evidence; never delete another process's lock.
  }
  const nonce = randomUUID();
  try { writeFileSync(path, JSON.stringify({pid: process.pid, nonce}), {flag: 'wx'}); }
  catch { fail('START_LOCKED', '동시에 다른 시작 실행이 진행 중이거나 잠금을 만들 수 없다.'); }
  const stat = lstatSync(path, {bigint: true});
  return () => {
    const current = lstatSync(path, {bigint: true});
    if (!current.isFile() || current.isSymbolicLink() || current.dev !== stat.dev || current.ino !== stat.ino || readJson(path).nonce !== nonce) {
      fail('LOCK_CHANGED', '잠금 소유권이 바뀌어 정리하지 않는다.');
    }
    unlinkSync(path); // Only this invocation's own regular lock file.
  };
}

function finished(root, record) {
  if (!record) return false;
  const head = shaAt(root, 'HEAD');
  if (head !== record.baseSha && ancestor(root, head, 'refs/heads/main')) return true;
  const handoff = insideRoot(root, `docs/handoffs/${record.branch.replace('/', '-')}.md`);
  if (!existsSync(handoff)) return false;
  const text = readFileSync(handoff, 'utf8').replace(/\r\n/g, '\n');
  if (!text.includes(`- 작업 ID: ${record.taskId}\n`) || !text.includes(`- 작업 브랜치: ${record.branch}\n`)) return false;
  return run(process.execPath, [join(root, 'scripts/agent/baba-handoff.mjs'), '--check', handoff], {cwd: root, allowFail: true, timeout: 120000}).status === 0;
}

export function startTask(args, cwd = process.cwd()) {
  const report = {tool: 'baba-start', policy: POLICY_DOC, generatedAt: new Date().toISOString(), status: 'BLOCKED', branchCreated: false, savedAs: null};
  let root, directory, release;
  try {
    root = repoRoot(cwd);
    const identity = identifyWorktree(root);
    if (!identity.agent || (args.agent && args.agent !== identity.agent)) fail('WRONG_WORKTREE', '담당 에이전트의 Worktree에서만 시작한다. 원본 main과 다른 에이전트는 수정하지 않는다.');
    assertOwnedWorktree(root);
    const agent = identity.agent, prefix = AGENTS[agent].branchPrefix;
    report.root = root; report.agent = agent; report.branch = branchAt(root);
    for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-apply', 'rebase-merge', 'sequencer', 'BISECT_LOG']) {
      if (existsSync(resolve(root, gitOut(root, ['rev-parse', '--git-path', marker])))) fail('GIT_OPERATION_IN_PROGRESS', '진행 중인 Git 작업을 보존하고 중단한다.');
    }
    if (workingChanges(root).length) fail('DIRTY_WORKTREE', '미커밋 변경을 보존하고 중단한다. 재개 요청도 dirty 상태에서는 전환·정리하지 않는다.');
    const trees = listWorktrees(root);
    if (!trees.some(tree => tree.branch === 'main' && !samePath(tree.path, root))) fail('MISSING_MAIN_WORKTREE', '별도 main Worktree를 확인할 수 없다.');
    const headBefore = shaAt(root, 'HEAD');
    const taskId = args.resume || (report.branch.startsWith(prefix) ? report.branch.slice(prefix.length) : '');
    if (args.resume && !TASK_ID.test(args.resume)) fail('INVALID_TASK_ID', '재개 작업 ID 형식이 잘못됐다.');
    if (args.resume && trees.some(tree => tree.branch === `${prefix}${args.resume}` && !samePath(tree.path, root))) fail('BRANCH_IN_USE', '재개 브랜치를 다른 Worktree가 사용 중이다.');
    const taskPath = TASK_ID.test(taskId) ? insideRoot(root, `${RECORD_DIR}/tasks/${taskId}.json`) : null;
    const record = taskPath && existsSync(taskPath) ? readTask(root, agent, taskId) : null;
    if (args.resume && (!record || record.branch !== report.branch)) fail('RESUME_BRANCH_MISMATCH', '재개는 기록된 현재 브랜치에서만 가능하다. 기존 브랜치로 강제 전환하지 않는다.');
    const task = (args.task || record?.task || '').trim();
    if (!task || task.length > 200 || /[\r\n\0]/.test(task)) fail('INVALID_TASK', '짧은 작업명을 --task로 지정한다. 비밀정보를 작업명에 넣지 않는다.');
    const derived = task.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48).replace(/-$/, '');
    const slug = args.slug || (record?.task === task ? record.slug : derived || `task-${digest(task).slice(0, 10)}`);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 48) fail('INVALID_SLUG', 'slug는 소문자·숫자·하이픈 48자 이내다.');
    const requested = args.files ? splitList(args.files) : record?.files;
    if (!requested?.length || requested.some(file => typeof file !== 'string')) fail('MISSING_SCOPE', '--files로 수정 예정 경로/glob을 지정한다. 모르면 읽기 전용 조사부터 한다.');
    const files = [...new Set(requested.map(file => relative(root, insideRoot(root, file)).split('\\').join('/') || '**'))];
    for (const file of files) {
      if (/(^|[/\\])(?:\.env(?:\.|$)|\.git(?:[/\\]|$))/.test(file)) fail('UNSAFE_SCOPE', '환경 값·Git 메타데이터는 작업 범위로 지정하지 않는다.');
    }
    const taskKey = digest(`${task}\0${slug}`);
    const waiting = report.branch === `${prefix}idle` || report.branch.startsWith(`${prefix}ready-`);
    const resuming = Boolean(record && record.taskKey === taskKey);
    if (args.resume && !resuming) fail('TASK_MISMATCH', '다른 작업으로 기록된 브랜치를 재개하지 않는다.');
    if (!waiting && !record) fail('UNRECORDED_BRANCH', '기록 없는 작업 브랜치를 보존하고 중단한다. 임의로 완료 처리하지 않는다.');
    if (record && !ancestor(root, record.baseSha, headBefore)) fail('REWRITTEN_TASK', '작업 기준 커밋이 현재 이력에 없다. 기록이나 이력을 고치지 않는다.');
    if (!waiting && !resuming && !finished(root, record)) fail('UNFINISHED_TASK', '다른 미완료 작업이 있다. 기존 작업 ID로 재개하거나 작업을 먼저 완료한다.');
    if (waiting && !ancestor(root, headBefore, 'refs/heads/main')) fail('UNFINISHED_TASK', '대기 브랜치에 main에 없는 작업 커밋이 있다.');
    for (const hook of ['post-checkout', 'reference-transaction']) {
      const configured = git(root, ['config', '--get', 'core.hooksPath'], {allowFail: true});
      const hooks = configured.status === 0 ? resolve(root, configured.stdout.trim()) : resolve(root, gitOut(root, ['rev-parse', '--git-path', 'hooks']));
      if (existsSync(join(hooks, hook))) fail('ACTIVE_GIT_HOOK', '자동 전환 전에 사용자 Git hook을 검토해야 한다. hook을 비활성화하지 않는다.');
    }
    directory = insideRoot(root, RECORD_DIR);
    if (git(root, ['check-ignore', '-q', '--no-index', RECORD_DIR], {allowFail: true}).status !== 0) fail('RECORD_NOT_IGNORED', '작업 기록 경로가 Git에서 제외되지 않았다.');
    mkdirSync(directory, {recursive: true});
    release = acquireLock(root, args.resume);
    report.initialPreflight = preflight(root, agent, task, files);
    report.synchronization = synchronize(root, report);
    const baseSha = report.synchronization.localMain;
    if (branchAt(root) !== report.branch || shaAt(root, 'HEAD') !== headBefore || workingChanges(root).length) fail('WORKTREE_CHANGED', '검사 중 현재 작업 상태가 변경됐다.');
    // Recheck other worktrees immediately before the only branch mutation.
    preflight(root, agent, task, files);
    if (shaAt(root, 'refs/heads/main') !== baseSha || shaAt(root, 'refs/remotes/origin/main') !== report.synchronization.remoteMain) fail('BASE_CHANGED', '검사 중 기준 main이 변경됐다.');
    let selected = record;
    if (!resuming) {
      const date = new Date();
      const day = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
      let branch, selectedId;
      for (let number = 1; number <= 9999; number++) {
        selectedId = `${day}-${slug}-${String(number).padStart(2, '0')}`; branch = `${prefix}${selectedId}`;
        const exists = git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {allowFail: true});
        if (![0, 1].includes(exists.status)) fail('REF_UNVERIFIED', '기존 브랜치 조회 실패.');
        if (exists.status === 1 && !existsSync(insideRoot(root, `${RECORD_DIR}/tasks/${selectedId}.json`)) && !listWorktrees(root).some(tree => tree.branch === branch)) break;
        branch = null;
      }
      if (!branch) fail('BRANCH_NAMES_EXHAUSTED', '고유 작업 브랜치 번호가 소진됐다. 기존 브랜치를 지우지 않는다.');
      selected = {version: 1, root, agent, task, slug, taskKey, files, taskId: selectedId, branch, baseSha, createdAt: report.generatedAt};
      const tasks = insideRoot(root, `${RECORD_DIR}/tasks`);
      mkdirSync(tasks, {recursive: true});
      writeFileSync(insideRoot(root, `${RECORD_DIR}/tasks/${selectedId}.json`), JSON.stringify(selected, null, 2), {flag: 'wx'});
      report.taskId = selectedId; report.baseSha = baseSha; report.plannedBranch = branch;
      const switched = git(root, ['switch', '--no-track', '-c', branch, baseSha], {allowFail: true});
      if (switched.status !== 0) fail('SWITCH_FAILED', '새 브랜치 전환 실패. 예약 기록과 기존 브랜치를 보존한다.');
      report.branchCreated = true; report.branch = branch;
    }
    report.taskId = selected.taskId; report.baseSha = selected.baseSha;
    report.finalPreflight = preflight(root, agent, task, files);
    if (branchAt(root) !== selected.branch || workingChanges(root).length || shaAt(root, 'refs/heads/main') !== baseSha) fail('FINAL_STATE_CHANGED', '최종 검증 중 작업 상태가 변경됐다. 브랜치를 되돌리지 않는다.');
    report.status = resuming ? 'RESUMED' : 'STARTED';
    report.conditions = report.finalPreflight.conditions;
  } catch (error) {
    report.status = 'BLOCKED'; report.code = error.code || 'START_FAILED';
    report.reason = error.code ? error.message : '로컬 준비 실패. 생성된 기록/브랜치를 보존하고 권한·Git 상태를 확인한다.';
  } finally {
    if (release) {
      try { release(); } catch { report.status = 'BLOCKED'; report.code = 'LOCK_RELEASE_FAILED'; report.reason = '자기 잠금을 안전하게 해제하지 못했다. 기존 잠금을 보존한다.'; }
    }
  }
  if (directory && release) {
    try {
      const saved = insideRoot(root, `${RECORD_DIR}/runs/${Date.now()}-${randomUUID()}.json`);
      mkdirSync(insideRoot(root, `${RECORD_DIR}/runs`), {recursive: true});
      report.savedAs = relative(root, saved).split('\\').join('/');
      writeFileSync(saved, JSON.stringify(report, null, 2), {flag: 'wx'});
    } catch { report.status = 'BLOCKED'; report.code = 'RECORD_WRITE_FAILED'; report.savedAs = null; report.reason = '실행 결과 저장 실패. 작업 브랜치를 보존하고 재개 전에 기록을 확인한다.'; }
  }
  return report;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = parseArgs(process.argv.slice(2), {task: 'string', slug: 'string', agent: 'string', files: 'string', resume: 'string', json: 'boolean', help: 'boolean'});
    if (args.help) console.log('node scripts/agent/baba-start.mjs --task "작업명" --files "경로,glob" [--slug task-slug] [--agent codex|claude] [--resume 작업-ID] [--json]');
    else {
      const result = startTask(args);
      console.log(args.json ? JSON.stringify(result, null, 2) : [`BABA Start: ${result.status}`, `작업 ID: ${result.taskId || '-'}`, `브랜치: ${result.branch || '-'}`, `기준 SHA: ${result.baseSha || '-'}`, result.reason || '', `기록: ${result.savedAs || '없음(읽기 전용 단계에서 중단)'}`, ...(result.conditions || [])].filter(Boolean).join('\n'));
      process.exitCode = result.status === 'BLOCKED' ? 2 : 0;
    }
  } catch { console.error('옵션이 잘못됐다. --help를 확인한다.'); process.exitCode = 2; }
}
