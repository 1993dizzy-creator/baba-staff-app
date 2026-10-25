// Validate actual baba-verify reports; a verdict string alone is never merge evidence.
import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {insideRoot} from './common.mjs';

export const CHECKS = {files: '변경 파일 검사', tests: '회귀 테스트', lint: 'ESLint (변경 파일)',
  types: 'TypeScript (tsc --noEmit)', build: 'Production Build (next build)'};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function verifyEvidence(root, report, {head, branch, fingerprint, build = false} = {}) {
  const problems = [];
  if (!report || report.tool !== 'baba-verify' || report.root !== root ||
      !['PASS', 'PASS_WITH_PREEXISTING'].includes(report.verdict) ||
      !/^[0-9a-f]{40}$/.test(report.head || '') || !/^[0-9a-f]{40}$/.test(report.mergeBase || '') ||
      !/^[0-9a-f]{16}$/.test(report.fingerprint || '') || !Array.isArray(report.changedFiles) ||
      !Array.isArray(report.checks) || !Array.isArray(report.gaps)) return ['VERIFY_MISSING_OR_INVALID'];
  if ((head && report.head !== head) || (branch && report.branch !== branch) ||
      (fingerprint && report.fingerprint !== fingerprint)) problems.push('VERIFY_STATE_MISMATCH');
  const selection = report.testSelection;
  if (!/^[0-9a-f]{40}$/.test(report.baseSha || '') || !selection || typeof selection.allTests !== 'boolean' ||
      !Array.isArray(selection.explicit) || !Array.isArray(selection.executed) || !selection.executed.length ||
      selection.executed.some(path => typeof path !== 'string' || !/\.test\.(mjs|ts)$/.test(path)) ||
      selection.explicit.some(path => !selection.executed.includes(path))) problems.push('VERIFY_TEST_SELECTION_MISSING');
  if (report.gaps.some(gap => /테스트가 참조하지 않는 변경 파일|관련 회귀 테스트를 찾지 못해/.test(gap))) problems.push('VERIFY_TEST_SCOPE_INSUFFICIENT');
  const map = new Map(report.checks.map(check => [check.name, check]));
  // D2: files proven only by execution evidence must be changed files, exercised by passing executed tests.
  const exercised = selection?.exercised ?? {};
  if (!exercised || typeof exercised !== 'object' || Array.isArray(exercised)) problems.push('VERIFY_EXERCISE_EVIDENCE_INVALID');
  else {
    const changed = new Set(report.changedFiles.filter(file => !file.deleted).map(file => file.path));
    const results = new Map((map.get(CHECKS.tests)?.files || []).map(file => [file.path, file]));
    for (const [path, tests] of Object.entries(exercised)) {
      const code = /\.(tsx?|jsx?|mjs|cjs)$/.test(path);
      if (!changed.has(path) || !Array.isArray(tests) || !tests.length || tests.some(test => {
        const result = results.get(test);
        return !selection.executed.includes(test) || result?.status !== 'passed' || !result.counts?.tests ||
          !(result.access?.[path] || []).some(kind => !code || kind === 'import');
      })) problems.push('VERIFY_EXERCISE_EVIDENCE_INVALID');
    }
  }
  if (map.size !== report.checks.length) problems.push('VERIFY_DUPLICATE_CHECK');
  if ([...map.keys()].some(name => !Object.values(CHECKS).includes(name))) problems.push('VERIFY_UNKNOWN_CHECK');
  const js = report.changedFiles.some(file => !file.deleted && /\.(tsx?|jsx?|mjs|cjs)$/.test(file.path));
  const preexisting = [];
  for (const [kind, name] of Object.entries(CHECKS)) {
    const check = map.get(name);
    const required = ['files', 'tests', 'types'].includes(kind) || (kind === 'lint' && js) || (kind === 'build' && build);
    if (!check) { problems.push(`VERIFY_CHECK_MISSING:${kind}`); continue; }
    if (typeof check.ran !== 'boolean') problems.push(`VERIFY_CHECK_AMBIGUOUS:${kind}`);
    if (check.ran === false && check.status !== 'not-run') problems.push(`VERIFY_CHECK_AMBIGUOUS:${kind}`);
    if (required && check.ran !== true) problems.push(`VERIFY_NOT_RUN:${kind}`);
    const acceptable = ['passed', 'passed-with-preexisting', 'failed-preexisting'];
    if (!acceptable.includes(check.status) && !(check.ran === false && !required && check.status === 'not-run')) problems.push(`VERIFY_FAILED_OR_UNKNOWN:${kind}`);
    if ((check.newErrors || []).length || (check.newFailures || []).length || (check.findings || []).length || check.error) problems.push(`VERIFY_NEW_ERRORS:${kind}`);
    if (/preexisting/.test(check.status) || (typeof check.preexisting === 'number' && check.preexisting > 0)) preexisting.push(kind);
    if (kind === 'build' && check.ran && (check.status === 'passed' ? check.exitCode !== 0 : check.status === 'failed-preexisting' &&
        (!Number.isInteger(check.exitCode) || check.exitCode === 0 || !Number.isInteger(check.baselineExitCode) || check.baselineExitCode === 0))) problems.push('VERIFY_BUILD_EXIT_MISMATCH');
    if (kind === 'tests' && check.ran) {
      if (selection && !same([...(selection.executed || [])].sort(), (check.files || []).map(file => file.path).sort())) problems.push('VERIFY_TEST_SELECTION_MISMATCH');
      if (!Array.isArray(check.files) || !check.files.length) problems.push('VERIFY_TEST_RESULTS_MISSING');
      for (const file of check.files || []) {
        if (file.networkBlocked || !file.counts?.tests || file.counts.skipped || file.counts.cancelled || file.counts.todo) problems.push('VERIFY_TEST_INCOMPLETE');
        if (file.status === 'failed') {
          if (check.status !== 'passed-with-preexisting' || report.verdict !== 'PASS_WITH_PREEXISTING') problems.push('VERIFY_VERDICT_INCONSISTENT');
          if (file.classification !== 'preexisting' || file.baseline?.status !== 'failed' ||
              !file.failedNames?.length || !file.failureDetails?.length ||
              !same(file.failedNames, file.baseline.failedNames) || !same(file.failureDetails, file.baseline.failureDetails)) problems.push('VERIFY_TEST_BASELINE_INVALID');
        } else if (file.status !== 'passed' || file.exitCode !== 0) problems.push('VERIFY_TEST_STATUS_UNKNOWN');
      }
    }
  }
  if (preexisting.length) {
    if (report.verdict !== 'PASS_WITH_PREEXISTING') problems.push('VERIFY_VERDICT_INCONSISTENT');
    try {
      const directory = insideRoot(root, report.baselineDir);
      const manifest = JSON.parse(readFileSync(insideRoot(root, join(directory, '.baba-baseline.json')), 'utf8'));
      if (manifest.root !== root || manifest.sha !== report.mergeBase || manifest.version !== 1 ||
          !existsSync(insideRoot(root, join(directory, '.baba-baseline-index')))) throw new Error('Invalid baseline');
    } catch { problems.push('VERIFY_BASELINE_SNAPSHOT_MISSING'); }
    for (const kind of preexisting.filter(kind => kind !== 'tests')) {
      const evidence = map.get(CHECKS[kind]).baselineEvidence;
      if (!evidence || evidence.sha !== report.mergeBase || !evidence.current?.length || !evidence.before?.length) {
        problems.push(`VERIFY_BASELINE_EVIDENCE_MISSING:${kind}`); continue;
      }
      const remaining = [...evidence.before];
      for (const item of evidence.current) {
        const index = remaining.indexOf(item);
        if (index < 0) problems.push(`VERIFY_BASELINE_DIFFERS:${kind}`);
        else remaining.splice(index, 1);
      }
    }
  } else if (report.verdict !== 'PASS') problems.push('VERIFY_PREEXISTING_EVIDENCE_MISSING');
  return [...new Set(problems)];
}
