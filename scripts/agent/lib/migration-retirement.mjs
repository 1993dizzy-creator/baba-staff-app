// Read-only identity check for the one explicitly authorized, unapplied archive.
// This is NOT DB-history verification or permission to retire another migration.
import {createHash} from 'node:crypto';
import {existsSync,lstatSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {git,gitOut,insideRoot} from './common.mjs';

export const retiredMigration={
  source:'supabase/migrations/20261027160650_fix_aug_sep_reclose_lock_order.sql',
  destination:'docs/history/migrations-retired/20261027160650_fix_aug_sep_reclose_lock_order.sql',
  blob:'2a6d8344ffe15562ed351935da98cef1303b15fb',
  sha256:'185d0b8aec5757c7f569d426a9cdee2153e7f7362abc22fde758244adf05ce6e',
};

export function migrationRetirementEvidence(root,base,file) {
  const fail=reason=>({allowed:false,reason});
  if(file.from!==retiredMigration.source || file.path!==retiredMigration.destination ||
    !(file.committed==='R' || file.working?.includes('R')) || file.deleted)return fail('NOT_THE_AUTHORIZED_RENAME');
  if(existsSync(insideRoot(root,retiredMigration.source)))return fail('SOURCE_STILL_ACTIVE');
  const destination=insideRoot(root,file.path),readme=insideRoot(root,join('docs/history/migrations-retired','README.md'));
  if(!existsSync(destination) || !lstatSync(destination).isFile() || lstatSync(destination).isSymbolicLink())return fail('ARCHIVE_NOT_REGULAR_FILE');
  const baseline=git(root,['rev-parse','--verify',`${base}:${file.from}`],{allowFail:true});
  if(baseline.status!==0 || baseline.stdout.trim()!==retiredMigration.blob)return fail('BASELINE_BLOB_MISMATCH');
  const sha256=createHash('sha256').update(readFileSync(destination)).digest('hex');
  const blob=gitOut(root,['hash-object','--no-filters',file.path]);
  if(sha256!==retiredMigration.sha256 || blob!==retiredMigration.blob)return fail('ARCHIVE_BYTES_CHANGED');
  if(!existsSync(readme) || lstatSync(readme).isSymbolicLink())return fail('ARCHIVE_README_MISSING');
  const policy=readFileSync(readme,'utf8');
  if(!policy.includes(retiredMigration.sha256) || !policy.includes('20261027175537') || !policy.includes('미적용'))return fail('ARCHIVE_README_INCOMPLETE');
  return {allowed:true,source:file.from,destination:file.path,blob,sha256,
    scope:'Exact local archive only; user authorization and environment history are reviewed separately'};
}
