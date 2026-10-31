#!/usr/bin/env node
// Common Codex/Claude serial completion command. No hooks and no main merge.
import {randomUUID} from 'node:crypto';
import {closeSync, existsSync, lstatSync, mkdirSync, openSync, unlinkSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {assertNoGitHooks, git, gitOut, guardedGit, identifyWorktree, insideRoot, listWorktrees, parseArgs, repoRoot, sanitizedEnv, workingChanges, writeRecord} from './lib/common.mjs';
import {inspectCandidate} from './baba-integrate.mjs';
import {remoteMainState} from './lib/remote-main.mjs';
import {checkOperations, digest, outgoingCommits, reject, sensitiveChanges, validateSerial, vercelObserver, verifySerial} from './lib/serial-deploy.mjs';

function noOperation(root) {
  for (const marker of ['MERGE_HEAD','CHERRY_PICK_HEAD','REVERT_HEAD','rebase-apply','rebase-merge','sequencer','BISECT_LOG','index.lock']) {
    if(existsSync(resolve(root,gitOut(root,['rev-parse','--git-path',marker]))))reject('GIT_OPERATION_IN_PROGRESS');
  }
}
function assertSerial(root) {
  if(!identifyWorktree(root).isOriginal || gitOut(root,['branch','--show-current'])!=='main')reject('SERIAL_MAIN_REQUIRED');
  assertNoGitHooks(root);noOperation(root);
  if(workingChanges(root).length)reject('DIRTY_MAIN');
  if(gitOut(root,['rev-parse','HEAD'])!==gitOut(root,['rev-parse','refs/heads/main']))reject('MAIN_HEAD_MISMATCH');
}
const ancestor=(root,a,b)=>{
  const r=git(root,['merge-base','--is-ancestor',a,b],{allowFail:true});
  if(![0,1].includes(r.status))reject('UNKNOWN_HISTORY');return r.status===0;
};

export function scanCandidates(root) {
  const main=gitOut(root,['rev-parse','refs/heads/main']);
  const trees=listWorktrees(root),issues=[],candidates=[];
  for(const tree of trees) {
    if(!existsSync(tree.path)) {issues.push({branch:tree.branch,code:'WORKTREE_UNAVAILABLE'});continue;}
    try {assertNoGitHooks(tree.path);noOperation(tree.path);
      if(workingChanges(tree.path).length)issues.push({branch:tree.branch,code:'WORKTREE_DIRTY'});
      if(tree.branch==='(detached)'&&!ancestor(root,tree.head,main))issues.push({branch:tree.branch,head:tree.head,code:'DETACHED_UNINTEGRATED'});
    }catch(error){issues.push({branch:tree.branch,code:error.code||'WORKTREE_UNVERIFIED'});}
  }
  // All local refs, including tasks parked after their owner switched to ready.
  const refs=gitOut(root,['for-each-ref','--format=%(refname:short) %(objectname)','refs/heads/']).split('\n').filter(Boolean);
  for(const line of refs) {
    const [branch,head]=line.split(' ');if(branch==='main'||ancestor(root,head,main))continue;
    const item={branch,head,commits:Number(gitOut(root,['rev-list','--count',`main..${head}`])),
      active:trees.some(tree=>tree.branch===branch),status:'unverified'};
    try {
      const inspection=inspectCandidate(root,branch);
      Object.assign(item,{status:inspection.blockers.length?'blocked':'verified',
        handoff:inspection.candidate.handoff,verify:inspection.candidate.verify,verdict:inspection.candidate.verdict,
        changed:inspection.changed,strategy:inspection.strategy,revalidationRequired:inspection.revalidationRequired,
        evidenceDigest:digest(JSON.stringify(inspection.candidate)),blockers:inspection.blockers});
      if(inspection.blockers.length)issues.push({branch,code:'CANDIDATE_CONFLICT_OR_DEPENDENCY',blockers:inspection.blockers});
    }catch(error){item.code=error.code||'CANDIDATE_UNVERIFIED';issues.push({branch,head,code:item.code});}
    candidates.push(item);
  }
  for(let a=0;a<candidates.length;a++)for(let b=a+1;b<candidates.length;b++){
    const overlap=(candidates[a].changed||[]).filter(path=>!path.startsWith('docs/handoffs/')&&candidates[b].changed?.includes(path));
    if(overlap.length)issues.push({code:'CANDIDATES_OVERLAP',branches:[candidates[a].branch,candidates[b].branch],paths:overlap});
  }
  return {main,candidates,issues,refs};
}

function projectGate(root,p) {
  const remote=gitOut(root,['config','--get','remote.origin.url']);
  const repository=remote.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/)?.[1];
  if(!repository||p.repository!==repository||p.name!=='baba-staff-app'||p.branch!=='main'||!p.enabled||!p.autoAssign||p.ignoredBuild)reject('PRODUCTION_TARGET_UNVERIFIED');
  if(!/^[0-9a-f]{40}$/.test(p.production?.sha||'')||p.production.target!=='production')reject('PRODUCTION_SHA_UNVERIFIED');
  const config=git(root,['show','HEAD:vercel.json'],{allowFail:true});
  if(config.status===0){
    let parsed;try{parsed=JSON.parse(config.stdout);}catch{reject('VERCEL_CONFIG_UNVERIFIED');}
    const enabled=parsed.git?.deploymentEnabled;
    if(parsed.github?.enabled===false||enabled===false||(enabled&&typeof enabled==='object'&&(enabled.main??enabled['*'])===false))reject('GIT_DEPLOYMENT_DISABLED');
  }
}

