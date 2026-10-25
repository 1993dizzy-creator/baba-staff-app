// Preloaded (NODE_OPTIONS=--import) by baba-verify only when a changed file has no test that names
// its path. Records whether a test process actually loaded (import) or read the listed files.
// This is execution evidence for those files, not proof of assertion quality, and not a sandbox:
// test code can bypass or forge it like any other in-process instrumentation.
import fs from 'node:fs';
import {registerHooks, syncBuiltinESMExports} from 'node:module';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const log = process.env.BABA_ACCESS_LOG;
let targets = new Map();
try { targets = new Map(JSON.parse(process.env.BABA_ACCESS_TARGETS || '[]').map(path => [resolve(path).toLowerCase(), path])); } catch {}
const seen = new Map();

function note(file, kind) {
  let path;
  try {
    if (file instanceof URL || (typeof file === 'string' && file.startsWith('file:'))) path = fileURLToPath(file);
    else if (typeof file === 'string') path = file;
    else return;
    path = resolve(path).toLowerCase();
  } catch { return; }
  const target = targets.get(path);
  if (!target) return;
  if (!seen.has(target)) seen.set(target, new Set());
  seen.get(target).add(kind);
}

if (log && targets.size) {
  registerHooks({load(url, context, nextLoad) { note(url, 'import'); return nextLoad(url, context); }});
  for (const name of ['readFileSync', 'readFile', 'createReadStream', 'openSync', 'open']) {
    const original = fs[name];
    fs[name] = function recordedRead(file, ...rest) { note(file, 'read'); return original.call(this, file, ...rest); };
  }
  const readFile = fs.promises.readFile;
  fs.promises.readFile = function recordedRead(file, ...rest) { note(file, 'read'); return readFile.call(this, file, ...rest); };
  syncBuiltinESMExports(); // ESM named imports of node:fs must see the recorded functions too.
  process.on('exit', () => {
    if (!seen.size) return;
    const entries = [...seen].map(([path, kinds]) => ({path, kinds: [...kinds].sort()}));
    fs.appendFileSync(log, JSON.stringify({pid: process.pid, entries}) + '\n');
  });
}
