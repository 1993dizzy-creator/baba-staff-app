import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterCommit,scanCandidates} from '../scripts/agent/baba-after-commit.mjs';
import {checkOperations,digest,outgoingCommits,sensitiveChanges} from '../scripts/agent/lib/serial-deploy.mjs';
import {git,gitOut,insideRoot} from '../scripts/agent/lib/common.mjs';

const source=resolve(fileURLToPath(new URL('..',import.meta.url)));
const parent=insideRoot(source,'.tmp-baba/after-commit-fixtures');mkdirSync(parent,{recursive:true});
const put=(root,path,text)=>{const full=insideRoot(root,path);mkdirSync(resolve(full,'..'),{recursive:true});writeFileSync(full,text);};
const head=root=>gitOut(root,['rev-parse','HEAD']);
const commit=(root,path,text)=>{put(root,path,text);git(root,['add','--',path]);git(root,['commit','-m','fixture']);return head(root);};
// Small existing test-fixture directory only: no origin, Worktree, node_modules,
// build stub or private verification repository is needed for local completion.
function fixture(){
  const dir=mkdtempSync(join(parent,'f-')),main=join(dir,'baba-staff-app');mkdirSync(main);
  git(main,['init','-b','main']);git(main,['config','user.name','Fixture']);git(main,['config','user.email','fixture@example.invalid']);
  put(main,'.gitignore','.tmp-baba/\n');put(main,'app/a.ts','export const a=1;\n');
  git(main,['add','.']);git(main,['commit','-m','seed']);return {dir,main,seed:head(main)};
}

test('default and --check finish locally without verification, network, push or deployment',async()=>{
  for(const check of [false,true]){
    const f=fixture();const sha=commit(f.main,'app/a.ts','export const a=2;\n'),refs=gitOut(f.main,['show-ref']);
    const forbidden=new Proxy({}, {get(){assert.fail('release adapter must not be accessed');}});
    const r=await afterCommit({check,project:'baba-staff-app',scope:'baba333'},f.main,forbidden);
    assert.equal(r.status,'LOCAL_COMMIT_RECORDED');assert.equal(r.head,sha);
    assert.equal(r.verificationRerun,false);assert.equal(r.automaticPushEnabled,false);assert.equal(r.deploymentStatus,'NOT_REQUESTED');
    assert.equal(r.pushAttempted,false);assert.equal(r.pushed,false);assert.equal(r.productionVerified,false);
    assert.equal(r.verification,undefined);assert.equal(r.remote,undefined);assert.equal(r.project,undefined);
    assert.equal(existsSync(join(f.main,'.tmp-baba/after-commit/checks')),false);
    assert.equal(existsSync(join(f.main,'node_modules')),false);assert.equal(existsSync(join(f.main,'.next')),false);
    assert.equal(existsSync(join(f.main,'.tmp-baba/after-commit/lock.json')),false);
    assert.equal(gitOut(f.main,['show-ref']),refs);assert.equal(gitOut(f.main,['status','--porcelain']), '');
    assert.equal(JSON.parse(readFileSync(join(f.main,r.savedAs),'utf8')).status,r.status);
  }
});

test('unverified parked work is reported and preserved without blocking a clean local commit',async()=>{
  const f=fixture();git(f.main,['switch','-c','hold/legacy']);const candidate=commit(f.main,'app/a.ts','export const a=3;\n');git(f.main,['switch','main']);
  const refs=gitOut(f.main,['show-ref']),r=await afterCommit({},f.main);
  assert.equal(r.status,'LOCAL_COMMIT_RECORDED');assert.equal(r.candidateCount,1);assert.ok(r.pendingWorkCount>0);
  assert.equal(r.discovery.candidates[0].head,candidate);assert.equal(r.discovery.candidates[0].status,'unverified');
  assert.equal(scanCandidates(f.main).candidates.length,1);assert.equal(gitOut(f.main,['show-ref']),refs);assert.equal(head(f.main),f.seed);
  assert.equal(r.pushed,false);assert.equal(r.verification,undefined);
});

test('dirty main and a Git operation fail closed while preserving the existing work',async()=>{
  for(const mode of ['dirty','operation']){
    const f=fixture();if(mode==='dirty')put(f.main,'app/a.ts','preserve uncommitted');
    else writeFileSync(resolve(f.main,gitOut(f.main,['rev-parse','--git-path','MERGE_HEAD'])),f.seed);
    const r=await afterCommit({},f.main);assert.equal(r.status,'BLOCKED');
    assert.equal(r.code,mode==='dirty'?'DIRTY_MAIN':'GIT_OPERATION_IN_PROGRESS');assert.equal(r.pushAttempted,false);
    assert.equal(head(f.main),f.seed);if(mode==='dirty')assert.equal(readFileSync(join(f.main,'app/a.ts'),'utf8'),'preserve uncommitted');
  }
});

test('non-main execution and an existing after-commit lock remain protected',async()=>{
  const f=fixture();git(f.main,['switch','-c','other']);assert.equal((await afterCommit({},f.main)).code,'SERIAL_MAIN_REQUIRED');
  git(f.main,['switch','main']);put(f.main,'.tmp-baba/after-commit/lock.json','existing owner');
  assert.equal((await afterCommit({},f.main)).code,'AFTER_COMMIT_LOCKED');
  assert.equal(readFileSync(join(f.main,'.tmp-baba/after-commit/lock.json'),'utf8'),'existing owner');
});

test('operational evidence is fresh, exact-version and raw-artifact bound; unapplied or failed postflight blocks',()=>{
  const f=fixture(),sha=commit(f.main,'supabase/migrations/20261031000000_fixture.sql','select 1;');
  const changes=sensitiveChanges(f.main,outgoingCommits(f.main,f.seed,sha)),observedAt=new Date().toISOString();
  const query='select 1; -- mock connected read-only result, never executed';put(f.main,'.tmp-baba/query.sql',query);
  const checks=Object.fromEntries(['appliedSqlMatches','migrationHistory','functionDefinitions','permissions','rowCounts','auditLogs','securityAdvisor','performanceAdvisor'].map(k=>[k,true]));
  const result={projectId:'yfjqwsdqhvnfqxywsqcz',observedAt,querySha256:digest(query),checks};
  const raw=JSON.stringify(result);put(f.main,'.tmp-baba/result.json',raw);
  const record={...changes[0],applied:true,observedAt,queryFile:'.tmp-baba/query.sql',querySha256:digest(query),resultFile:'.tmp-baba/result.json',resultSha256:digest(raw)};
  const receipt={version:1,source:'connected-read-only-postflight',head:sha,projectId:result.projectId,observedAt,
    reviewedChangesDigest:digest(JSON.stringify(changes)),records:[record]};
  const check=()=>checkOperations(f.main,changes,sha,'.tmp-baba/operations.json');
  put(f.main,'.tmp-baba/operations.json',JSON.stringify(receipt));assert.equal(check().required,true);
  for(const bad of [{head:f.seed},{observedAt:'2000-01-01T00:00:00Z'},{reviewedChangesDigest:'wrong'},
    {records:[{...record,applied:false}]},{records:[{...record,blob:'wrong'}]}]){
    put(f.main,'.tmp-baba/operations.json',JSON.stringify({...receipt,...bad}));assert.throws(check);
  }
  put(f.main,'.tmp-baba/operations.json',JSON.stringify(receipt));put(f.main,'.tmp-baba/result.json',JSON.stringify({...result,checks:{...checks,permissions:false}}));
  assert.throws(check,e=>e.code==='OPERATIONS_ARTIFACT_MISMATCH');
});
