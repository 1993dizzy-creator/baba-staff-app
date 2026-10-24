import test from 'node:test';
import assert from 'node:assert/strict';
import {cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createClient} from '@supabase/supabase-js';
import {createBuildEnvironment} from '../scripts/agent/lib/build-env.mjs';
import {CREDENTIAL_ENV, git, run, sanitizedEnv} from '../scripts/agent/lib/common.mjs';

const source = resolve(fileURLToPath(new URL('..', import.meta.url)));
const decode = token => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
function poisonParent(check) {
  const overrides = {NEXT_PUBLIC_SUPABASE_URL: 'https://parent.invalid', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'parent-only',
    SUPABASE_SERVICE_ROLE_KEY: 'parent-only', CUKCUK_SECRET_KEY: 'parent-only', DATABASE_URL: 'parent-only',
    BABA_SESSION_SECRET: 'parent-only', GH_TOKEN: 'parent-only'};
  const before = Object.fromEntries(Object.keys(overrides).map(name => [name, process.env[name]]));
  try { Object.assign(process.env, overrides); check(overrides); }
  finally {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
}

test('Build fixture replaces inherited credentials with fixed loopback and only generated anon keys', () => poisonParent(parent => {
  const {env, description} = createBuildEnvironment();
  assert.equal(env.NEXT_PUBLIC_SUPABASE_URL, 'http://127.0.0.1:9');
  assert.match(env.NEXT_PUBLIC_SUPABASE_ANON_KEY, /^[\w-]+\.[\w-]+\.[\w-]{43}$/);
  assert.equal(env.SUPABASE_SERVICE_ROLE_KEY, env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  const claims = decode(env.SUPABASE_SERVICE_ROLE_KEY);
  assert.equal(claims.role, 'anon'); assert.equal(claims.iss, 'baba-offline-build-fixture');
  assert.ok(claims.exp > Date.now() / 1000);
  assert.deepEqual(Object.keys(env).filter(name => CREDENTIAL_ENV.test(name)).sort(), description.injectedVariables.toSorted());
  assert.equal(description.productionEnvironmentValidated, false); assert.equal(description.deployableArtifact, false);
  assert.equal(description.mode, 'offline-local-fixture');
  for (const [name, value] of Object.entries(parent)) assert.equal(process.env[name], value);
  assert.notEqual(createBuildEnvironment().env.NEXT_PUBLIC_SUPABASE_ANON_KEY, env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}));

test('fixture does not change regular sanitized test/lint/TypeScript or parent environment', () => poisonParent(() => {
  const before = sanitizedEnv(); createBuildEnvironment(); const after = sanitizedEnv();
  assert.deepEqual(after, before);
  assert.equal(Object.keys(after.env).some(name => CREDENTIAL_ENV.test(name)), false);
  const child = run(process.execPath, ['-e', 'console.log(Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_SERVICE_ROLE_KEY))'], {env: after.env});
  assert.equal(child.stdout.trim(), 'false');
}));

test('generated public fixture token initializes installed Supabase client without a server', () => {
  const {env} = createBuildEnvironment();
  const client = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {auth: {persistSession: false, autoRefreshToken: false}});
  assert.equal(client.supabaseUrl, 'http://127.0.0.1:9');
});

test('Build child retains offline guard and rejects external fetch and sockets', () => {
  const guard = `--import=${pathToFileURL(join(source, 'scripts/agent/lib/offline-guard.mjs')).href}`;
  const before = process.env.NODE_OPTIONS;
  let env;
  try {
    // An occurrence inside another option is NOT an actual preload.
    process.env.NODE_OPTIONS = `--conditions=${guard}`;
    ({env} = createBuildEnvironment());
  } finally { if (before === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = before; }
  assert.ok(env.NODE_OPTIONS.startsWith(`${guard} `));
  const code = `import net from 'node:net';
    const codes=[]; try { await fetch('https://outside.invalid'); } catch(e) { codes.push(e.code); }
    await new Promise(done => { const s=net.connect(443,'outside.invalid'); s.on('error',e=>{codes.push(e.code);done();}); });
    console.log(JSON.stringify(codes));`;
  const child = run(process.execPath, ['--input-type=module', '-e', code], {env, allowFail: true, timeout: 10000});
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), ['BABA_OFFLINE_BLOCKED', 'BABA_OFFLINE_BLOCKED']);
});

function verifierFixture() {
  const parent = join(source, '.tmp-baba/build-env-fixtures'); mkdirSync(parent, {recursive: true});
  const container = mkdtempSync(join(parent, 'run-')), root = join(container, 'baba-wt-codex'); mkdirSync(root);
  cpSync(join(source, 'scripts/agent'), join(root, 'scripts/agent'), {recursive: true});
  mkdirSync(join(root, 'tests')); mkdirSync(join(root, 'node_modules/next/dist/bin'), {recursive: true});
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n.tmp-baba/\n');
  writeFileSync(join(root, 'package.json'), '{"private":true}\n');
  writeFileSync(join(root, 'tests/probe.test.mjs'), `import test from 'node:test'; import assert from 'node:assert/strict';
    test('regular test has no Build credentials',()=>{
      assert.equal(process.env.NEXT_PUBLIC_SUPABASE_URL,undefined);assert.equal(process.env.SUPABASE_SERVICE_ROLE_KEY,undefined);
    });`);
  // Instrumented Next fixture tests environment wiring only; the real Next build is separate.
  writeFileSync(join(root, 'node_modules/next/dist/bin/next'), `const assert=require('node:assert/strict');
    const fs=require('node:fs');
    assert.equal(process.argv[2],'build'); assert.equal(process.env.NEXT_PUBLIC_SUPABASE_URL,'http://127.0.0.1:9');
    assert.match(process.env.NODE_OPTIONS,/offline-guard/); assert.equal(process.env.CUKCUK_SECRET_KEY,undefined);
    assert.equal(process.env.DATABASE_URL,undefined);
    const key=process.env.SUPABASE_SERVICE_ROLE_KEY;
    const role=JSON.parse(Buffer.from(key.split('.')[1],'base64url')).role;assert.equal(role,'anon');
    fs.mkdirSync('.tmp-baba',{recursive:true});
    fs.writeFileSync('.tmp-baba/build-observed.json',JSON.stringify({url:process.env.NEXT_PUBLIC_SUPABASE_URL,role}));
    if(fs.existsSync('.tmp-baba/fail-build')) {console.error('Error: Missing EXTRA_BUILD_ENV environment variable');process.exit(1);}
    console.log('instrumented fixture build executed');`);
  git(root, ['init', '-b', 'codex/fixture']); git(root, ['config', 'user.name', 'Fixture']); git(root, ['config', 'user.email', 'fixture@example.invalid']);
  git(root, ['add', '.']); git(root, ['commit', '-m', 'local fixture']); git(root, ['branch', 'main']);
  return root;
}
function verifyFixture(root) {
  // Launch a real CLI boundary, not a nested node:test child IPC context.
  const env = {...process.env}; delete env.NODE_TEST_CONTEXT;
  const r = run(process.execPath, [join(root, 'scripts/agent/baba-verify.mjs'), '--base', 'main', '--build', '--tests', 'tests/probe.test.mjs', '--skip-lint', '--skip-tsc', '--json'],
    {cwd: root, env, allowFail: true, timeout: 30000});
  return {status: r.status, report: JSON.parse(r.stdout)};
}
test('Verify CLI limits fixture values to Build and reports their use without serializing keys', () => poisonParent(() => {
  const root = verifierFixture(), {status, report} = verifyFixture(root);
  assert.equal(status, 0); assert.equal(report.verdict, 'PASS');
  const build = report.checks.find(check => check.name === 'Production Build (next build)');
  assert.equal(build.ran, true); assert.equal(build.status, 'passed');
  assert.equal(build.environment.mode, 'offline-local-fixture'); assert.equal(build.environment.tokenRole, 'anon');
  assert.equal(build.environment.productionEnvironmentValidated, false);
  assert.deepEqual(JSON.parse(readFileSync(join(root, '.tmp-baba/build-observed.json'), 'utf8')), {url: 'http://127.0.0.1:9', role: 'anon'});
  assert.ok(report.gaps.some(gap => gap.includes('배포하지 않는다')));
  assert.doesNotMatch(JSON.stringify(report), /parent-only|eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/);
}));
test('additional Build dependencies still fail; fixture metadata cannot convert blocked-env to PASS', () => {
  const root = verifierFixture(); mkdirSync(join(root, '.tmp-baba')); writeFileSync(join(root, '.tmp-baba/fail-build'), 'fail');
  const {status, report} = verifyFixture(root), build = report.checks.find(c => c.name === 'Production Build (next build)');
  assert.equal(status, 1); assert.equal(report.verdict, 'FAIL'); assert.equal(build.status, 'blocked-env');
  assert.equal(build.exitCode, 1); assert.equal(build.environment.mode, 'offline-local-fixture');
});
test('Verify preserves split UTF-8 child output instead of inventing different failure text', () => {
  const root = verifierFixture();
  writeFileSync(join(root, 'node_modules/next/dist/bin/next'), `
    const out=Buffer.from('한글'), err=Buffer.from('안전');
    process.stdout.write(out.subarray(0,1)); process.stderr.write(err.subarray(0,1));
    setTimeout(()=>{process.stdout.write(out.subarray(1));process.stderr.write(err.subarray(1));},100);`);
  const {status, report} = verifyFixture(root), build = report.checks.find(c => c.name === 'Production Build (next build)');
  assert.equal(status, 0); assert.equal(build.status, 'passed');
  assert.doesNotMatch(build.tail, /\uFFFD/);
  assert.ok(build.tail.includes('한글')); assert.ok(build.tail.includes('안전'));
});
