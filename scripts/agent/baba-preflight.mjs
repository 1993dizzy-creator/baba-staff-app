#!/usr/bin/env node
// baba-preflight: read-only start-of-task check (docs/agents/baba-agent-workflow.md section 3).
// It never writes files, never fetches, never switches branches and never touches a database.
// Usage: node scripts/agent/baba-preflight.mjs --task "<작업명>" [--agent claude|codex]
//          [--files "lib/a.ts,app/api/x/**"] [--apis "/api/x"] [--tables "inventory"] [--base origin/main] [--json]
import {existsSync, readFileSync, statSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {
  AGENTS, HOT_FILES, POLICY_DOC, PRODUCTION_SENSITIVE, apiRouteOf, classifyDomains, collectChanges, committedChanges,
  dbObjectsIn, defaultBaseRef, domainPolicyDocs, expandPlanned, gitOut, gitTry, identifyWorktree, importersOf,
  listSourceFiles, listWorktrees, matchesAny, migrationVersion, parseArgs, parseStatusZ, git, relatedTests, repoRoot,
  splitList, CREDENTIAL_ENV, insideRoot,
} from './lib/common.mjs';

const args = parseArgs(process.argv.slice(2), {task: 'string', agent: 'string', files: 'string', apis: 'string', tables: 'string', base: 'string', json: 'boolean', help: 'boolean'});
if (args.help) {
  console.log('node scripts/agent/baba-preflight.mjs --task "<작업명>" [--agent claude|codex] [--files a,b/**] [--apis /api/x] [--tables t] [--base origin/main] [--json]');
  process.exit(0);
}

const root = repoRoot();
const identity = identifyWorktree(root);
const baseRef = args.base || defaultBaseRef(root);
const branch = gitOut(root, ['branch', '--show-current']) || '(detached)';
const head = gitOut(root, ['rev-parse', 'HEAD']);
const mine = collectChanges(root, baseRef);
const planned = expandPlanned(root, splitList(args.files));
const blockers = [];
const conditions = [];
const warnings = [];
let risk = 0; // 0 low, 1 medium, 2 high
const raise = level => { risk = Math.max(risk, level); };

// 1. Worktree ownership and branch.
const agent = identity.agent;
if (identity.isOriginal) blockers.push(`원본 폴더(${identity.dir})에서는 에이전트 개발을 하지 않는다. 담당 Worktree를 사용한다.`);
else if (!agent) blockers.push(`알 수 없는 Worktree(${identity.dir}). 소유 에이전트를 확인할 수 없다.`);
if (args.agent && agent && args.agent.toLowerCase() !== agent) blockers.push(`--agent ${args.agent}는 이 Worktree의 소유자(${agent})와 다르다. 다른 에이전트의 Worktree를 수정하지 않는다.`);
const prefix = agent ? AGENTS[agent].branchPrefix : null;
const idleBranch = prefix && (branch === `${prefix}idle` || branch.startsWith(`${prefix}ready-`));
if (prefix && !branch.startsWith(prefix)) blockers.push(`현재 브랜치(${branch})가 ${prefix} 접두사가 아니다. main 또는 다른 에이전트 브랜치에서 작업하지 않는다.`);
if (idleBranch) conditions.push(`대기 브랜치(${branch})다. 작업 브랜치를 먼저 만든다: git switch --no-track -c ${prefix}${today()}-<작업-slug>-01 ${baseRef}`);
const upstream = gitTry(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
if (upstream && !upstream.endsWith(`/${branch}`)) warnings.push(`작업 브랜치가 다른 이름의 원격 브랜치(${upstream})를 추적한다. 실수 push를 막기 위해 git branch --unset-upstream을 권장한다.`);

// 2. Uncommitted changes.
const uncommitted = parseStatusZ(git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).stdout);
if (uncommitted.length) {
  conditions.push(`미커밋 변경 ${uncommitted.length}건이 있다. 이번 작업 소유인지 확인하고, 다른 작업 것이면 해당 작업 브랜치에 먼저 보존한다(reset·clean·stash 금지).`);
  raise(1);
}

// 3. Base freshness and environment.
const counts = gitTry(root, ['rev-list', '--left-right', '--count', `${baseRef}...HEAD`]);
const [behind, ahead] = counts ? counts.split(/\s+/).map(Number) : [null, null];
// FETCH_HEAD is per worktree; remote refs are shared, so the newest fetch from any of them counts.
const fetchHeads = [resolve(root, gitOut(root, ['rev-parse', '--git-path', 'FETCH_HEAD'])), join(resolve(root, gitOut(root, ['rev-parse', '--git-common-dir'])), 'FETCH_HEAD')];
const lastFetch = fetchHeads.filter(path => existsSync(path)).map(path => statSync(path).mtime).sort((a, b) => b - a)[0] || null;
if (!lastFetch || Date.now() - lastFetch.getTime() > 24 * 3600 * 1000) conditions.push(`원격 참조가 24시간 이상 갱신되지 않았다(마지막 fetch: ${lastFetch ? lastFetch.toISOString() : '기록 없음'}). 사용자가 허용한 경우 git fetch origin으로 참조만 갱신한다.`);
if (behind) warnings.push(`${baseRef}보다 ${behind}커밋 뒤처져 있다. 새 작업이면 최신 ${baseRef}에서 브랜치를 만든다.`);
const nodeModules = existsSync(join(root, 'node_modules'));
const installMarker = join(root, 'node_modules', '.package-lock.json');
if (!nodeModules) conditions.push('node_modules가 없다. 이 Worktree에서만 npm ci를 실행한다.');
else if (existsSync(installMarker) && statSync(join(root, 'package-lock.json')).mtimeMs > statSync(installMarker).mtimeMs + 1000) conditions.push('package-lock.json이 설치 이후 변경되었다. 이 Worktree에서만 npm ci를 재실행한다.');
const envLocal = existsSync(join(root, '.env.local'));
if (envLocal) {
  warnings.push('.env.local이 있다(값은 읽지 않음). 운영 자격 증명일 수 있으므로 앱·테스트 실행 전 출처를 확인한다.');
  raise(1);
}
const credentialNames = Object.keys(process.env).filter(name => CREDENTIAL_ENV.test(name));
if (credentialNames.length) warnings.push(`프로세스 환경에 자격 증명 계열 변수 이름이 있다(값 미출력): ${credentialNames.join(', ')}. baba-verify는 이를 제거하고 실행한다.`);

// 4. Other worktrees: committed and uncommitted changes, overlap with this task.
const myPaths = new Set([...planned, ...mine.files.map(file => file.path)]);
const others = [];
for (const tree of listWorktrees(root).filter(tree => tree.path.toLowerCase() !== root.toLowerCase())) {
  const info = {path: tree.path, branch: tree.branch, head: tree.head?.slice(0, 12), uncommitted: [], committed: [], overlap: [], hot: [], migrations: [], error: null};
  try {
    info.uncommitted = existsSync(tree.path) ? parseStatusZ(git(tree.path, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).stdout).map(entry => entry.path) : [];
    const base = gitTry(root, ['merge-base', tree.head, baseRef]);
    info.committed = base ? committedChanges(root, base, tree.head).map(entry => entry.path) : [];
  } catch (error) {
    info.error = error.message.split('\n')[0];
  }
  const theirs = new Set([...info.uncommitted, ...info.committed]);
  info.overlap = [...myPaths].filter(path => theirs.has(path));
  info.hot = [...theirs].filter(path => matchesAny(path, HOT_FILES));
  info.migrations = [...theirs].filter(path => migrationVersion(path));
  if (info.overlap.length) {
    const live = info.overlap.filter(path => info.uncommitted.includes(path));
    (live.length ? conditions : warnings).push(`${tree.branch} Worktree와 같은 파일을 다룬다: ${info.overlap.join(', ')}${live.length ? ' (상대가 미커밋 수정 중)' : ''}. 사용자에게 작업 순서·병합 순서를 확인한다.`);
    raise(live.length ? 2 : 1);
  }
  others.push(info);
}

// 5. Planned scope: files, APIs, importers, DB objects, related tests, domains.
const sourceFiles = planned.length ? listSourceFiles(root) : [];
const scope = planned.map(path => {
  insideRoot(root, path);
  if (/(^|[/\\])\.env(?:\.|$)/.test(path)) throw new Error('Environment file contents are excluded from preflight');
  const exists = existsSync(join(root, path));
  const text = exists && statSync(join(root, path)).isFile() ? readFileSync(join(root, path), 'utf8') : '';
  return {path, exists, api: apiRouteOf(path), hot: matchesAny(path, HOT_FILES), importers: exists ? importersOf(root, path, sourceFiles) : [], db: dbObjectsIn(text)};
});
const apis = [...new Set([...splitList(args.apis), ...scope.map(item => item.api).filter(Boolean), ...scope.flatMap(item => item.importers.map(apiRouteOf).filter(Boolean))])].sort();
const tables = [...new Set([...splitList(args.tables), ...scope.flatMap(item => item.db.tables)])].sort();
const rpcs = [...new Set(scope.flatMap(item => item.db.rpcs))].sort();
const writes = [...new Set(scope.flatMap(item => item.db.writes))].sort();
const tests = relatedTests(root, planned);
const domains = classifyDomains(planned);
const policyDocs = domainPolicyDocs(root, Object.keys(domains));
const hotPlanned = scope.filter(item => item.hot).map(item => item.path);
if (hotPlanned.length) {
  conditions.push(`공통 파일 수정 예정: ${hotPlanned.join(', ')}. 다른 Worktree 영향과 병합 순서를 사용자에게 보고한다.`);
  raise(1);
}
if (Object.keys(domains).length) {
  warnings.push(`확정 정책 영역(${Object.values(domains).map(domain => domain.label).join(', ')})을 다룬다. 정책 의미 변경은 사용자 승인 전 금지.`);
  raise(1);
}
if (planned.length && !tests.tests.length) warnings.push('수정 예정 파일을 참조하는 기존 테스트가 없다. 회귀 테스트 추가 또는 미검증 표기가 필요하다.');

// 6. Migration and production-data exposure.
const baseMigrations = new Set(gitOut(root, ['ls-tree', '-r', '--name-only', mine.mergeBase, 'supabase/migrations']).split('\n').filter(Boolean));
const plannedMigrations = planned.filter(path => migrationVersion(path));
for (const path of plannedMigrations.filter(path => baseMigrations.has(path))) blockers.push(`기존 Migration 수정 금지: ${path}. 후속 Migration을 새 파일로 추가한다.`);
const myNewMigrations = [...new Set([...plannedMigrations, ...mine.files.map(file => file.path).filter(path => migrationVersion(path))])].filter(path => !baseMigrations.has(path));
const knownVersions = new Map([...baseMigrations].map(path => [migrationVersion(path), path]));
for (const other of others) for (const path of other.migrations) if (!knownVersions.has(migrationVersion(path))) knownVersions.set(migrationVersion(path), `${path} (${other.branch})`);
for (const path of myNewMigrations) {
  const clash = knownVersions.get(migrationVersion(path));
  if (clash && !clash.startsWith(path)) blockers.push(`Migration 버전 중복: ${path} ↔ ${clash}`);
  knownVersions.set(migrationVersion(path), path);
}
const exposure = [];
for (const path of planned) {
  const rule = PRODUCTION_SENSITIVE.find(item => matchesAny(path, [item.pattern]));
  if (rule) exposure.push({path, level: rule.level, reason: rule.reason});
}
if (writes.length) exposure.push({path: '(정적 분석)', level: 'medium', reason: `쓰기 경로 포함: ${writes.join(', ')} — 코드 변경 자체는 운영 데이터 변경이 아니지만 배포 후 영향`});
if (exposure.some(item => item.level === 'high')) {
  raise(2);
  conditions.push('운영 DB·cron 영향 경로가 있다. Migration/SQL은 로컬 작성·검증까지만 하고, 적용은 AGENTS.md 수동 절차(사용자 SQL Editor 실행)를 따른다.');
} else if (exposure.length) raise(1);
const latestMigration = [...baseMigrations].sort().at(-1) || null;

const verdict = blockers.length ? '불가' : conditions.length ? '조건부 가능' : '가능';
const riskLabel = blockers.length ? 'BLOCKED' : ['LOW', 'MEDIUM', 'HIGH'][risk];
const report = {
  tool: 'baba-preflight', readOnly: true, generatedAt: new Date().toISOString(), task: args.task || null, policy: POLICY_DOC,
  worktree: {root, dir: identity.dir, owner: agent, branch, head, baseRef, mergeBase: mine.mergeBase, ahead, behind, lastFetch: lastFetch?.toISOString() || null, nodeModules, envLocalPresent: envLocal},
  uncommitted: uncommitted.map(entry => `${entry.code} ${entry.path}`), branchChanges: mine.files.map(file => file.path),
  others, planned: scope, apis, tables, rpcs, writes, tests, domains, policyDocs, migrations: {latest: latestMigration, planned: plannedMigrations, newOnThisBranch: myNewMigrations},
  exposure, blockers, conditions, warnings, verdict, risk: riskLabel,
};

if (args.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(render(report));
}
process.exitCode = blockers.length ? 2 : 0;

function today() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

function list(items, empty = '없음') {
  return items.length ? items.map(item => `- ${item}`).join('\n') : `- ${empty}`;
}

function render(r) {
  const w = r.worktree;
  const lines = [];
  lines.push(`# BABA Preflight — ${r.task || '(작업명 미지정)'}`, '');
  lines.push(`판정: **${r.verdict}** · 위험도: **${r.risk}** · 읽기 전용 실행(파일·Git·DB 변경 없음)`, '');
  lines.push('## 1. 작업 환경');
  lines.push(`- Worktree: ${w.root} (소유: ${w.owner || '없음'})`);
  lines.push(`- 브랜치: ${w.branch} @ ${w.head.slice(0, 12)}`);
  lines.push(`- 기준: ${w.baseRef} (merge-base ${w.mergeBase.slice(0, 12)}, ahead ${w.ahead ?? '?'} / behind ${w.behind ?? '?'})`);
  lines.push(`- 마지막 fetch: ${w.lastFetch || '기록 없음'} · node_modules: ${w.nodeModules ? '있음' : '없음'} · .env.local: ${w.envLocalPresent ? '있음(값 미확인)' : '없음'}`, '');
  lines.push('## 2. 미커밋 변경');
  lines.push(list(r.uncommitted), '');
  lines.push('## 3. 다른 Worktree 영향');
  for (const o of r.others) {
    lines.push(`- ${o.branch} (${o.path}, ${o.head})${o.error ? ` — 조회 실패: ${o.error}` : ''}`);
    lines.push(`  - 미커밋 ${o.uncommitted.length}건 · 브랜치 변경 ${o.committed.length}건 · 공통 파일 ${o.hot.length ? o.hot.join(', ') : '없음'}`);
    lines.push(`  - 이번 작업과 겹치는 파일: ${o.overlap.length ? o.overlap.join(', ') : '없음'}`);
    if (o.migrations.length) lines.push(`  - 신규 Migration: ${o.migrations.join(', ')}`);
  }
  if (!r.others.length) lines.push('- 다른 Worktree 없음');
  lines.push('');
  lines.push('## 4. 수정 예정 범위');
  if (!r.planned.length) lines.push('- --files 미지정: 파일·API·DB 영향 분석을 하지 않았다. 범위가 정해지면 다시 실행한다.');
  for (const p of r.planned) {
    lines.push(`- ${p.path}${p.exists ? '' : ' (신규)'}${p.hot ? ' [공통 파일]' : ''}${p.api ? ` → API ${p.api}` : ''}`);
    if (p.importers.length) lines.push(`  - import하는 파일 ${p.importers.length}개: ${p.importers.slice(0, 12).join(', ')}${p.importers.length > 12 ? ' …' : ''}`);
  }
  lines.push(`- API: ${r.apis.length ? r.apis.join(', ') : '없음'}`);
  lines.push(`- DB 테이블(정적): ${r.tables.length ? r.tables.join(', ') : '없음'} · RPC/함수: ${r.rpcs.length ? r.rpcs.join(', ') : '없음'}`);
  lines.push(`- 쓰기 경로(정적): ${r.writes.length ? r.writes.join(', ') : '없음'}`);
  lines.push(`- 관련 테스트 ${r.tests.tests.length}개: ${r.tests.tests.slice(0, 15).map(t => t.path).join(', ') || '없음'}${r.tests.tests.length > 15 ? ' …' : ''}`);
  if (r.tests.untested.length) lines.push(`- 테스트 미참조 파일: ${r.tests.untested.join(', ')}`);
  for (const [key, domain] of Object.entries(r.domains)) {
    const docs = r.policyDocs[key];
    lines.push(`- 확정 정책 영역 ${domain.label}: 관련 문서 ${docs.length}개${docs.length ? ` (${docs.slice(0, 6).join(', ')}${docs.length > 6 ? ' … --json으로 전체 확인' : ''})` : ' (docs 없음 — 기존 코드·테스트가 기준)'}`);
  }
  lines.push('');
  lines.push('## 5. Migration·운영 데이터 변경 가능성');
  lines.push(`- 최신 기준 Migration: ${r.migrations.latest || '없음'}`);
  lines.push(`- 이번 작업 신규 Migration: ${r.migrations.newOnThisBranch.length ? r.migrations.newOnThisBranch.join(', ') : '없음'}`);
  lines.push(list(r.exposure.map(e => `[${e.level}] ${e.path}: ${e.reason}`), '운영 데이터 변경 경로 없음(정적 분석 기준)'), '');
  lines.push('## 6. 차단 사유');
  lines.push(list(r.blockers), '');
  lines.push('## 7. 선행 조건');
  lines.push(list(r.conditions), '');
  lines.push('## 8. 주의');
  lines.push(list(r.warnings), '');
  lines.push(`기준 정책: ${r.policy}`);
  return lines.join('\n');
}
