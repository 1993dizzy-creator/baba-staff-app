#!/usr/bin/env node
// baba-handoff: standard end-of-task handoff (docs/agents/baba-agent-workflow.md section 10).
// Facts (SHA, files, verify result, push/merge state) are filled from Git and the latest
// baba-verify result; judgement fields are left as TODO markers for the agent to complete.
// Usage: node scripts/agent/baba-handoff.mjs --task-name "<작업명>" [--task-id <id>] [--out <path> | --stdout] [--base origin/main]
//        node scripts/agent/baba-handoff.mjs --check docs/handoffs/<file>.md
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {
  AGENTS, POLICY_DOC, collectChanges, defaultBaseRef, git, gitOut, gitTry, identifyWorktree, migrationVersion, parseArgs,
  repoRoot, stateFingerprint,
} from './lib/common.mjs';
import {TODO, checkHandoff} from './lib/handoff-format.mjs';


const args = parseArgs(process.argv.slice(2), {taskName: 'string', taskId: 'string', out: 'string', stdout: 'boolean', base: 'string', check: 'string', force: 'boolean', help: 'boolean'});
if (args.help) {
  console.log('node scripts/agent/baba-handoff.mjs --task-name "<작업명>" [--task-id id] [--out path | --stdout] [--base origin/main] [--force]\nnode scripts/agent/baba-handoff.mjs --check <handoff.md>');
  process.exit(0);
}

if (args.check) {
  const problems = checkHandoff(readFileSync(args.check, 'utf8'));
  console.log(problems.length ? `인계서 형식 검사 실패 (${args.check})\n${problems.map(p => `- ${p}`).join('\n')}` : `인계서 형식 검사 통과 (${args.check})`);
  process.exit(problems.length ? 1 : 0);
}
if (!args.taskName) {
  console.error('--task-name이 필요하다.');
  process.exit(2);
}

