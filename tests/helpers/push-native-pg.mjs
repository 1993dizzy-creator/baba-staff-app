// Throwaway local PostgreSQL cluster for the 01-B push tests (same pinned local-only binaries as the
// 01-A concurrency test; no env DB URL is read; the data dir lives under .local/ and is removed).
// Server log lines are kept in `logs` (auto_explain output lands there).
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, existsSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import pg from 'pg';
import { baseSql, testTypesSql, MIGRATION_FILE, PUSH_MIGRATION_FILE } from './notification-fixture.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function startPushCluster(name) {
  const platform = process.platform === 'win32' ? 'windows' : process.platform;
  const bin = path.resolve(process.env.BABA_RESERVATION_PG_BIN || `.local/pg-tools/node_modules/@embedded-postgres/${platform}-${process.arch}/native/bin`);
  const exe = file => path.join(bin, file + (process.platform === 'win32' ? '.exe' : ''));
  if (!existsSync(exe('initdb'))) throw new Error('Install the pinned local-only test binaries (see tests/notifications-concurrency.test.mjs)');
  const root = path.resolve('.local/notification-01b'); mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(path.join(root, `${name}-`)); const logs = [];
  const env = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
  Object.assign(env, { TEMP: dir, TMP: dir, HOME: dir, USERPROFILE: dir });
  logs.push(execFileSync(exe('initdb'), ['-D', dir, '--auth=trust', '--username=baba_test', '--locale=C', '--encoding=UTF8'], { env, windowsHide: true, encoding: 'utf8' }));
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const child = spawn(exe('postgres'), ['-D', dir, '-h', '127.0.0.1', '-p', String(port)], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', b => logs.push(b.toString())); child.stderr.on('data', b => logs.push(b.toString()));
  const config = { host: '127.0.0.1', port, user: 'baba_test', database: 'postgres', connectionTimeoutMillis: 500, statement_timeout: 60000 };
  const clients = []; let admin;
  for (let i = 0; i < 100 && !admin; i++) {
    const candidate = new pg.Client(config);
    try { await candidate.connect(); admin = candidate; } catch { await candidate.end().catch(() => {}); await delay(30); }
  }
  if (!admin) throw new Error(logs.join('\n'));
  clients.push(admin);
  await admin.query(baseSql); await admin.query(readFileSync(MIGRATION_FILE, 'utf8')); await admin.query(testTypesSql);
  await admin.query(readFileSync(PUSH_MIGRATION_FILE, 'utf8'));
  const connect = async (role = 'service_role') => {
    const c = new pg.Client(config); await c.connect(); clients.push(c);
    if (role) await c.query(`set role ${role}`);
    return c;
  };
  const stop = async () => {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    if (child.exitCode === null) execFileSync(exe('pg_ctl'), ['-D', dir, 'stop', '-m', 'fast', '-w'], { env, windowsHide: true, encoding: 'utf8', timeout: 15000 });
    writeFileSync(path.join(root, `${path.basename(dir)}-server.log`), logs.join('\n'));
    rmSync(dir, { recursive: true, force: true });
  };
  return { admin, connect, stop, logs };
}

export const rpc = async (client, name, args) => (await client.query(
  `select public.${name}(${args.map((_, i) => '$' + (i + 1)).join(',')}) r`, args)).rows[0].r;
