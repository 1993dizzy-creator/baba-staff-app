// Shared helpers for the baba-preflight / baba-verify / baba-handoff skills.
// The policy these helpers enforce lives in docs/agents/baba-agent-workflow.md.
// Git is always called with --no-optional-locks so read-only inspection never refreshes an index.
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync} from 'node:fs';
import {basename, dirname, join, relative, resolve, sep} from 'node:path';

export const POLICY_DOC = 'docs/agents/baba-agent-workflow.md';

// Worktree ownership (docs/agents/baba-agent-workflow.md section 1).
export const AGENTS = {
  codex: {worktreeDir: 'baba-wt-codex', branchPrefix: 'codex/', port: 3001},
  claude: {worktreeDir: 'baba-wt-claude', branchPrefix: 'claude/', port: 3002},
};
export const ORIGINAL_DIR = 'baba-staff-app';

// Files and areas every agent shares. Touching them needs a conflict check (section 5).
export const HOT_FILES = [
  'package.json', 'package-lock.json', 'next.config.ts', 'tsconfig.json', 'eslint.config.mjs',
  'postcss.config.mjs', 'vercel.json', 'proxy.ts', 'middleware.ts', 'AGENTS.md', 'CLAUDE.md',
  'app/layout.tsx', 'app/(protected)/layout.tsx', 'lib/supabase/**', 'lib/auth/**',
  'lib/navigation/**', 'lib/text/**', 'lib/common/**', 'supabase/migrations/**',
  'docs/agents/**', '.agents/**', '.claude/**', 'scripts/agent/**',
];

// Paths whose change may reach production data or schedules (section 6).
export const PRODUCTION_SENSITIVE = [
  {pattern: 'supabase/migrations/**', level: 'high', reason: 'Migration: 운영 DB 스키마·함수·권한 변경 후보 (AGENTS.md 승인 절차 필수)'},
  {pattern: '**/*.sql', level: 'high', reason: 'SQL 파일: 운영 SQL Editor 실행 후보 (승인 전 실행 금지)'},
  {pattern: 'app/api/cron/**', level: 'high', reason: 'Vercel cron 경로: 배포 시 운영 데이터 자동 변경'},
  {pattern: 'vercel.json', level: 'high', reason: 'Vercel cron·배포 설정'},
  {pattern: 'lib/pos/**', level: 'medium', reason: 'POS(CUKCUK) 연동: CUKCUK_BASE_URL 미설정 시 운영 POS 기본값 사용'},
  {pattern: 'lib/supabase/**', level: 'medium', reason: 'Supabase 클라이언트·service role 경로'},
];

// Confirmed BABA business policies. Agents must not change their meaning without user approval.
export const DOMAINS = {
  pos: {label: 'POS·매출', match: /(^|[/_-])(pos|cukcuk|sales|receipt)/i},
  ledger: {label: '장부', match: /(^|[/_-])(ledger|payable|card-settlement|partners?)/i},
  inventory: {label: '재고', match: /(^|[/_-])(inventory|keg|snapshot|bar)/i},
  payroll: {label: '급여·근태', match: /(^|[/_-])(payroll|attendance|early-leave|meal|employee)/i},
  vat: {label: 'VAT·세금', match: /(^|[/_-])(vat|tax|receipt-financials)/i},
};

export const CREDENTIAL_ENV = /SUPABASE|CUKCUK|^POS_|^CRON_|^BABA_SESSION|^DATABASE_URL$|^DIRECT_URL$|^PG(PASSWORD|HOST|USER|DATABASE|SERVICE)$|^VERCEL_TOKEN$|^GITHUB_TOKEN$|^GH_TOKEN$/i;

