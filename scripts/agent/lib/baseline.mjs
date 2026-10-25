// Every verification gets a private snapshot. Never recursively delete a snapshot or dependency tree.
import {lstatSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {guardedGit, insideRoot, writeRecord} from './common.mjs';

export function createBaseline(root, sha, env) {
  const parent = insideRoot(root, '.tmp-baba');
  mkdirSync(parent, {recursive: true});
  const dir = mkdtempSync(join(parent, 'baseline-'));
  const indexEnv = {...env, GIT_INDEX_FILE: join(dir, '.baba-baseline-index')};
  guardedGit(root, ['read-tree', sha], {env: indexEnv, internalIndexFile: indexEnv.GIT_INDEX_FILE});
  guardedGit(root, [`--work-tree=${dir}`, 'checkout-index', '-a', '-f'], {env: indexEnv, internalIndexFile: indexEnv.GIT_INDEX_FILE});
  writeRecord(root, join(dir, '.baba-baseline.json'), {version: 1, root, sha});
  const link = join(dir, 'node_modules');
  const target = realpathSync(join(root, 'node_modules'));
  symlinkSync(target, link, 'junction');
  const identity = lstatSync(link, {bigint: true});
  const release = () => {
    try {
      const current = lstatSync(link, {bigint: true});
      if (!current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino || realpathSync(link) !== target) {
        throw new Error('Baseline link changed; refusing cleanup');
      }
      unlinkSync(link); // unlink the owned junction only; never recurse into its target.
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  };
  return {dir, release};
}