const root = repoRoot();
const identity = identifyWorktree(root);
const agentLabel = {claude: 'Claude Code', codex: 'Codex'}[identity.agent] || '(소유 에이전트 없음)';
const baseRef = args.base || defaultBaseRef(root);
const branch = gitOut(root, ['branch', '--show-current']) || '(detached)';
const head = gitOut(root, ['rev-parse', 'HEAD']);
const {mergeBase, files} = collectChanges(root, baseRef);
const prefix = identity.agent ? AGENTS[identity.agent].branchPrefix : '';
const taskId = args.taskId || (branch.startsWith(prefix) ? branch.slice(prefix.length) : branch.replace(/\//g, '-'));
const commits = gitOut(root, ['log', '--format=%h %s', `${mergeBase}..HEAD`]).split('\n').filter(Boolean);
const uncommitted = files.filter(file => file.working);
const numstat = new Map();
for (const line of gitOut(root, ['diff', '--numstat', mergeBase]).split('\n').filter(Boolean)) {
  const [added, removed, path] = line.split('\t');
  numstat.set(path, `+${added} −${removed}`);
}

// Verify result: only trusted when its state fingerprint matches the current tree.
const latestPath = join(root, '.tmp-baba', 'verify', 'latest.json');
const verify = existsSync(latestPath) ? JSON.parse(readFileSync(latestPath, 'utf8')) : null;
const fingerprint = stateFingerprint(root);
const verifyMatches = verify && verify.fingerprint === fingerprint;

const migrations = files.filter(file => migrationVersion(file.path));
const sqlFiles = files.filter(file => /\.sql$/.test(file.path) && !migrationVersion(file.path));
const remoteBranches = gitOut(root, ['branch', '-r', '--contains', 'HEAD']).split('\n').map(line => line.trim()).filter(line => line && !line.includes('->'));
const upstream = gitTry(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
const mergedIntoBase = commits.length > 0 && git(root, ['merge-base', '--is-ancestor', 'HEAD', baseRef], {allowFail: true}).status === 0;
const pushState = !commits.length ? '해당 없음(작업 커밋 없음)'
  : remoteBranches.filter(ref => ref !== baseRef).length ? `push됨: ${remoteBranches.filter(ref => ref !== baseRef).join(', ')}` : 'push 안 됨';

const lines = [];
lines.push(`# 인계서 — ${args.taskName}`, '');
lines.push(`> 작성: ${new Date().toISOString()} · baba-handoff · 기준 정책 ${POLICY_DOC}`, '');
lines.push('## 1. 작업 정보');
lines.push(`- 작업명: ${args.taskName}`);
lines.push(`- 작업 ID: ${taskId}`);
lines.push(`- 담당 AI: ${agentLabel}`);
lines.push(`- Worktree: ${identity.dir}`, '');
lines.push('## 2. Git 상태');
lines.push(`- 작업 브랜치: ${branch}`);
lines.push(`- HEAD SHA: ${head}`);
lines.push(`- 기준: ${baseRef} · merge-base ${mergeBase}`);
lines.push(`- 작업 커밋 ${commits.length}개${commits.length ? ':' : ''}`);
for (const commit of commits) lines.push(`  - ${commit}`);
lines.push(`- 미커밋 변경: ${uncommitted.length ? `${uncommitted.length}건 — SHA에 포함되지 않음 (${uncommitted.map(file => file.path).join(', ')})` : '없음'}`, '');
lines.push('## 3. 변경 파일과 기능');
lines.push('| 파일 | 상태 | 변경량 | 커밋 |', '| --- | --- | --- | --- |');
for (const file of files) {
  const state = file.deleted ? '삭제' : file.added ? '추가' : '수정';
  lines.push(`| \`${file.path}\` | ${state} | ${numstat.get(file.path) || (file.working === '??' ? '신규(미추적)' : '-')} | ${file.working ? '미커밋' : '커밋됨'} |`);
}
if (!files.length) lines.push('| (변경 없음) | - | - | - |');
lines.push('', '기능 요약:', `- ${TODO}: 사용자 관점의 변경 기능과 이유를 파일 묶음별로 작성 -->`, '');
lines.push('## 4. 검증 결과');
if (!verify) lines.push('- baba-verify 결과 없음 → **미검증**. `node scripts/agent/baba-verify.mjs` 실행 후 다시 작성한다.');
else {
  lines.push(`- baba-verify 판정: **${verify.verdict}** (${verify.generatedAt}, ${verify.savedAs || 'latest.json'})`);
  lines.push(`- 현재 상태와 일치: ${verifyMatches ? '예' : `**아니오** — 검증 후 변경됨(지문 ${verify.fingerprint} ≠ ${fingerprint}). 재검증 필요`}`);
  lines.push('', '| 검사 | 실제 실행 | 결과 |', '| --- | --- | --- |');
  for (const check of verify.checks) lines.push(`| ${check.name} | ${check.ran ? '예' : '아니오'} | ${check.status} |`);
  lines.push('', '미검증 항목:');
  for (const gap of verify.gaps.length ? verify.gaps : ['없음']) lines.push(`- ${gap}`);
}
lines.push('', `수동 확인(브라우저·실행 확인 등): ${TODO}: 실제로 수행한 확인만 기록, 없으면 "없음" -->`, '');
lines.push('## 5. DB·Migration');
lines.push(`- Migration 변경: ${migrations.length ? migrations.map(file => file.path).join(', ') : '없음'}`);
lines.push(`- 기타 SQL 변경: ${sqlFiles.length ? sqlFiles.map(file => file.path).join(', ') : '없음'}`);
lines.push('- 에이전트의 운영 DB 변경·Migration 적용: 없음 (정책상 금지 — AGENTS.md 수동 적용 절차)');
if (migrations.length || sqlFiles.length) lines.push(`- 사용자 승인·SQL Editor 적용 상태: ${TODO}: 미적용/적용 완료(일시) 중 사실만 기록 -->`);
lines.push('');
lines.push('## 6. Push·병합·배포');
lines.push(`- Git push: ${pushState}${upstream ? ` (upstream ${upstream})` : ''}`);
lines.push(`- main 병합: ${mergedIntoBase ? `${baseRef}에 포함됨` : '미병합'}`);
lines.push('- Vercel 배포: 에이전트 미실시 (사용자 승인 후 별도 진행)', '');
lines.push('## 7. 미완료 사항');
lines.push(`- ${TODO}: 남은 작업·미검증 항목의 처리 계획, 없으면 "없음" -->`, '');
lines.push('## 8. 후속 작업');
lines.push(`- ${TODO}: 사용자 승인 필요 항목(병합·배포·Migration 적용 등)과 다음 담당 -->`, '');
const content = `${lines.join('\n')}\n`;

if (args.stdout) {
  process.stdout.write(content);
} else {
  const out = args.out || `docs/handoffs/${identity.agent || 'agent'}-${taskId}.md`;
  const full = join(root, out);
  if (existsSync(full) && !args.force) {
    console.error(`${out}이(가) 이미 있다. 기존 인계서를 보존하려면 --out으로 다른 경로를 지정하고, 덮어쓰려면 --force를 쓴다.`);
    process.exit(2);
  }
  mkdirSync(dirname(full), {recursive: true});
  writeFileSync(full, content);
  console.log(`인계서 초안 작성: ${out}\nTODO 항목을 채운 뒤 node scripts/agent/baba-handoff.mjs --check ${out} 로 형식을 검사한다.`);
}