export function run(command, args, {cwd, env, allowFail = false, input, timeout} = {}) {
  const result = spawnSync(command, args, {cwd, env, input, timeout, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, windowsHide: true});
  if (result.error && !allowFail) throw result.error;
  if (result.status !== 0 && !allowFail) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status}): ${(result.stderr || '').trim()}`);
  }
  return {status: result.status, stdout: result.stdout || '', stderr: result.stderr || '', error: result.error};
}

export function git(root, args, options = {}) {
  return run('git', ['--no-pager', '--no-optional-locks', '-c', 'core.quotepath=off', ...args], {cwd: root, ...options});
}
export const gitOut = (root, args, options) => git(root, args, options).stdout.trim();
export const gitTry = (root, args) => {
  const r = git(root, args, {allowFail: true});
  return r.status === 0 ? r.stdout.trim() : null;
};

// Inspect effective includes/config without reading hook commands (which may contain secrets).
// Conditional includes are deliberately rejected: later branch/gitdir contexts can activate them.
// This does not solve another process changing configuration after this check (R2).
export function assertNoGitHooks(root, {env = process.env} = {}) {
  const reject = (code, message) => { throw Object.assign(new Error(message), {code}); };
  const safeVariables = new Set(['GIT_PAGER', 'GIT_TERMINAL_PROMPT', 'GIT_OPTIONAL_LOCKS']);
  for (const name of Object.keys(env).filter(name => /^GIT_/i.test(name))) {
    if (safeVariables.has(name.toUpperCase())) continue;
    if (name.toUpperCase() === 'GIT_INDEX_FILE') { insideRoot(root, env[name]); continue; }
    reject('GIT_ENVIRONMENT_UNVERIFIED', 'Git environment overrides require independent review (values withheld).');
  }
  const query = args => run('git', ['--no-pager', '--no-optional-locks', '-c', 'core.quotepath=off', ...args], {cwd: root, env, allowFail: true});
  const configured = query(['config', '--includes', '--null', '--name-only', '--get-regexp', '^(hook\\.|includeif\\.|core\\.hookspath$)']);
  if (![0, 1].includes(configured.status)) reject('GIT_CONFIG_UNVERIFIED', 'Effective Git configuration could not be inspected.');
  const keys = configured.stdout.split('\0').filter(Boolean);
  if (keys.some(key => /^includeif\./i.test(key))) reject('GIT_CONFIG_CONTEXT_UNVERIFIED', 'Conditional Git includes may change hooks in a later context.');
  if (keys.some(key => /^hook\./i.test(key))) reject('ACTIVE_CONFIG_GIT_HOOK', 'Config-based Git hooks require review; commands were not executed or printed.');
  const common = query(['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (common.status !== 0) reject('GIT_DIRECTORY_UNVERIFIED', 'Git common directory could not be inspected.');
  const directories = new Set([join(common.stdout.trim(), 'hooks')]);
  const alternate = query(['config', '--includes', '--path', '--get', 'core.hooksPath']);
  if (![0, 1].includes(alternate.status)) reject('GIT_CONFIG_UNVERIFIED', 'Git hooksPath could not be inspected.');
  if (alternate.status === 0) {
    if (!alternate.stdout.trim()) reject('GIT_CONFIG_UNVERIFIED', 'Empty Git hooksPath is ambiguous.');
    directories.add(resolve(root, alternate.stdout.trim()));
  }
  for (const directory of directories) {
    let entries;
    try { entries = readdirSync(directory, {withFileTypes: true}); }
    catch (error) {
      if (error.code === 'ENOENT') {
        try { lstatSync(directory); } catch (missing) { if (missing.code === 'ENOENT') continue; }
      }
      reject('GIT_HOOK_DIRECTORY_UNVERIFIED', 'Git hook directory could not be inspected.');
    }
    if (entries.some(entry => !entry.name.endsWith('.sample'))) reject('ACTIVE_GIT_HOOK', 'File-based Git hooks, including post-index-change, require review.');
  }
  return {fileHooks: false, configHooks: false, conditionalIncludes: false};
}

export function guardedGit(root, args, options = {}) {
  assertNoGitHooks(root, options);
  return git(root, args, options);
}

export function repoRoot(cwd = process.cwd()) {
  return resolve(gitOut(cwd, ['rev-parse', '--show-toplevel']));
}

export const toPosix = path => path.split(sep).join('/');

export function globToRegExp(glob) {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      source += glob[i + 2] === '/' ? '(?:.*/)?' : '.*';
      i += glob[i + 2] === '/' ? 2 : 1;
    } else if (c === '*') source += '[^/]*';
    else if (c === '?') source += '[^/]';
    else source += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`, 'i');
}
export const matchesAny = (path, globs) => globs.some(glob => globToRegExp(glob).test(path));

