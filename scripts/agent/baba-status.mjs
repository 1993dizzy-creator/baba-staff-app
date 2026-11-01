#!/usr/bin/env node
// baba-status: read-only Git state summary of the BABA worktrees (docs/agents/baba-status.md).
// It never writes files, never fetches, never moves refs, the index or working files.
// Remote main is read with `git ls-remote` only (no ref update); --offline skips that query.
// Usage: node scripts/agent/baba-status.mjs [--offline] [--graph] [--branches] [--no-color] [--json]
import {existsSync} from 'node:fs';
import {dirname, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {git, gitTry, identifyWorktree, listWorktrees, parseArgs, parseStatusZ, repoRoot, sanitizedEnv} from './lib/common.mjs';
import {detectTerminal, renderStatus} from './lib/status-view.mjs';

const OPERATIONS = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-apply', 'rebase-merge', 'BISECT_LOG'];
const LABELS = {main: 'main', claude: 'Claude', codex: 'Codex'};
const short = sha => (sha ? sha.slice(0, 7) : '-');
const lines = text => text.split(/\r?\n/).filter(Boolean);
const samePath = (a, b) => a.toLowerCase() === b.toLowerCase();
const within = (parent, child) => samePath(parent, child) || child.toLowerCase().startsWith(parent.toLowerCase().replace(/[\\/]$/, '') + sep);

export function collectStatus({root, cwd = process.cwd(), offline = false} = {}) {
  const findings = [];
  const add = (level, area, target, cause, action) => findings.push({level, area, target, cause, action});
  const mainSha = gitTry(root, ['rev-parse', '--verify', '--quiet', 'refs/heads/main^{commit}']);
  if (!mainSha) add('FAIL', 'git', 'main', '로컬 main 브랜치를 찾을 수 없다.', '저장소 경로를 확인한다.');

  // A·B. Registered worktrees: identity, cleanliness, operations, commits not in main.
  const registered = listWorktrees(root);
  const trees = registered.map(tree => inspectTree(root, tree, mainSha, registered[0]?.path));
  for (const tree of trees) {
    const name = tree.label;
    if (!tree.exists) { add('FAIL', 'git', name, `등록된 경로가 없다: ${tree.path}`, '사용자 확인 후 정리한다(자동 prune 안 함).'); continue; }
    if (tree.role === 'other') add('WARN', 'git', name, `정책에 없는 추가 Worktree다: ${tree.path} (${tree.branch})`, '용도를 사용자에게 확인한다.');
    if (tree.role === 'main' && tree.branch !== 'main') add('FAIL', 'git', name, `원본 폴더가 main이 아닌 ${tree.branch}에 있다.`, '사용자 확인 전 수정하지 않는다. 직렬 개발은 원본 main에서만 한다.');
    if (tree.agent && tree.branch === 'main') add('FAIL', 'git', name, '병렬 Worktree가 main 브랜치에 있다.', '독립 작업 브랜치를 사용한다. 기존 변경은 보존한다.');
    if (tree.agent && tree.branch === '(detached)') add('WARN', 'git', name, '독립 작업 브랜치가 아닌 detached HEAD다.', '기존 커밋을 보존하고 작업 브랜치를 확인한다.');
    if (tree.operation) add('FAIL', 'git', name, `진행 중인 Git 작업(${tree.operation})이 있다.`, '작업을 보존하고 사용자에게 보고한다.');
    if (tree.conflicted.length) add('FAIL', 'git', name, `충돌 파일 ${tree.conflicted.length}개`, '충돌을 해결하기 전 커밋·병합하지 않는다.');
    if (!tree.clean) {
      const action = tree.role === 'main'
        ? '직렬 작업 중이면 이어서 완료·커밋한다. 병합할 변경과 겹치는지 확인한다.'
        : '진행 중인 작업이다. 소유 에이전트가 이어서 완료·커밋한다(reset·clean·stash 금지).';
      add('WARN', 'integration', name, `미커밋 변경 ${tree.changed.length + tree.untracked.length}건(수정 ${tree.changed.length}·미추적 ${tree.untracked.length})`, action);
    }
    if (!tree.unintegrated) continue;
    if (!tree.unintegrated.length) {
      if (tree.behind) add('INFO', 'integration', name, `main보다 ${tree.behind}커밋 오래됨(미통합 커밋 없음).`, '새 작업에 필요한 main 변경만 확인한다.');
      continue;
    }
    // Git shows what is missing from main; whether it is still needed is the user's review.
    const cause = `main에 없는 커밋 ${tree.unintegrated.length}개`;
    if (tree.unintegrated.every(commit => commit.equivalent)) add('WARN', 'integration', name, `${cause} — 같은 변경이 이미 main에 있다(패치 동일).`, '중복 기록인지 검토 후 사용자 승인으로 정리한다.');
    else add('WARN', 'integration', name, cause, '소스 충돌과 핵심 계약 변경을 확인하고 사용자 승인 범위에서 통합한다. 유효한 검증은 재사용한다.');
    if (tree.behind) add('INFO', 'integration', name, `main이 ${tree.behind}커밋 앞서 있다.`, '충돌·핵심 계약 변경이 있는 부분만 확인한다.');
  }
  const parked = lines(gitTry(root, ['for-each-ref', '--format=%(refname:short)', '--no-merged=refs/heads/main', 'refs/heads/']) || '')
    .filter(branch => !trees.some(tree => tree.branch === branch));
  if (parked.length) add('INFO', 'integration', '로컬 브랜치', `Worktree 밖 main 미통합 브랜치 ${parked.length}개: ${parked.join(', ')}`, '보존 중인 기록·백업이면 조치 불필요. 필요 여부는 사용자가 정한다.');

  // C. GitHub: the server is queried directly; refs/remotes/origin/main is only a last-fetch estimate.
  const github = remoteState(root, mainSha, offline);
  if (github.relation === 'remote-ahead') add('WARN', 'github', 'GitHub', '원격 main에 로컬에 없는 커밋이 있다.', 'Push하면 거부된다. 사용자 승인 후 fetch·ff 반영을 검토한다.');
  if (github.relation === 'diverged') add('FAIL', 'github', 'GitHub', '로컬 main과 원격 main이 갈라졌다.', 'Push·병합하지 말고 사용자에게 보고한다.');
  if (!github.verified) add('WARN', 'github', 'GitHub', `원격 상태 미확인(${github.reason}).`, '마지막 fetch 기준 추정치다. 네트워크 확인 후 다시 실행한다.');
  if (github.trackingStale) add('WARN', 'github', 'GitHub', `origin/main 참조(${short(github.tracking)})가 실제 원격(${short(github.remote)})과 다르다.`, '참조가 오래됐다. 사용자 허용 시 git fetch origin으로 참조만 갱신한다.');

  // D. Infer development mode from the execution path and branch.
  const here = resolve(cwd);
  const current = trees.filter(tree => within(tree.path, here)).sort((a, b) => b.path.length - a.path.length)[0] || null;
  const location = {cwd: here, tree: current?.label || null, branch: current?.branch || null, mode: null};
  if (!current) add('INFO', 'git', '실행 위치', 'BABA Worktree 밖에서 실행했다.', '개발은 원본 main(직렬) 또는 자기 Worktree(병렬)에서 한다.');
  else if (current.role === 'main' && current.branch === 'main') location.mode = 'serial';
  else if (current.agent && current.branch !== 'main' && current.branch !== '(detached)') location.mode = 'parallel';
  else if (current.role === 'other') add('WARN', 'git', '실행 위치', `정책에 없는 Worktree(${current.path})에서 실행했다.`, '수정하지 말고 사용자에게 보고한다.');

  const verdict = area => findings.some(f => f.area === area && f.level === 'FAIL') ? 'FAIL' : findings.some(f => f.area === area && f.level === 'WARN') ? 'WARN' : 'PASS';
  const overall = findings.some(f => f.level === 'FAIL') ? 'FAIL' : findings.some(f => f.level === 'WARN') ? 'WARN' : 'PASS';
  return {
    tool: 'baba-status', readOnly: true, generatedAt: new Date().toISOString(), root, location,
    main: mainSha, trees, relationships: trees.filter(tree => tree.role !== 'main').map(tree => branchRelationship(root, mainSha, tree)), github, findings, parked,
    verdicts: {integration: verdict('integration'), git: verdict('git'), github: verdict('github'), overall},
    notCovered: ['ESLint·TypeScript·테스트', '보안·자격 증명 검사', 'Production 배포 승인'],
  };
}

function branchRelationship(root, main, tree) {
  const limit = 18;
  const bases = main && tree.head && tree.exists ? lines(gitTry(root, ['merge-base', '--all', main, tree.head]) || '') : [];
  const history = bases.length && main !== tree.head
    ? lines(gitTry(root, ['log', '--no-color', '--graph', '--topo-order', '--boundary', `--max-count=${limit}`, '--format=%H%x09%P%x09%s', main, tree.head, '--not', ...bases]) || '') : [];
  const shared = bases.length === 1 ? lines(gitTry(root, ['log', '--first-parent', '--max-count=2', '--format=%H', bases[0]]) || '').reverse() : [];
  return {path: tree.path, bases, detached: tree.branch === '(detached)', ahead: tree.unintegrated?.length ?? null,
    behind: tree.behind, shared, history, truncated: (tree.unintegrated?.length || 0) + (tree.behind || 0) > limit};
}

function inspectTree(root, tree, mainSha, originalPath) {
  const identity = identifyWorktree(tree.path, originalPath);
  const role = identity.isOriginal ? 'main' : identity.agent || 'other';
  const info = {role, agent: identity.agent, label: LABELS[role] || identity.dir, path: tree.path, branch: tree.branch || '(unknown)', head: tree.head,
    exists: existsSync(tree.path), clean: true, changed: [], untracked: [], conflicted: [], operation: null,
    unintegrated: null, behind: null};
  if (!info.exists) return info;
  const entries = parseStatusZ(git(tree.path, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).stdout);
  info.untracked = entries.filter(entry => entry.code === '??').map(entry => entry.path);
  info.changed = entries.filter(entry => entry.code !== '??').map(entry => `${entry.code.trim()} ${entry.path}`);
  info.conflicted = entries.filter(entry => /U|AA|DD/.test(entry.code)).map(entry => entry.path);
  info.clean = !entries.length;
  info.operation = OPERATIONS.find(marker => existsSync(resolve(tree.path, gitTry(tree.path, ['rev-parse', '--git-path', marker]) || marker))) || null;
  if (role === 'main' || !mainSha || !tree.head) return info;
  // `git cherry` marks commits whose patch already exists in main with "-".
  const equivalent = new Set(lines(gitTry(root, ['cherry', mainSha, tree.head]) || '').filter(line => line.startsWith('-')).map(line => line.slice(2)));
  info.unintegrated = lines(gitTry(root, ['log', '--format=%H%x09%s', `${mainSha}..${tree.head}`]) || '').map(line => {
    const [sha, ...subject] = line.split('\t');
    return {sha, subject: subject.join('\t'), equivalent: equivalent.has(sha)};
  });
  info.behind = Number(gitTry(root, ['rev-list', '--count', `${tree.head}..${mainSha}`]) || 0);
  return info;
}

function remoteState(root, local, offline) {
  const state = {local, tracking: gitTry(root, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main^{commit}']), remote: null,
    verified: false, reason: null, relation: 'unknown', ahead: null, behind: null, trackingStale: false};
  if (offline) state.reason = '--offline';
  else {
    const queried = git(root, ['ls-remote', '--exit-code', 'origin', 'refs/heads/main'], {env: sanitizedEnv().env, allowFail: true, timeout: 20000});
    state.remote = queried.status === 0 ? queried.stdout.match(/^([0-9a-f]{40})\s+refs\/heads\/main\s*$/m)?.[1] || null : null;
    state.verified = Boolean(state.remote);
    if (!state.verified) state.reason = queried.error?.code === 'ETIMEDOUT' ? '응답 시간 초과' : '원격 연결 실패';
    state.trackingStale = state.verified && state.tracking !== state.remote;
  }
  const target = state.remote || state.tracking;
  if (!local || !target) return state;
  if (target === local) return {...state, relation: 'equal', ahead: 0, behind: 0};
  if (git(root, ['cat-file', '-e', `${target}^{commit}`], {allowFail: true}).status !== 0) return {...state, relation: 'remote-ahead'};
  const [behind, ahead] = (gitTry(root, ['rev-list', '--left-right', '--count', `${target}...${local}`]) || '').split(/\s+/).map(Number);
  const relation = ahead && behind ? 'diverged' : ahead ? 'local-ahead' : 'remote-ahead';
  return {...state, relation, ahead, behind};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2), {offline: 'boolean', graph: 'boolean', branches: 'boolean', noColor: 'boolean', json: 'boolean', help: 'boolean'});
    if (args._.length) throw new Error('invalid');
  } catch {
    console.error('옵션이 잘못됐다. node scripts/agent/baba-status.mjs --help');
    process.exit(2);
  }
  if (args.help) {
    console.log('baba-status [--offline] [--graph] [--branches] [--no-color] [--json]\n  실행 경로로 직렬·병렬을 자동 표시한다. 읽기 전용이며 fetch하지 않는다. 원격은 git ls-remote로만 조회한다.\n  --graph: 상세 관계도 · --branches: Worktree 밖 main 미통합 브랜치 목록 표시 · --no-color: 색상 끄기(NO_COLOR와 같음)');
    process.exit(0);
  }
  const report = collectStatus({root: repoRoot(dirname(fileURLToPath(import.meta.url))), offline: Boolean(args.offline)});
  const terminal = detectTerminal();
  if (args.noColor) terminal.color = false;
  console.log(args.json ? JSON.stringify(report, null, 2) : renderStatus(report, {...terminal, branches: Boolean(args.branches), graph: Boolean(args.graph)}));
  process.exitCode = {PASS: 0, WARN: 1, FAIL: 2}[report.verdicts.overall];
}
