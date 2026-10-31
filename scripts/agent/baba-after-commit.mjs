#!/usr/bin/env node
// Local serial completion only: no verification rerun, network, push or deployment.
import {randomUUID} from 'node:crypto';
import {closeSync, existsSync, lstatSync, mkdirSync, openSync, unlinkSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {assertNoGitHooks, git, gitOut, identifyWorktree, insideRoot, listWorktrees, parseArgs, repoRoot, workingChanges, writeRecord} from './lib/common.mjs';
import {inspectCandidate} from './baba-integrate.mjs';
import {digest, reject} from './lib/serial-deploy.mjs';

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

export async function afterCommit(args={},cwd=process.cwd()) {
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
    // Candidate and held-work findings are informational for local completion.
    // Deployment eligibility is checked only after a separate user approval.
    report.branch=scan.issues.length?'C':scan.candidates.length?'A':'B';
    report.status='LOCAL_COMMIT_RECORDED';
    report.deploymentStatus='NOT_REQUESTED';
    report.automaticPushEnabled=false;
    report.verificationRerun=false;
    report.next=scan.candidates.map(c=>({branch:c.branch,head:c.head,
      command:'User approval required before integration or deployment checks.'}));
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
    const args=parseArgs(process.argv.slice(2),{check:'boolean',project:'string',scope:'string',json:'boolean',help:'boolean'});
    if(args._.length)reject('INVALID_ARGUMENTS');
    if(args.help)console.log('baba-after-commit [--check] [--project baba-staff-app --scope baba333] [--json]\nSerial original main only. Local state/report only; no tests, TypeScript, Build, remote query, push or deployment. --check is an equivalent read-only completion mode.');
    else {const report=await afterCommit(args);console.log(args.json?JSON.stringify(report,null,2):JSON.stringify(report,null,2));
      process.exitCode=['BLOCKED','PUSHED_UNCONFIRMED'].includes(report.status)?2:0;}
  }catch{console.error('Invalid arguments or unverified execution state.');process.exitCode=2;}
}