export function identifyWorktree(root) {
  const dir = basename(root).toLowerCase();
  const agent = Object.entries(AGENTS).find(([, value]) => value.worktreeDir === dir)?.[0] || null;
  return {dir, agent, isOriginal: dir === ORIGINAL_DIR};
}

// Resolve both lexical paths and existing ancestors: junctions must not escape the worktree.
export function insideRoot(root, path) {
  if (typeof path !== 'string' || !path || path.includes('\0') || /^[A-Za-z]:(?![\\/])/.test(path)) throw new Error('Invalid worktree path');
  const full = resolve(root, path);
  const within = (parent, child) => {
    const rel = relative(parent, child);
    return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !/^(?:[A-Za-z]:|[\\/])/.test(rel));
  };
  if (!within(root, full)) throw new Error('Path must stay inside the current worktree');
  // Reject Windows alternate streams and drive-relative paths on every platform.
  if (relative(root, full).includes(':')) throw new Error('Invalid worktree path (stream/drive)');
  let ancestor = full;
  while (true) {
    try { lstatSync(ancestor); break; } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      ancestor = dirname(ancestor);
    }
  }
  if (!within(realpathSync(root), realpathSync(ancestor))) throw new Error('Path traverses a link outside the current worktree');
  return full;
}

// Managed tool output is always rooted in the caller's registered worktree, never cwd/TEMP.
// This is path validation for our tools, not an OS sandbox for arbitrary shell programs.
export function worktreeEnvironment(root, env = sanitizedEnv().env, cwd = root) {
  insideRoot(root, cwd);
  const temp = insideRoot(root, '.tmp-baba/tmp');
  mkdirSync(temp, {recursive: true});
  return {...env, TEMP: temp, TMP: temp, TMPDIR: temp};
}

export function writeRecord(root, path, value, {replace = false} = {}) {
  const full = insideRoot(root, path);
  mkdirSync(dirname(full), {recursive: true});
  // Check again after mkdir; do not follow an externally redirected parent or file.
  insideRoot(root, path);
  if (existsSync(full)) {
    const previous = lstatSync(full);
    if (!previous.isFile() || previous.isSymbolicLink() || previous.nlink !== 1) throw new Error('Record output must be an unshared regular file');
  }
  writeFileSync(full, JSON.stringify(value, null, 2) + '\n', {flag: replace ? 'w' : 'wx'});
  return full;
}

export function assertOwnedWorktree(root) {
  const identity = identifyWorktree(root);
  const branch = gitOut(root, ['branch', '--show-current']);
  if (!identity.agent || !branch.startsWith(AGENTS[identity.agent].branchPrefix)) {
    throw new Error('Writes require an agent-owned worktree and matching branch');
  }
  if (!listWorktrees(root).some(tree => tree.path.toLowerCase() === root.toLowerCase())) throw new Error('Unregistered worktree');
}

export function listWorktrees(root) {
  const out = gitOut(root, ['worktree', 'list', '--porcelain']);
  const list = [];
  let current = null;
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) list.push(current = {path: resolve(line.slice(9)), branch: null, head: null});
    else if (current && line.startsWith('HEAD ')) current.head = line.slice(5);
    else if (current && line.startsWith('branch ')) current.branch = line.slice(7).replace('refs/heads/', '');
    else if (current && line === 'detached') current.branch = '(detached)';
  }
  return list;
}

