// Browser suites run only against an offline build on loopback (e.g. the Claude worktree
// on 3002 started with the baba-verify build fixture). Port 3000 is the user's original dev
// server, which loads the real project settings, so it is refused instead of silently used.
export function offlineUiBase(value = process.env.QA_UI_BASE_URL) {
  if (!value) return '';
  const url = new URL(value);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('QA_UI_BASE_URL must be a loopback offline build');
  if ((url.port || (url.protocol === 'https:' ? '443' : '80')) === '3000') throw new Error('QA_UI_BASE_URL must not be the original dev server on port 3000');
  return url.origin;
}
