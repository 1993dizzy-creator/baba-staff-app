// Read the server, never infer freshness from refs/remotes/origin/main.
import {assertNoGitHooks, git, gitOut} from './common.mjs';

const fail = (code, state) => { throw Object.assign(new Error(code), {code, remote: state}); };
export function remoteMainState(root) {
  assertNoGitHooks(root);
  const local = gitOut(root, ['rev-parse', '--verify', 'refs/heads/main^{commit}']);
  const state = {local, remote: null, relation: 'unknown', localAheadApproval: 'not-applicable'};
  const queried = git(root, ['ls-remote', '--exit-code', 'origin', 'refs/heads/main'], {allowFail: true, timeout: 60000});
  if (queried.status !== 0) fail('REMOTE_MAIN_UNAVAILABLE', state);
  state.remote = queried.stdout.match(/^([0-9a-f]{40})\s+refs\/heads\/main\s*$/)?.[1];
  if (!state.remote) fail('REMOTE_MAIN_UNVERIFIED', state);
  if (state.remote === local) { state.relation = 'equal'; return state; }
  if (git(root, ['cat-file', '-e', `${state.remote}^{commit}`], {allowFail: true}).status !== 0) fail('REMOTE_RELATION_UNVERIFIED', state);
  const remoteAncestor = git(root, ['merge-base', '--is-ancestor', state.remote, local], {allowFail: true}).status;
  const localAncestor = git(root, ['merge-base', '--is-ancestor', local, state.remote], {allowFail: true}).status;
  if (![0, 1].includes(remoteAncestor) || ![0, 1].includes(localAncestor)) fail('REMOTE_RELATION_UNVERIFIED', state);
  if (remoteAncestor === 0) {
    state.relation = 'local-ahead';
    // R1: a receipt writable by this Full Access agent cannot authenticate a user.
    // No independent authority is configured. Do not accept self-asserted approvals.
    state.localAheadApproval = 'independent-authentication-required';
    fail('LOCAL_AHEAD_APPROVAL_UNVERIFIABLE', state);
  }
  state.relation = localAncestor === 0 ? 'remote-ahead' : 'diverged';
  fail(localAncestor === 0 ? 'REMOTE_MAIN_AHEAD' : 'DIVERGED_MAIN', state);
}
