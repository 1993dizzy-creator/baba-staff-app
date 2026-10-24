#!/usr/bin/env node
// baba-verify: post-change verification (docs/agents/baba-agent-workflow.md section 8).
// Every check reports what actually ran. Failures are compared against the merge-base so
// pre-existing errors are separated from new ones. Tests and builds run with credential
// variables removed and the offline guard preloaded (no production network access).
// Usage: node scripts/agent/baba-verify.mjs [--base origin/main] [--tests a,b] [--all-tests]
//          [--build] [--no-baseline] [--skip-lint] [--skip-tsc] [--concurrency 4] [--json]
import {spawn} from 'node:child_process';
import {existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync} from 'node:fs';
import {cpus, tmpdir} from 'node:os';
import {join, relative, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {
  HOT_FILES, POLICY_DOC, allTestFiles, collectChanges, defaultBaseRef, domainTestSuggestions, git, gitOut,
  identifyWorktree, matchesAny, migrationVersion, parseArgs, relatedTests, repoRoot, run, sanitizedEnv, splitList,
  stateFingerprint,
} from './lib/common.mjs';

const args = parseArgs(process.argv.slice(2), {
  base: 'string', tests: 'string', allTests: 'boolean', build: 'boolean', noBaseline: 'boolean', skipLint: 'boolean',
  skipTsc: 'boolean', concurrency: 'string', timeoutMs: 'string', json: 'boolean', help: 'boolean',
});
if (args.help) {
  console.log('node scripts/agent/baba-verify.mjs [--base origin/main] [--tests a,b] [--all-tests] [--build] [--no-baseline] [--skip-lint] [--skip-tsc] [--concurrency 4] [--json]');
  process.exit(0);
}

const root = repoRoot();
const baseRef = args.base || defaultBaseRef(root);
const {mergeBase, files} = collectChanges(root, baseRef);
const head = gitOut(root, ['rev-parse', 'HEAD']);
const branch = gitOut(root, ['branch', '--show-current']) || '(detached)';
const fingerprint = stateFingerprint(root);
const present = files.filter(file => !file.deleted && existsSync(join(root, file.path)) && statSync(join(root, file.path)).isFile());
const changedPaths = present.map(file => file.path);
const guardUrl = pathToFileURL(resolve(import.meta.dirname, 'lib', 'offline-guard.mjs')).href;
const {env: childEnv, removed: removedEnv} = sanitizedEnv();
childEnv.NODE_OPTIONS = `--import=${guardUrl}${process.env.NODE_OPTIONS ? ` ${process.env.NODE_OPTIONS}` : ''}`;
const concurrency = Math.max(1, Number(args.concurrency) || Math.min(4, Math.max(1, cpus().length >> 1)));
const timeoutMs = Number(args.timeoutMs) || 10 * 60 * 1000;
const checks = [];
const gaps = [];
const notes = [];
let baselineDir = null;
let baselineError = null;

// ---------- 1. Changed-file inspection ----------
const fileCheck = {name: '변경 파일 검사', status: 'passed', ran: true, findings: [], info: []};
const baseFiles = new Set(gitOut(root, ['ls-tree', '-r', '--name-only', mergeBase]).split('\n').filter(Boolean));
const SECRET_PATTERNS = [
  ['JWT 형식 키', /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['Supabase secret key', /\bsb_secret_[A-Za-z0-9_-]{16,}/],
  ['DB 접속 문자열(비밀번호 포함)', /postgres(?:ql)?:\/\/[^\s:/@'"]+:[^\s@'"]+@[^\s'"]+/i],
  ['자격 증명 대입', /\b(SUPABASE_SERVICE_ROLE_KEY|BABA_SESSION_SECRET|CUKCUK_SECRET_KEY|POS_ADMIN_SECRET|CRON_SECRET)\s*[=:]\s*['"]?[A-Za-z0-9_\-+/=.]{24,}/],
];
for (const file of files) {
  const path = file.path;
  if (/(^|\/)\.env(\.|$)/.test(path) && !path.endsWith('.example')) fileCheck.findings.push(`${path}: .env 파일은 커밋 대상이 아니다`);
  if (migrationVersion(path) && baseFiles.has(path)) fileCheck.findings.push(`${path}: 기존(기준선에 존재) Migration 수정${file.deleted ? '·삭제' : ''} 금지 — 후속 Migration으로 처리`);
  else if (migrationVersion(path)) fileCheck.info.push(`${path}: 신규 Migration — 로컬 검증까지만, 운영 적용은 사용자 승인·SQL Editor 수동 절차`);
}
const hotChanged = files.map(file => file.path).filter(path => matchesAny(path, HOT_FILES));
if (hotChanged.length) fileCheck.info.push(`공통 파일 변경 ${hotChanged.length}개 — 다른 Worktree와 병합 순서 확인 필요: ${hotChanged.join(', ')}`);
for (const file of present) {
  const full = join(root, file.path);
  if (statSync(full).size > 2 * 1024 * 1024) continue;
  const buffer = readFileSync(full);
  if (buffer.includes(0)) continue;
  const lines = buffer.toString('utf8').split(/\r?\n/);
  lines.forEach((line, index) => {
    if (/^(<{7}|>{7})( |$)|^={7}$/.test(line)) fileCheck.findings.push(`${file.path}:${index + 1}: 병합 충돌 표식`);
    for (const [label, pattern] of SECRET_PATTERNS) if (pattern.test(line)) fileCheck.findings.push(`${file.path}:${index + 1}: ${label} 의심 (값 미출력)`);
  });
}
if (fileCheck.findings.length) fileCheck.status = 'failed';
checks.push(fileCheck);

// ---------- 2. Related regression tests ----------
const related = relatedTests(root, files.filter(file => !file.deleted).map(file => file.path));
const explicit = splitList(args.tests);
const testTargets = new Map();
for (const test of related.tests) testTargets.set(test.path, test.reasons);
for (const test of explicit) testTargets.set(test, ['--tests 지정']);
if (args.allTests) for (const test of allTestFiles(root)) if (!testTargets.has(test)) testTargets.set(test, ['--all-tests']);
const testCheck = {name: '회귀 테스트', status: 'not-run', ran: false, files: [], newFailures: [], preexisting: [], blockedNetwork: []};
if (testTargets.size) {
  testCheck.ran = true;
  testCheck.files = await pool([...testTargets.keys()], test => runTest(root, test));
  for (const result of testCheck.files) result.reasons = testTargets.get(result.path);
  const failing = testCheck.files.filter(result => result.status === 'failed');
  testCheck.blockedNetwork = testCheck.files.filter(result => result.networkBlocked).map(result => result.path);
  if (failing.length) {
    const base = await baseline();
    for (const result of failing) {
      if (!base) result.classification = 'unclassified';
      else if (!existsSync(join(base, result.path))) result.classification = 'new';
      else {
        const before = await runTest(base, result.path);
        const known = new Set(before.failedNames);
        result.baseline = {status: before.status, failedNames: before.failedNames};
        result.classification = before.status === 'failed' && result.failedNames.every(name => known.has(name)) ? 'preexisting' : 'new';
      }
    }
    testCheck.newFailures = failing.filter(result => result.classification !== 'preexisting').map(result => result.path);
    testCheck.preexisting = failing.filter(result => result.classification === 'preexisting').map(result => result.path);
  }
  testCheck.status = testCheck.newFailures.length ? 'failed' : testCheck.preexisting.length ? 'passed-with-preexisting' : 'passed';
  if (failing.some(result => result.classification === 'unclassified')) testCheck.status = 'failed';
} else {
  gaps.push('관련 회귀 테스트를 찾지 못해 테스트를 실행하지 않았다.');
}
if (related.untested.length) {
  const suggestions = domainTestSuggestions(root, related.untested);
  gaps.push(`테스트가 참조하지 않는 변경 파일: ${related.untested.join(', ')}${suggestions.length ? ` (도메인 테스트 후보 ${suggestions.length}개: --tests로 지정 가능)` : ''}`);
}
if (testCheck.blockedNetwork.length) notes.push(`오프라인 가드가 외부 연결을 차단한 테스트: ${testCheck.blockedNetwork.join(', ')} — 운영 연결 시도 여부를 확인한다.`);
checks.push(testCheck);

// ---------- 3. ESLint (changed files, baseline per file) ----------
const lintTargets = changedPaths.filter(path => /\.(tsx?|jsx?|mjs|cjs)$/.test(path));
const lintCheck = {name: 'ESLint (변경 파일)', status: 'not-run', ran: false, files: lintTargets.length, newErrors: [], newWarnings: [], preexisting: 0, ignored: []};
if (args.skipLint) gaps.push('ESLint를 --skip-lint로 건너뛰었다.');
else if (lintTargets.length) {
  lintCheck.ran = true;
  const current = eslintJson(root, lintTargets);
  if (current.error) {
    lintCheck.status = 'error';
    lintCheck.error = current.error;
  } else {
    for (const result of current.results) {
      const path = relPath(result.filePath);
      if (result.messages.some(message => /File ignored/i.test(message.message))) {
        lintCheck.ignored.push(path);
        continue;
      }
      if (!result.messages.length) continue;
      const before = baseFiles.has(path) && !args.noBaseline ? eslintStdin(root, path, gitOut(root, ['show', `${mergeBase}:${path}`])) : [];
      const remaining = countKeys(before.map(lintKey));
      for (const message of result.messages) {
        const key = lintKey(message);
        if (remaining.get(key) > 0) {
          remaining.set(key, remaining.get(key) - 1);
          lintCheck.preexisting++;
          continue;
        }
        const text = `${path}:${message.line}:${message.column} ${message.ruleId || 'parse'} ${message.message}`;
        (message.severity === 2 ? lintCheck.newErrors : lintCheck.newWarnings).push(text);
      }
    }
    lintCheck.status = lintCheck.newErrors.length ? 'failed' : 'passed';
    if (args.noBaseline && lintCheck.newErrors.length) lintCheck.status = 'failed-unclassified';
  }
}
checks.push(lintCheck);

// ---------- 4. TypeScript (whole project, baseline diff) ----------
const tscCheck = {name: 'TypeScript (tsc --noEmit)', status: 'not-run', ran: false, total: 0, newErrors: [], preexisting: 0};
if (args.skipTsc) gaps.push('TypeScript 검사를 --skip-tsc로 건너뛰었다.');
else {
  tscCheck.ran = true;
  const current = await tsc(root);
  tscCheck.total = current.length;
  if (current.length) {
    const base = await baseline();
    if (!base) {
      tscCheck.status = 'failed-unclassified';
      tscCheck.newErrors = current.map(diag => diag.text);
    } else {
      const remaining = countKeys((await tsc(base)).map(diag => diag.key));
      for (const diag of current) {
        if (remaining.get(diag.key) > 0) {
          remaining.set(diag.key, remaining.get(diag.key) - 1);
          tscCheck.preexisting++;
        } else tscCheck.newErrors.push(diag.text);
      }
      tscCheck.status = tscCheck.newErrors.length ? 'failed' : 'passed-with-preexisting';
    }
  } else tscCheck.status = 'passed';
}
checks.push(tscCheck);

// ---------- 5. Production build (opt-in) ----------
const BUILD_TRIGGERS = ['next.config.ts', 'package.json', 'package-lock.json', 'tsconfig.json', 'postcss.config.mjs', 'proxy.ts', 'middleware.ts', 'app/**/layout.tsx', 'app/**/page.tsx', 'app/**/route.ts', 'app/**/*.css', 'app/manifest.ts'];
const buildReasons = files.filter(file => matchesAny(file.path, BUILD_TRIGGERS) && (file.added || file.deleted || !/\/(page|route)\.tsx?$/.test(file.path))).map(file => file.path);
const buildCheck = {name: 'Production Build (next build)', status: 'not-run', ran: false, recommendedBy: buildReasons};
if (args.build) {
  buildCheck.ran = true;
  const result = await exec(process.execPath, [join(root, 'node_modules', 'next', 'dist', 'bin', 'next'), 'build'], {cwd: root, env: childEnv, timeout: 30 * 60 * 1000});
  buildCheck.exitCode = result.code;
  buildCheck.tail = tail(result.output, 40);
  if (result.code === 0) buildCheck.status = 'passed';
  else if (/supabase(Url| url)|NEXT_PUBLIC_SUPABASE|SUPABASE_SERVICE_ROLE_KEY|BABA_SESSION_SECRET|environment variable|BABA_OFFLINE_GUARD/i.test(result.output)) {
    buildCheck.status = 'blocked-env';
    gaps.push('Production Build가 개발 환경 변수(운영 자격 증명 제거)·오프라인 가드 때문에 완료되지 않았다. 코드 오류와 구분되지 않으므로 미검증으로 본다.');
  } else {
    const base = await baseline();
    if (base) {
      const before = await exec(process.execPath, [join(base, 'node_modules', 'next', 'dist', 'bin', 'next'), 'build'], {cwd: base, env: childEnv, timeout: 30 * 60 * 1000});
      buildCheck.baselineExitCode = before.code;
      buildCheck.status = before.code === 0 ? 'failed' : 'failed-preexisting';
    } else buildCheck.status = 'failed-unclassified';
  }
} else if (buildReasons.length) gaps.push(`Production Build 권장 변경(${buildReasons.join(', ')})이 있으나 --build를 실행하지 않았다.`);
checks.push(buildCheck);

// ---------- 6. Always-unverified items ----------
if (files.some(file => /^(app|components)\//.test(file.path))) gaps.push('브라우저 화면 동작(UI)은 이 스크립트가 확인하지 않는다. 필요 시 별도 실행 확인 결과를 인계서에 기록한다.');
if (files.some(file => migrationVersion(file.path) || /\.sql$/.test(file.path))) gaps.push('운영 DB 적용·운영 검증은 수행하지 않는다(AGENTS.md 수동 절차 대상).');
if (baselineError) notes.push(`기준선 준비 실패: ${baselineError}`);
if (removedEnv.length) notes.push(`자식 프로세스에서 제거한 자격 증명 계열 환경 변수 이름: ${removedEnv.join(', ')}`);

// ---------- Verdict ----------
const failed = checks.filter(check => /^(failed|error)/.test(check.status) && check.status !== 'failed-preexisting');
const preexisting = checks.filter(check => /preexisting/.test(check.status));
const verdict = failed.length ? 'FAIL' : preexisting.length ? 'PASS_WITH_PREEXISTING' : 'PASS';
const report = {
  tool: 'baba-verify', generatedAt: new Date().toISOString(), policy: POLICY_DOC, worktree: identifyWorktree(root), root, branch, head, baseRef, mergeBase, fingerprint,
  changedFiles: files.map(file => ({path: file.path, committed: file.committed, working: file.working, deleted: file.deleted})),
  checks, gaps, notes, verdict, baselineDir,
};
const outDir = join(root, '.tmp-baba', 'verify');
mkdirSync(outDir, {recursive: true});
const outFile = join(outDir, `${report.generatedAt.replace(/[:.]/g, '-')}-${head.slice(0, 8)}.json`);
writeFileSync(outFile, JSON.stringify(report, null, 2));
writeFileSync(join(outDir, 'latest.json'), JSON.stringify({...report, savedAs: relPath(outFile)}, null, 2));
console.log(args.json ? JSON.stringify(report, null, 2) : render(report, relPath(outFile)));
process.exitCode = verdict === 'FAIL' ? 1 : 0;

// ---------- helpers ----------
function relPath(path) {
  return relative(root, resolve(path)).split('\\').join('/');
}

function countKeys(keys) {
  const map = new Map();
  for (const key of keys) map.set(key, (map.get(key) || 0) + 1);
  return map;
}

function lintKey(message) {
  return `${message.ruleId || 'parse'}|${message.severity}|${message.message}`;
}

function tail(text, count) {
  return text.split(/\r?\n/).filter(Boolean).slice(-count).join('\n');
}

function exec(command, argv, {cwd, env, timeout}) {
  return new Promise(done => {
    const child = spawn(command, argv, {cwd, env, windowsHide: true});
    let output = '';
    const timer = setTimeout(() => {
      output += `\n[baba-verify] timeout after ${timeout}ms`;
      child.kill();
    }, timeout);
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('error', error => { output += `\n${error.message}`; });
    child.on('close', code => {
      clearTimeout(timer);
      done({code: code ?? -1, output});
    });
  });
}

async function pool(items, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({length: Math.min(concurrency, items.length)}, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]);
    }
  }));
  return results;
}

async function runTest(cwd, path) {
  if (!existsSync(join(cwd, path))) return {path, status: 'missing', failedNames: [], counts: {}};
  const started = Date.now();
  const result = await exec(process.execPath, ['--experimental-strip-types', '--no-warnings=ExperimentalWarning', '--test', '--test-reporter=tap', path], {cwd, env: childEnv, timeout: timeoutMs});
  const counts = {};
  for (const m of result.output.matchAll(/^# (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)/gm)) counts[m[1]] = Number(m[2]);
  const failedNames = [...new Set([...result.output.matchAll(/^\s*not ok \d+ - (.+?)(?: # .*)?$/gm)].map(m => m[1].trim()).filter(name => name !== path))];
  const failed = result.code !== 0 || (counts.fail || 0) > 0 || (counts.cancelled || 0) > 0;
  const allSkipped = !failed && counts.tests > 0 && counts.skipped === counts.tests;
  return {
    path, status: failed ? 'failed' : allSkipped ? 'skipped' : 'passed', exitCode: result.code, counts, failedNames,
    durationMs: Date.now() - started, networkBlocked: /BABA_OFFLINE_GUARD/.test(result.output), tail: failed ? tail(result.output, 30) : undefined,
  };
}

function eslintJson(cwd, targets) {
  const result = run(process.execPath, [join(cwd, 'node_modules', 'eslint', 'bin', 'eslint.js'), '--format', 'json', '--no-warn-ignored', ...targets], {cwd, env: childEnv, allowFail: true});
  try {
    return {results: JSON.parse(result.stdout)};
  } catch {
    return {error: (result.stderr || result.stdout).trim().split('\n').slice(0, 5).join('\n')};
  }
}

function eslintStdin(cwd, path, source) {
  const result = run(process.execPath, [join(cwd, 'node_modules', 'eslint', 'bin', 'eslint.js'), '--format', 'json', '--stdin', '--stdin-filename', path], {cwd, env: childEnv, allowFail: true, input: source});
  try {
    return JSON.parse(result.stdout)[0]?.messages || [];
  } catch {
    return [];
  }
}

async function tsc(cwd) {
  await exec(process.execPath, [join(cwd, 'node_modules', 'next', 'dist', 'bin', 'next'), 'typegen'], {cwd, env: childEnv, timeout: 5 * 60 * 1000});
  const result = await exec(process.execPath, [join(cwd, 'node_modules', 'typescript', 'lib', 'tsc.js'), '--noEmit', '--incremental', 'false', '--pretty', 'false', '-p', 'tsconfig.json'], {cwd, env: childEnv, timeout: 15 * 60 * 1000});
  const diags = [];
  for (const m of result.output.matchAll(/^(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/gm)) {
    const file = m[1].split('\\').join('/');
    diags.push({key: `${file}|${m[4]}|${m[5].trim()}`, text: `${file}:${m[2]}:${m[3]} ${m[4]} ${m[5].trim()}`});
  }
  if (!diags.length && result.code !== 0) diags.push({key: `tsc|exit|${result.code}`, text: `tsc exited ${result.code}: ${tail(result.output, 5)}`});
  return diags;
}

// Baseline = merge-base snapshot outside the worktree (OS temp), checked out through a private
// index file so no worktree, branch or shared index is created or modified.
async function baseline() {
  if (args.noBaseline) return null;
  if (baselineDir || baselineError) return baselineDir;
  const dir = join(tmpdir(), 'baba-verify-baseline', mergeBase.slice(0, 12));
  const marker = join(dir, '.baba-baseline-ready');
  try {
    if (!existsSync(marker)) {
      releaseJunction(dir);
      rmSync(dir, {recursive: true, force: true});
      mkdirSync(dir, {recursive: true});
      const indexEnv = {...process.env, GIT_INDEX_FILE: join(dir, '.baba-baseline-index')};
      git(root, ['read-tree', mergeBase], {env: indexEnv});
      git(root, [`--work-tree=${dir}`, 'checkout-index', '-a', '-f'], {env: indexEnv});
      writeFileSync(marker, `${mergeBase}\n`);
    }
    // The node_modules junction exists only while this process runs, so a later recursive
    // cleanup of the temp folder can never follow it into the worktree's real node_modules.
    if (!existsSync(join(dir, 'node_modules'))) symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), 'junction');
    process.once('exit', () => releaseJunction(dir));
    baselineDir = dir;
  } catch (error) {
    baselineError = error.message.split('\n')[0];
  }
  return baselineDir;
}

function releaseJunction(dir) {
  const link = join(dir, 'node_modules');
  try {
    if (lstatSync(link).isSymbolicLink()) unlinkSync(link);
  } catch {
    // Missing link: nothing to release.
  }
}

function statusLabel(check) {
  return {
    passed: '통과', 'passed-with-preexisting': '통과(기존 오류만 존재)', failed: '실패(신규)', 'failed-unclassified': '실패(기존/신규 미분류)',
    'failed-preexisting': '실패(기준선도 실패 — 기존)', 'not-run': '미실행', 'blocked-env': '미완료(환경 차단)', error: '실행 오류', skipped: '건너뜀',
  }[check.status] || check.status;
}

function render(r, saved) {
  const lines = [`# BABA Verify — ${r.branch} @ ${r.head.slice(0, 12)}`, ''];
  lines.push(`판정: **${r.verdict}** · 기준: ${r.baseRef} (${r.mergeBase.slice(0, 12)}) · 상태 지문: ${r.fingerprint}`, '');
  lines.push(`변경 파일 ${r.changedFiles.length}개: ${r.changedFiles.map(file => file.path).join(', ') || '없음'}`, '');
  lines.push('| 검사 | 실제 실행 | 결과 | 요약 |', '| --- | --- | --- | --- |');
  for (const check of r.checks) {
    let summary = check.ran ? '' : '-';
    if (check.findings) summary = `${check.findings.length}건 문제, 참고 ${check.info.length}건`;
    if (check.ran && Array.isArray(check.files)) {
      const count = status => check.files.filter(file => file.status === status).length;
      summary = `${check.files.length}개 파일: 통과 ${count('passed')}, 실패 ${count('failed')}(신규 ${check.newFailures.length}, 기존 ${check.preexisting.length}), 전부 skip ${count('skipped')}`;
    }
    if (check.ran && 'newErrors' in check && typeof check.preexisting === 'number') summary = `신규 오류 ${check.newErrors.length}, 기존 ${check.preexisting}${check.newWarnings ? `, 신규 경고 ${check.newWarnings.length}` : ''}${check.total !== undefined ? `, 전체 ${check.total}` : ''}`;
    if (check.recommendedBy) summary = check.ran ? `exit ${check.exitCode}` : check.recommendedBy.length ? `권장 사유: ${check.recommendedBy.length}개 파일` : '권장 사유 없음';
    lines.push(`| ${check.name} | ${check.ran ? '예' : '아니오'} | ${statusLabel(check)} | ${summary} |`);
  }
  lines.push('');
  for (const check of r.checks) {
    const items = [...(check.findings || []), ...(check.newErrors || []).slice(0, 30), ...(check.newWarnings || []).slice(0, 15).map(text => `경고: ${text}`), ...(check.newFailures || []).map(path => `신규 실패 테스트: ${path}`)];
    if (items.length) lines.push(`### ${check.name} 상세`, ...items.map(item => `- ${item}`), '');
    if (check.info?.length) lines.push(`### ${check.name} 참고`, ...check.info.map(item => `- ${item}`), '');
    if (check.error) lines.push(`### ${check.name} 오류`, '```', check.error, '```', '');
  }
  const failedTests = (r.checks.find(check => check.name === '회귀 테스트')?.files || []).filter(file => file.status === 'failed');
  for (const file of failedTests) lines.push(`#### ${file.path} (${file.classification})`, ...file.failedNames.slice(0, 10).map(name => `- not ok: ${name}`), '');
  lines.push('## 미검증 항목', ...(r.gaps.length ? r.gaps.map(gap => `- ${gap}`) : ['- 없음']), '');
  if (r.notes.length) lines.push('## 참고', ...r.notes.map(note => `- ${note}`), '');
  lines.push(`결과 파일: ${saved} (handoff가 읽음)`);
  return lines.join('\n');
}