export async function afterCommit(args={},cwd=process.cwd(),adapters={}) {
  const report={tool:'baba-after-commit',version:1,id:randomUUID(),generatedAt:new Date().toISOString(),
    mode:args.check?'check':'run',status:'BLOCKED',branch:'C',pushAttempted:false,pushed:false,productionVerified:false};
  let root,lock,lockIdentity,locked=false;
  try {
    root=repoRoot(cwd);assertSerial(root);report.root=root;
    if(git(root,['check-ignore','-q','--no-index','.tmp-baba/after-commit'],{allowFail:true}).status!==0)reject('OUTPUT_NOT_IGNORED');
    const directory=insideRoot(root,'.tmp-baba/after-commit');mkdirSync(directory,{recursive:true});
    lock=insideRoot(root,join(directory,'lock.json'));
    try{const fd=openSync(lock,'wx');writeFileSync(fd,JSON.stringify({id:report.id,pid:process.pid,createdAt:report.generatedAt}));closeSync(fd);locked=true;lockIdentity=lstatSync(lock,{bigint:true});}
    catch{reject('AFTER_COMMIT_LOCKED');}
    const scan=scanCandidates(root);report.discovery=scan;report.head=scan.main;
    report.candidateCount=scan.candidates.length;
    report.verifiedCandidateCount=scan.candidates.filter(c=>c.status==='verified').length;
    report.pendingWorkCount=scan.issues.length;
    // Candidate notifications include verified and incomplete parked branches. Neither can be silently discarded.
    if(scan.issues.length)reject('PENDING_WORK_UNVERIFIED');
    if(scan.candidates.length) {
      report.branch='A';report.status='INTEGRATION_PENDING';
      report.next=scan.candidates.map(c=>({branch:c.branch,head:c.head,
        command:`node scripts/agent/baba-integrate.mjs prepare --branch ${c.branch} --json`,
        cwd:c.branch.startsWith('codex/')?'baba-wt-codex':'baba-wt-claude'}));
      return report;
    }
    const remote=remoteMainState(root,{allowLocalAhead:true});report.remote=remote;
    const observer=adapters.observer || vercelObserver(root,args);
    const project=observer.observe();projectGate(root,project);report.project=project;
    if(project.pending?.some(d=>d.sha!==scan.main))reject('OTHER_PRODUCTION_DEPLOYMENT_PENDING');
    if(!ancestor(root,project.production.sha,scan.main))reject('PRODUCTION_HISTORY_UNVERIFIED');
    if(remote.remote===scan.main&&project.production.sha===scan.main&&project.production.readyState==='READY') {
      report.branch='B';report.status='ALREADY_DEPLOYED';report.productionVerified=true;return report;
    }
    const commits=outgoingCommits(root,project.production.sha,scan.main);report.commits=commits;
    if(!commits.length)reject('DEPLOYMENT_STATE_UNVERIFIED');
    report.operations=checkOperations(root,sensitiveChanges(root,commits),scan.main,args.operations);
    const verify=adapters.verify || verifySerial;
    report.verification=await verify(root,project.production.sha,scan.main,args.tests?args.tests.split(',').filter(Boolean):[]);
    // Pin all refs, Task/Handoff/Verify evidence, operational evidence, target and actual remote again AFTER verification.
    const checkStable=()=>{
      assertSerial(root);
      if(JSON.stringify(scanCandidates(root))!==JSON.stringify(scan))reject('WORK_CHANGED_REVALIDATE');
      if(JSON.stringify(remoteMainState(root,{allowLocalAhead:true}))!==JSON.stringify(remote))reject('REMOTE_CHANGED_REVALIDATE');
      const p=observer.observe();projectGate(root,p);
      if(p.id!==project.id||p.repository!==project.repository||p.production.sha!==project.production.sha||
        p.pending?.some(d=>d.sha!==scan.main))reject('PRODUCTION_CHANGED_REVALIDATE');
      const ops=checkOperations(root,sensitiveChanges(root,commits),scan.main,args.operations);
      if(JSON.stringify(ops)!==JSON.stringify(report.operations))reject('OPERATIONS_CHANGED_REVALIDATE');
      validateSerial(root,report.verification,project.production.sha,scan.main);
    };
    checkStable();report.branch='B';report.status='ELIGIBLE';
    if(args.check)return report;
    // A durable intent + lock prevent concurrent/replayed pushes. Resume uses real remote and target SHA.
    writeRecord(root,`.tmp-baba/after-commit/intents/${report.id}.json`,{head:scan.main,remote:remote.remote,commits,verification:report.verification});
    checkStable();
    if(remote.remote!==scan.main) {
      const push=adapters.push || ((sha)=>guardedGit(root,['push','--porcelain','origin',`${sha}:refs/heads/main`],{env:sanitizedEnv().env,allowFail:true,timeout:120_000}));
      report.pushAttempted=true;
      const result=push(scan.main,remote.remote);
      if(result.status!==0)reject('NORMAL_PUSH_FAILED');
      report.pushed=true;
    }
    report.status='PUSHED_UNCONFIRMED';
    const deadline=Date.now()+Math.min(600_000,Math.max(0,Number(args.waitMs??300_000)));
    do {
      assertSerial(root);
      if(gitOut(root,['rev-parse','HEAD'])!==scan.main||remoteMainState(root,{allowLocalAhead:true}).remote!==scan.main)reject('POST_PUSH_SHA_CHANGED');
      const p=observer.observe();projectGate(root,p);report.project=p;
      if(p.production.sha===scan.main&&p.production.readyState==='READY'&&p.production.target==='production') {
        if(JSON.stringify(scanCandidates(root))!==JSON.stringify(scan))reject('POST_PUSH_WORK_CHANGED');
        report.status='DEPLOYED';report.productionVerified=true;return report;
      }
      if(Date.now()>=deadline)break;
      await delay(Math.min(10_000,deadline-Date.now()));
    }while(Date.now()<=deadline);
    report.code='PRODUCTION_READY_SHA_UNCONFIRMED';
  }catch(error){report.status=report.pushAttempted?'PUSHED_UNCONFIRMED':'BLOCKED';report.branch='C';report.code=error.code||'STATE_UNVERIFIED';}
  finally {
    if(root&&locked) {
      try {
        report.savedAs=`.tmp-baba/after-commit/runs/${report.generatedAt.replace(/[:.]/g,'-')}-${report.id}.json`;
        writeRecord(root,report.savedAs,report);writeRecord(root,'.tmp-baba/after-commit/latest.json',report,{replace:true});
      }catch{report.status=report.pushAttempted?'PUSHED_UNCONFIRMED':'BLOCKED';report.code='REPORT_WRITE_FAILED';}
      try{const current=lstatSync(lock,{bigint:true});
        if(current.dev!==lockIdentity.dev||current.ino!==lockIdentity.ino||current.isSymbolicLink())reject('LOCK_CHANGED');
        unlinkSync(lock);
      }catch{report.status=report.pushAttempted?'PUSHED_UNCONFIRMED':'BLOCKED';report.code='LOCK_RELEASE_UNVERIFIED';}
    }
  }
  return report;
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  try {
    const args=parseArgs(process.argv.slice(2),{check:'boolean',project:'string',scope:'string',operations:'string',tests:'string',waitMs:'string',json:'boolean',help:'boolean'});
    if(args._.length)reject('INVALID_ARGUMENTS');
    if(args.help)console.log('baba-after-commit [--check] [--project baba-staff-app --scope baba333] [--operations <postflight.json>] [--tests a.test.mjs,b.test.ts] [--wait-ms 300000] [--json]\nSerial original main only. --check never pushes. Default runs the approved conditional release policy; no main merge or DB writes.');
    else {const report=await afterCommit(args);console.log(args.json?JSON.stringify(report,null,2):JSON.stringify(report,null,2));
      process.exitCode=['BLOCKED','PUSHED_UNCONFIRMED'].includes(report.status)?2:0;}
  }catch{console.error('Invalid arguments or unverified execution state.');process.exitCode=2;}
}
