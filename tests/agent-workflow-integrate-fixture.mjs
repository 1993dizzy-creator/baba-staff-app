import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {integrate} from '../scripts/agent/baba-integrate.mjs';
import {git, gitOut, insideRoot, run, sanitizedEnv, writeRecord} from '../scripts/agent/lib/common.mjs';

// Shared by the core and policy suites. Keep the real Git/Verify/prepare fixtures while
// bounding each test file below Verify's unchanged 600-second per-file limit.
// Everything, including fixture main merges, is confined to the owning source worktree.
const source = resolve(fileURLToPath(new URL('..', import.meta.url)));
const parent = insideRoot(source, '.tmp-baba/integrate-fixtures'); mkdirSync(parent, {recursive: true});
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const put = (root, path, text) => { const full = insideRoot(root, path); mkdirSync(resolve(full, '..'), {recursive: true}); writeFileSync(full, text); };
const head = root => gitOut(root, ['rev-parse', 'HEAD']);
const commit = (root, path, content) => { put(root, path, content); git(root, ['add', '--', path]); git(root, ['commit', '-m', 'fixture']); return head(root); };
const cli = (root, script, args = []) => run(process.execPath, [join(root, 'scripts/agent', script), ...args],
  {cwd: root, env: sanitizedEnv().env, allowFail: true, timeout: 120000});

function fixture({preexisting = false, explicitGuard = false, dynamicImport = false, deep = false} = {}) {
  const temporary = mkdtempSync(join(parent, '한글 space-'));
  const directory = deep ? join(temporary, 'd'.repeat(Math.max(8, 161 - temporary.length - 15))) : temporary;
  if (deep) mkdirSync(directory);
  const main = join(directory, 'baba-staff-app'), codex = join(directory, 'baba-wt-codex'), claude = join(directory, 'baba-wt-claude');
  mkdirSync(main); git(main, ['init', '-b', 'main']);
  git(main, ['config', 'user.name', 'Fixture']); git(main, ['config', 'user.email', 'fixture@example.invalid']);
  cpSync(join(source, 'scripts/agent'), join(main, 'scripts/agent'), {recursive: true});
  put(main, '.gitignore', '.tmp-baba/\nnode_modules/\n');
  put(main, 'package.json', '{"private":true}\n');
  put(main, 'app/a.ts', 'export const a = 1;\n'); put(main, 'app/b.ts', 'export const b = 1;\n');
  put(main, 'tests/check.test.mjs', `import test from 'node:test'; import assert from 'node:assert/strict'; import {existsSync,readFileSync} from 'node:fs';
    test('fixture assertion', () => assert.equal(readFileSync('app/a.ts','utf8').includes('bad'), false));
    test('fixture secondary source',()=>assert.equal(readFileSync('app/b.ts','utf8').includes('invalid'),false));
    test('policy resources are inspected only as text',()=>{
      for(const file of ['supabase/migrations/20261025000000_fixture.sql','app/api/shared/route.ts','lib/candidate.ts']) {
        if(existsSync(file))assert.ok(readFileSync(file,'utf8').length>0);
      }
    });\n`);
  if (preexisting) put(main, 'app/a.ts', 'bad baseline\n');
  if (explicitGuard) put(main, 'tests/manual-extra.test.mjs', `import test from 'node:test'; import assert from 'node:assert/strict'; import {readFileSync} from 'node:fs';
    test('explicit invariant',()=>assert.equal(readFileSync('app/'+'a.ts','utf8').includes('= 9;') && readFileSync('app/'+'b.ts','utf8').includes('= 2;'),false));\n`);
  // Loads modules by directory listing, so no source path is named and auto-matching finds nothing.
  if (dynamicImport) put(main, 'tests/dynamic-exercise.test.mjs', `import test from 'node:test'; import assert from 'node:assert/strict';
    import {readdirSync} from 'node:fs'; import {join} from 'node:path'; import {pathToFileURL} from 'node:url';
    test('every listed module loads', async () => {
      for (const name of readdirSync('app').filter(name => name.endsWith('.ts')))
        assert.ok(await import(pathToFileURL(join(process.cwd(), 'app', name)).href));
    });\n`);
  git(main, ['add', '.']); git(main, ['commit', '-m', 'isolated seed']);
  const origin = join(directory, 'origin.git');
  git(main, ['init', '--bare', origin]); git(main, ['remote', 'add', 'origin', origin]);
  git(main, ['push', 'origin', 'main']); // disposable LOCAL bare fixture, never GitHub
  const taskId = '20261025-integration-fixture-01', branch = `codex/${taskId}`;
  git(main, ['worktree', 'add', '--no-track', '-b', branch, codex, 'main']);
  git(main, ['worktree', 'add', '--no-track', '-b', 'claude/ready-fixture', claude, 'main']);
  const seed = head(main), task = 'Integration fixture', slug = 'integration-fixture';
  writeRecord(codex, `.tmp-baba/start/tasks/${taskId}.json`, {version: 1, root: codex, agent: 'codex', task, slug,
    taskKey: hash(`${task}\0${slug}`), files: ['app/b.ts'], taskId, branch, baseSha: seed, createdAt: new Date().toISOString()});
  // Tiny deterministic toolchain ONLY in this fixture. The real Verify CLI, TAP assertions,
  // baseline snapshots, Handoff CLI and integration implementation are actually executed.
  put(codex, 'node_modules/next/dist/bin/next', 'process.exit(0);\n');
  put(codex, 'node_modules/eslint/bin/eslint.js', "console.log('[]');\n");
  put(codex, 'node_modules/typescript/lib/tsc.js', "process.exit(0);\n");
  return {directory, main, codex, claude, seed, taskId, branch, origin};
}
function verify(f, extra = []) {
  const result = cli(f.codex, 'baba-verify.mjs', ['--base', 'main', '--tests', 'tests/check.test.mjs', '--build', '--json', ...extra]);
  return {result, report: JSON.parse(result.stdout)};
}
function finish(f, extra = []) {
  const checked = verify(f, extra);
  assert.equal(checked.result.status, 0, checked.result.stderr + JSON.stringify(checked.report));
  const path = `docs/handoffs/${f.branch.replace('/', '-')}.md`;
  assert.equal(cli(f.codex, 'baba-handoff.mjs', ['--task-name', 'Integration fixture', '--base', 'main']).status, 0);
  const text = readFileSync(join(f.codex, path), 'utf8').replace(/<!-- TODO[\s\S]*?-->/g, 'isolated fixture executed');
  put(f.codex, path, text);
  assert.equal(cli(f.codex, 'baba-handoff.mjs', ['--check', path]).status, 0);
  git(f.codex, ['add', '--', path]); git(f.codex, ['commit', '-m', 'fixture handoff']);
  return {path, verify: checked.report};
}
function ready(options) { const f = fixture(options); commit(f.codex, 'app/b.ts', 'export const b = 2;\n'); finish(f); return f; }
const inspect = f => integrate({branch: f.branch}, f.codex);
const prepare = f => integrate({_: ['prepare'], branch: f.branch}, f.codex);
function approval(f, prepared) {
  const path = `.tmp-baba/user-approval-${prepared.id}.json`;
  writeRecord(f.codex, path, {version: 1, action: 'merge-local-main', approvedBy: 'user', approvedAt: new Date().toISOString(),
    ...prepared.approvalRequired, preparedDigest: hash(prepared)});
  return path;
}

const shaBranch = (root, branch) => gitOut(root, ['rev-parse', branch]);

export {source, parent, hash, put, head, commit, cli, fixture, verify, finish, ready, inspect, prepare, approval, shaBranch};
