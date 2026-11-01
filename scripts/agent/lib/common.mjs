// Shared Git inspection, path and test-environment helpers.
import {spawnSync} from 'node:child_process';
import {lstatSync, realpathSync} from 'node:fs';
import {basename, dirname, relative, resolve, sep} from 'node:path';

export const AGENTS = {codex: {worktreeDir: 'baba-wt-codex'}, claude: {worktreeDir: 'baba-wt-claude'}};

export const CREDENTIAL_ENV = /SUPABASE|CUKCUK|^POS_|^CRON_|^BABA_SESSION|^DATABASE_URL$|^DIRECT_URL$|^PG(PASSWORD|HOST|USER|DATABASE|SERVICE)$|^VERCEL_TOKEN$|^GITHUB_TOKEN$|^GH_TOKEN$/i;

export function run(command, args, {cwd, env, allowFail = false, input, timeout} = {}) {
  const result = spawnSync(command, args, {cwd, env, input, timeout, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, windowsHide: true});
  if (result.error && !allowFail) throw result.error;
  if (result.status !== 0 && !allowFail) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status}): ${(result.stderr || '').trim()}`);
  }
  return {status: result.status, stdout: result.stdout || '', stderr: result.stderr || '', error: result.error};
}

export const NEUTRALIZED_GIT_ENV = ['GIT_EDITOR', 'GIT_SEQUENCE_EDITOR', 'GIT_ASKPASS', 'SSH_ASKPASS'];
// core.fsmonitor runs a configured program even for read-only status/diff; disable it per call.
const HARDENED_GIT = ['--no-pager', '--no-optional-locks', '-c', 'core.quotepath=off', '-c', 'core.fsmonitor=false'];
// Nested prepare/fixture repositories exceed MAX_PATH. Enable Git for Windows' extended-path
// handling per subprocess, without changing repository/shared config or Windows system policy.
if (process.platform === 'win32') HARDENED_GIT.push('-c', 'core.longpaths=true');

export function gitEnvironment(env = process.env) {
  const clean = Object.fromEntries(Object.entries(env).filter(([name]) => !NEUTRALIZED_GIT_ENV.includes(name.toUpperCase())));
  return {...clean, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never'};
}

export function git(root, args, options = {}) {
  return run('git', [...HARDENED_GIT, ...args], {cwd: root, ...options, env: gitEnvironment(options.env || process.env)});
}
export const gitOut = (root, args, options) => git(root, args, options).stdout.trim();
export const gitTry = (root, args) => {
  const r = git(root, args, {allowFail: true});
  return r.status === 0 ? r.stdout.trim() : null;
};

export function repoRoot(cwd = process.cwd()) {
  return resolve(gitOut(cwd, ['rev-parse', '--show-toplevel']));
}

export function identifyWorktree(root, originalPath) {
  const dir = basename(root).toLowerCase();
  const agent = Object.entries(AGENTS).find(([, value]) => value.worktreeDir === dir)?.[0] || null;
  // Git lists its original worktree first, regardless of its name or branch.
  // A supplied registry path also works when inspecting a missing linked worktree.
  const original = originalPath ?? gitTry(root, ['worktree', 'list', '--porcelain'])?.match(/^worktree ([^\r\n]+)/)?.[1];
  return {dir, agent, isOriginal: Boolean(original) && resolve(root).toLowerCase() === resolve(original).toLowerCase()};
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

export function sanitizedEnv(extra = {}) {
  const env = {};
  const removed = [];
  for (const [name, value] of Object.entries(process.env)) {
    if (CREDENTIAL_ENV.test(name)) removed.push(name);
    // Do not inherit parent test IPC or recorder state.
    else if (/^(NODE_TEST_|BABA_ACCESS_)/.test(name)) continue;
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
