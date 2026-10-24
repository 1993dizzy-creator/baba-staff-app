// Preloaded (NODE_OPTIONS=--import) by baba-verify into every test/build process.
// Best-effort guard for Node sockets/fetch, not OS isolation: native children, DNS/UDP,
// replaced APIs and local proxies remain outside this guard. Never supply production secrets.
import net from 'node:net';

const LOOPBACK = /^(localhost|.*\.localhost|127(?:\.\d{1,3}){3}|::1|\[::1\]|0\.0\.0\.0|::ffff:127(?:\.\d{1,3}){3})$/i;
const allowed = host => host === undefined || host === null || host === '' || LOOPBACK.test(String(host));

function targetOf(args) {
  let first = args[0];
  if (Array.isArray(first)) first = first[0];
  if (first && typeof first === 'object') return {host: first.path ? undefined : (first.host ?? 'localhost'), ipc: Boolean(first.path)};
  if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
    return {host: typeof args[1] === 'string' ? args[1] : 'localhost', ipc: false};
  }
  if (typeof first === 'string') return {host: undefined, ipc: true};
  return {host: undefined, ipc: false};
}

const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  const {host, ipc} = targetOf(args);
  if (!ipc && !allowed(host)) {
    const error = new Error(`BABA_OFFLINE_GUARD: blocked outbound connection to ${host}`);
    error.code = 'BABA_OFFLINE_BLOCKED';
    process.nextTick(() => this.destroy(error));
    return this;
  }
  return originalConnect.apply(this, args);
};

const originalFetch = globalThis.fetch;
if (typeof originalFetch === 'function') {
  globalThis.fetch = function guardedFetch(input, init) {
    let host;
    try {
      host = new URL(typeof input === 'string' || input instanceof URL ? input : input.url).hostname;
    } catch {
      host = undefined;
    }
    if (host !== undefined && !allowed(host)) {
      const error = new TypeError(`BABA_OFFLINE_GUARD: blocked fetch to ${host}`);
      error.code = 'BABA_OFFLINE_BLOCKED';
      return Promise.reject(error);
    }
    return originalFetch.call(this, input, init);
  };
}