export function defaultBaseRef(root) {
  return gitTry(root, ['rev-parse', '--verify', '--quiet', 'origin/main']) ? 'origin/main' : 'main';
}

export function parseStatusZ(text) {
  const entries = [];
  const parts = text.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const item = parts[i];
    if (!item) continue;
    const code = item.slice(0, 2);
    const path = item.slice(3);
    const renamed = /[RC]/.test(code);
    const from = renamed ? parts[++i] : undefined;
    entries.push({code, path, ...(from ? {from} : {})});
  }
  return entries;
}

export function workingChanges(root) {
  return parseStatusZ(git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).stdout);
}

export function committedChanges(root, fromSha, toRef = 'HEAD') {
  const parts = git(root, ['diff', '--name-status', '-z', '-M', fromSha, toRef]).stdout.split('\0').filter(Boolean);
  const list = [];
  for (let i = 0; i < parts.length; i++) {
    const status = parts[i];
    if (/^[RC]/.test(status)) {
      list.push({status: status[0], from: parts[i + 1], path: parts[i + 2]});
      i += 2;
    } else {
      list.push({status: status[0], path: parts[i + 1]});
      i += 1;
    }
  }
  return list;
}

// Union of committed (merge-base..HEAD) and uncommitted changes, one entry per path.
export function collectChanges(root, baseRef = defaultBaseRef(root)) {
  const mergeBase = gitOut(root, ['merge-base', 'HEAD', baseRef]);
  const map = new Map();
  for (const entry of committedChanges(root, mergeBase)) map.set(entry.path, {path: entry.path, committed: entry.status, working: null, from: entry.from});
  for (const entry of workingChanges(root)) {
    const existing = map.get(entry.path) || {path: entry.path, committed: null, working: null};
    existing.working = entry.code;
    if (entry.from) existing.from = entry.from;
    map.set(entry.path, existing);
  }
  const files = [...map.values()].map(file => ({
    ...file,
    deleted: file.working ? file.working.includes('D') : file.committed === 'D',
    added: file.working === '??' || file.working?.includes('A') || (!file.working && file.committed === 'A'),
  })).sort((a, b) => a.path.localeCompare(b.path));
  return {baseRef, mergeBase, files};
}

export const HANDOFF_DIR = 'docs/handoffs/';

// Content fingerprint of the verified state. Handoff documents are excluded so writing and
// committing the handoff itself does not invalidate the verification it reports.
export function commitFingerprint(root, ref = 'HEAD') {
  return createHash('sha256').update(gitOut(root, ['ls-tree', '-r', ref]).split('\n')
    .filter(line => !line.split('\t')[1]?.startsWith(HANDOFF_DIR)).join('\n'));
}

export function stateFingerprint(root) {
  const scope = ['--', '.', `:(exclude)${HANDOFF_DIR}`];
  const hash = commitFingerprint(root);
  hash.update(git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', ...scope]).stdout);
  hash.update(git(root, ['diff', 'HEAD', '--binary', ...scope]).stdout);
  for (const entry of workingChanges(root).filter(e => e.code === '??' && !e.path.startsWith(HANDOFF_DIR))) {
    const full = join(root, entry.path);
    if (existsSync(full) && statSync(full).isFile()) hash.update(readFileSync(full));
  }
  return hash.digest('hex').slice(0, 16);
}

export function classifyDomains(paths) {
  const hits = {};
  for (const path of paths) {
    for (const [key, domain] of Object.entries(DOMAINS)) {
      if (domain.match.test(path)) (hits[key] ||= {label: domain.label, files: []}).files.push(path);
    }
  }
  return hits;
}

export function domainPolicyDocs(root, domainKeys) {
  const docs = [];
  const walk = dir => {
    for (const entry of readdirSync(join(root, dir), {withFileTypes: true})) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (/\.md$/i.test(entry.name)) docs.push(rel);
    }
  };
  if (existsSync(join(root, 'docs'))) walk('docs');
  const result = {};
  for (const key of domainKeys) result[key] = docs.filter(doc => DOMAINS[key].match.test(basename(doc)));
  return result;
}

