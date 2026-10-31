// Serial releases use a private repository, never the original .env or .next.
import {createHash} from 'node:crypto';
import {existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, unlinkSync} from 'node:fs';
import {join, relative} from 'node:path';
import {PRODUCTION_SENSITIVE, commitFingerprint, committedChanges, dbObjectsIn, git, gitOut, guardedGit, insideRoot, matchesAny, relatedTests, run, sanitizedEnv, stateFingerprint, worktreeEnvironment} from './common.mjs';
import {verifyEvidence} from './verify-evidence.mjs';

export const digest = value => createHash('sha256').update(value).digest('hex');
export const reject = (code, message = code) => {throw Object.assign(new Error(message), {code});};

export function outgoingCommits(root, base, head) {
  return gitOut(root, ['rev-list', '--reverse', `${base}..${head}`]).split('\n').filter(Boolean).map(sha => ({
    sha, message: gitOut(root, ['show', '-s', '--format=%s', sha]),
    // Include intermediate changes and merge parents, even if later reverted.
    paths: [...new Set(gitOut(root, ['diff-tree', '--root', '-m', '--no-commit-id', '--name-only', '-r', sha]).split('\n').filter(Boolean))],
  }));
}

export function sensitiveChanges(root, commits) {
  return commits.flatMap(commit => commit.paths.flatMap(path => {
    const content = /^(app|lib)\/.*\.[cm]?[jt]sx?$/.test(path)
      ? [commit.sha,`${commit.sha}^`].map(ref=>git(root, ['show', `${ref}:${path}`], {allowFail:true}).stdout).join('\n') : '';
    if (!(matchesAny(path,PRODUCTION_SENSITIVE.map(rule=>rule.pattern)) || /\.rpc\s*\(/.test(content) || dbObjectsIn(content).writes.length)) return [];
    return [{commit:commit.sha, path, blob:git(root, ['rev-parse', `${commit.sha}:${path}`], {allowFail:true}).stdout.trim() || 'deleted'}];
  }));
}

// This consumes evidence from the SQL Editor -> connected read-only verifier SOP.
// It does not create approvals, run SQL, or claim workspace files are independent authentication.
export function checkOperations(root, changes, head, receiptPath, now = Date.now()) {
  if (!changes.length) return {required:false};
  if (!receiptPath) reject('OPERATIONS_POSTFLIGHT_REQUIRED');
  const raw = readFileSync(insideRoot(root, receiptPath));
  const evidence = JSON.parse(raw);
  const recent = value => Number.isFinite(Date.parse(value)) && now - Date.parse(value) >= 0 && now - Date.parse(value) <= 15 * 60_000;
  if (evidence.version !== 1 || evidence.source !== 'connected-read-only-postflight' || evidence.head !== head ||
      evidence.projectId !== 'yfjqwsdqhvnfqxywsqcz' || evidence.reviewedChangesDigest !== digest(JSON.stringify(changes)) ||
      !recent(evidence.observedAt) || !Array.isArray(evidence.records)) reject('OPERATIONS_EVIDENCE_INVALID');
  // Review intermediate versions, but never require replaying superseded SQL.
  for (const change of new Map(changes.map(change=>[change.path,change])).values()) {
    const record = evidence.records.find(r => r.commit === change.commit && r.path === change.path && r.blob === change.blob);
    if (!record || record.applied !== true || !recent(record.observedAt)) reject('OPERATIONS_NOT_VERIFIED');
    const query = readFileSync(insideRoot(root, record.queryFile));
    const resultRaw = readFileSync(insideRoot(root, record.resultFile));
    if (!query.length || digest(query) !== record.querySha256 || digest(resultRaw) !== record.resultSha256) reject('OPERATIONS_ARTIFACT_MISMATCH');
    const result = JSON.parse(resultRaw);
    if (result.projectId !== evidence.projectId || result.observedAt !== record.observedAt || result.querySha256 !== record.querySha256 ||
        !result.checks || !['appliedSqlMatches','migrationHistory','functionDefinitions','permissions','rowCounts','auditLogs','securityAdvisor','performanceAdvisor']
          .every(key => result.checks[key] === true)) reject('OPERATIONS_POSTFLIGHT_FAILED');
  }
  return {required:true, receipt:receiptPath, digest:digest(raw), observedAt:evidence.observedAt};
}

export function verifySerial(root, base, head, tests = []) {
  if(gitOut(root,['ls-tree','-r','--name-only',head]).split('\n').some(p=>/(^|\/)\.env(?:\.|$)/.test(p)))reject('TRACKED_ENVIRONMENT_FILE');
  const parent = insideRoot(root, '.tmp-baba/after-commit/checks');mkdirSync(parent,{recursive:true});
  const sandbox = join(mkdtempSync(join(parent,'v-')), 'baba-wt-codex');mkdirSync(sandbox);
  const env = worktreeEnvironment(root, sanitizedEnv().env, sandbox);
  // Source .env files are never copied; only committed objects enter this repository.
  git(sandbox,['init','-b','codex/bootstrap'],{env});
  const hooks=join(sandbox,'.tmp-baba/empty-hooks');mkdirSync(hooks,{recursive:true});
  git(sandbox,['config','core.hooksPath',hooks],{env});
  for(const [ref,sha] of [['main',base],['codex/serial-verification',head]]) {
    guardedGit(sandbox,['-c','protocol.file.allow=always','fetch','--no-tags','--no-recurse-submodules',root,`${sha}:refs/heads/${ref}`],{env});
  }
  guardedGit(sandbox,['switch','codex/serial-verification'],{env});
  const target=realpathSync(join(root,'node_modules')),link=join(sandbox,'node_modules');
  symlinkSync(target,link,'junction');const identity=lstatSync(link,{bigint:true});
  try {
    const changed=committedChanges(root,base,head).map(f=>f.path);
    const selected=relatedTests(sandbox,changed);
    const paths=[...new Set([...selected.tests.map(t=>t.path),...tests])].sort();
    if(!paths.length)reject('SERIAL_TESTS_REQUIRED');
    const checked=run(process.execPath,[join(root,'scripts/agent/baba-verify.mjs'),'--base','main','--build','--json','--tests',paths.join(',')],
      {cwd:sandbox,env,allowFail:true,timeout:60*60_000});
    let report;try{report=JSON.parse(checked.stdout);}catch{reject('SERIAL_VERIFY_UNREADABLE');}
    const problems=verifyEvidence(sandbox,report,{head,fingerprint:stateFingerprint(sandbox),build:true});
    if(report.baseSha!==base || commitFingerprint(sandbox).digest('hex')!==commitFingerprint(root,head).digest('hex')) problems.push('SERIAL_SCOPE_MISMATCH');
    if(checked.status!==0 || problems.length)reject('SERIAL_VERIFY_FAILED',problems.join('; '));
    return {root:sandbox,archive:relative(root,join(sandbox,report.savedAs)).split('\\').join('/'),
      digest:digest(JSON.stringify(report)),head,base,verdict:report.verdict};
  } finally {
    const current=lstatSync(link,{bigint:true});
    if(!current.isSymbolicLink()||current.dev!==identity.dev||current.ino!==identity.ino||realpathSync(link)!==target)reject('SERIAL_DEPENDENCY_LINK_CHANGED');
    unlinkSync(link); // Only this run's junction. Keep all verification artifacts.
  }
}

export function validateSerial(root, verification, base, head) {
  if(!verification || verification.head!==head || verification.base!==base)reject('SERIAL_VERIFY_STATE_MISMATCH');
  const report=JSON.parse(readFileSync(insideRoot(root,verification.archive),'utf8'));
  const sandbox=insideRoot(root,verification.root);
  if(digest(JSON.stringify(report))!==verification.digest || report.baseSha!==base ||
    commitFingerprint(sandbox).digest('hex')!==commitFingerprint(root,head).digest('hex') ||
    verifyEvidence(sandbox,report,{head,fingerprint:stateFingerprint(sandbox),build:true}).length)reject('SERIAL_VERIFY_EVIDENCE_CHANGED');
}

export function vercelObserver(root, {project,scope,vercelCli} = {}) {
  if(!project || !scope || !/^[\w-]+$/.test(project) || !/^[\w-]+$/.test(scope))reject('VERCEL_TARGET_REQUIRED');
  const cli=vercelCli || join(process.env.APPDATA || '', 'npm/node_modules/vercel/dist/vc.js');
  if(!existsSync(cli))reject('VERCEL_CLI_UNAVAILABLE');
  const api=endpoint=>{
    // Fixed GET only; no linking, env pull, deploy, promote or secret logging.
    const response=run(process.execPath,[cli,'api',endpoint,'--scope',scope,'--method','GET','--raw','--non-interactive'],{cwd:root,allowFail:true,timeout:30_000});
    if(response.status!==0)reject('VERCEL_READ_FAILED');
    try{return JSON.parse(response.stdout);}catch{reject('VERCEL_READ_INVALID');}
  };
  const observe=()=>{
    const p=api(`/v9/projects/${project}`),t=p.targets?.production;
    // Never expose project env values, credentials or deploy hook URLs.
    return {id:p.id,name:p.name,repository:`${p.link?.org}/${p.link?.repo}`,branch:p.link?.productionBranch,
      enabled:p.gitProviderOptions?.createDeployments==='enabled',autoAssign:p.autoAssignCustomDomains===true,
      ignoredBuild:p.commandForIgnoringBuildStep || null,
      production:{id:t?.id,sha:t?.meta?.githubCommitSha,readyState:t?.readyState,target:t?.target,url:t?.url},
      pending:(p.latestDeployments||[]).filter(d=>d.target==='production'&&['BUILDING','QUEUED','INITIALIZING'].includes(d.readyState))
        .map(d=>({sha:d.meta?.githubCommitSha,state:d.readyState}))};
  };
  return {observe};
}