// Related-test discovery: tests reference sources by repo path strings and migrations by file name.
const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const TEST_FILE = /\.test\.(ts|mjs)$/;

export function allTestFiles(root) {
  return gitOut(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0')
    .filter(path => TEST_FILE.test(path) && !path.startsWith('node_modules/') && existsSync(join(root, path))).sort();
}

function testIndex(root) {
  const read = rel => ({path: rel, text: readFileSync(join(root, rel), 'utf8')});
  const tests = allTestFiles(root).map(read);
  const helperDir = join(root, 'tests', 'helpers');
  const helpers = existsSync(helperDir) ? readdirSync(helperDir).filter(name => /\.(mjs|ts)$/.test(name)).map(name => read(`tests/helpers/${name}`)) : [];
  return {tests, helpers};
}

function tokensFor(path) {
  if (/^supabase\/migrations\/[^/]+\.sql$/.test(path)) return [basename(path)];
  const noExt = path.replace(/\.(tsx?|mjs|cjs|jsx?|css)$/, '');
  return noExt === path ? [path] : [path, noExt];
}

const mentions = (text, token) => new RegExp(`${escapeRegExp(token)}(?![\\w-])`).test(text);

export function relatedTests(root, paths) {
  const {tests, helpers} = testIndex(root);
  const selected = new Map();
  const add = (test, reason) => {
    if (!selected.has(test)) selected.set(test, new Set());
    selected.get(test).add(reason);
  };
  const untested = [];
  for (const path of paths) {
    let found = false;
    if (TEST_FILE.test(path) && existsSync(join(root, path))) {
      add(path, 'self');
      found = true;
    }
    const tokens = tokensFor(path);
    const sibling = `./${basename(path).replace(/\.(tsx?|mjs|cjs|jsx?)$/, '')}`;
    const helperHits = helpers.filter(h => h.path === path || tokens.some(token => mentions(h.text, token)));
    for (const test of tests) {
      if (test.path === path) continue;
      const near = dirname(test.path) === dirname(path) && mentions(test.text, sibling);
      if (near || tokens.some(token => mentions(test.text, token))) {
        add(test.path, `references ${path}`);
        found = true;
      }
      for (const helper of helperHits) {
        if (mentions(test.text, `helpers/${basename(helper.path)}`)) {
          add(test.path, `via ${helper.path} -> ${path}`);
          found = true;
        }
      }
    }
    if (!found && /\.(tsx?|mjs|cjs|jsx?|sql|css)$/.test(path) && !path.startsWith('docs/')) untested.push(path);
  }
  return {
    tests: [...selected.entries()].map(([path, reasons]) => ({path, reasons: [...reasons]})).sort((a, b) => a.path.localeCompare(b.path)),
    untested,
  };
}

export function domainTestSuggestions(root, paths) {
  const prefixes = new Set();
  for (const path of paths) {
    const parts = path.replace(/\.[^.]+$/, '').split('/').filter(part => !/^\(.*\)$/.test(part) && !['app', 'lib', 'api', 'admin', 'components', 'tests'].includes(part));
    if (parts[0]) prefixes.add(parts[0].toLowerCase());
  }
  const dir = join(root, 'tests');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(name => /\.test\.(ts|mjs)$/.test(name) && [...prefixes].some(prefix => name.startsWith(`${prefix}-`))).map(name => `tests/${name}`);
}

// Static extraction of API routes, tables and RPCs touched by a set of files.
export function apiRouteOf(path) {
  const m = path.match(/^app\/(.*)\/route\.(ts|js)$/);
  if (!m || !m[1].startsWith('api')) return null;
  return '/' + m[1].split('/').filter(part => !/^\(.*\)$/.test(part)).join('/');
}

export function dbObjectsIn(text) {
  const tables = new Set();
  const rpcs = new Set();
  const writes = new Set();
  for (const m of text.matchAll(/\.from\(\s*['"`]([a-z0-9_]+)['"`]\s*\)((?:\s*\.\s*\w+\([^)]*\))*)/gi)) {
    tables.add(m[1]);
    const write = m[2].match(/\.\s*(insert|update|upsert|delete)\s*\(/i);
    if (write) writes.add(`${m[1]}.${write[1].toLowerCase()}`);
  }
  for (const m of text.matchAll(/\.rpc\(\s*['"`]([a-z0-9_]+)['"`]/gi)) rpcs.add(m[1]);
  for (const m of text.matchAll(/create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?([a-z0-9_]+)/gi)) rpcs.add(m[1]);
  for (const m of text.matchAll(/(?:create|alter|drop)\s+table\s+(?:if\s+(?:not\s+)?exists\s+)?(?:public\.)?([a-z0-9_]+)/gi)) {
    tables.add(m[1]);
    writes.add(`${m[1]}.ddl`);
  }
  for (const m of text.matchAll(/(?:insert\s+into|update|delete\s+from)\s+(?:public\.)?([a-z0-9_]+)/gi)) {
    if (!['set', 'on', 'of'].includes(m[1].toLowerCase())) writes.add(`${m[1]}.sql-write`);
  }
  return {tables: [...tables].sort(), rpcs: [...rpcs].sort(), writes: [...writes].sort()};
}

export function listSourceFiles(root) {
  return gitOut(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0')
    .filter(path => path && /\.(tsx?|mjs|cjs|jsx?)$/.test(path) && !path.startsWith('node_modules/'));
}

// One-level reverse import lookup ("who imports this file"), static and approximate.
export function importersOf(root, path, sourceFiles = listSourceFiles(root)) {
  const noExt = path.replace(/\.(tsx?|mjs|cjs|jsx?)$/, '');
  if (noExt === path) return [];
  const alias = new RegExp(`['"]@/${escapeRegExp(noExt)}(?:\\.(?:tsx?|mjs|js))?['"]`);
  const importers = [];
  for (const file of sourceFiles) {
    if (file === path || !existsSync(join(root, file))) continue;
    const text = readFileSync(join(root, file), 'utf8');
    if (alias.test(text)) {
      importers.push(file);
      continue;
    }
    for (const m of text.matchAll(/(?:from|import\()\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const target = toPosix(relative(root, resolve(root, dirname(file), m[1]))).replace(/\.(tsx?|mjs|cjs|jsx?)$/, '');
      if (target === noExt) {
        importers.push(file);
        break;
      }
    }
  }
  return importers;
}

export function migrationVersion(path) {
  return path.match(/^supabase\/migrations\/(\d+)_/)?.[1] || null;
}

export function sanitizedEnv(extra = {}) {
  const env = {};
  const removed = [];
  for (const [name, value] of Object.entries(process.env)) {
    if (CREDENTIAL_ENV.test(name)) removed.push(name);
    // A nested verifier must emit its own TAP, not inherit the parent's test IPC channel.
    else if (/^NODE_TEST_/.test(name)) continue;
    else env[name] = value;
  }
  return {env: {...env, NEXT_TELEMETRY_DISABLED: '1', ...extra}, removed};
}

export function parseArgs(argv, spec) {
  const out = {_: []};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const [rawKey, inline] = arg.slice(2).split(/=(.*)/s);
    const key = rawKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (!(key in spec)) throw new Error(`Unknown option --${rawKey}`);
    if (spec[key] === 'boolean') out[key] = true;
    else out[key] = inline ?? argv[++i];
  }
  return out;
}

export const splitList = value => (value ? String(value).split(',').map(item => item.trim()).filter(Boolean) : []);

export function expandPlanned(root, items) {
  const all = gitOut(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean);
  const out = new Set();
  for (const item of items.map(toPosix)) {
    if (/[*?]/.test(item)) for (const file of all.filter(file => globToRegExp(item).test(file))) out.add(file);
    else out.add(item.replace(/^\.\//, ''));
  }
  return [...out].sort();
}
