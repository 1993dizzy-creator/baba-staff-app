import test from 'node:test';
import assert from 'node:assert/strict';
import {cpSync,existsSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterCommit,scanCandidates} from '../scripts/agent/baba-after-commit.mjs';
import {checkOperations,digest,outgoingCommits,sensitiveChanges,verifySerial} from '../scripts/agent/lib/serial-deploy.mjs';
import {git,gitOut,insideRoot,run,sanitizedEnv,writeRecord} from '../scripts/agent/lib/common.mjs';

const source=resolve(fileURLToPath(new URL('..',import.meta.url)));
const parent=insideRoot(source,'.tmp-baba/after-commit-fixtures');mkdirSync(parent,{recursive:true});
const put=(root,path,text)=>{const full=insideRoot(root,path);mkdirSync(resolve(full,'..'),{recursive:true});writeFileSync(full,text);};
const head=root=>gitOut(root,['rev-parse','HEAD']);
const commit=(root,path,text)=>{put(root,path,text);git(root,['add','--',path]);git(root,['commit','-m','fixture']);return head(root);};
function fixture(){
  const dir=mkdtempSync(join(parent,'f-')),main=join(dir,'baba-staff-app'),origin=join(dir,'origin.git');mkdirSync(main);
  git(main,['init','-b','main']);git(main,['config','user.name','Fixture']);git(main,['config','user.email','fixture@example.invalid']);
  cpSync(join(source,'scripts/agent'),join(main,'scripts/agent'),{recursive:true});
  put(main,'.gitignore','.tmp-baba/\nnode_modules/\n');put(main,'app/a.ts','export const a=1;\n');put(main,'app/b.ts','export const b=1;\n');
  put(main,'tests/check.test.mjs',`import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';test('UI invariant',()=>{for(const p of ['app/a.ts','app/b.ts'])assert.ok(readFileSync(p,'utf8').startsWith('export'));});`);
  git(main,['add','.']);git(main,['commit','-m','seed']);const seed=head(main);
  git(main,['init','--bare',origin]);git(main,['remote','add','origin',origin]);git(main,['push','origin','main']); // Local bare fixture only.
  put(main,'node_modules/next/dist/bin/next','process.exit(0);');
  put(main,'node_modules/typescript/lib/tsc.js','process.exit(0);');
  put(main,'node_modules/eslint/bin/eslint.js',"console.log('[]');");
  const codex=join(dir,'baba-wt-codex');git(main,['worktree','add','--no-track','-b','codex/ready-fixture',codex,'main']);
  return {dir,main,origin,seed,codex};
}
function finishCandidate(f,{id='20261031-first-01',file='app/a.ts',park=false,complete=true}={}){
  const branch=`codex/${id}`;git(f.codex,['switch','-c',branch,'main']);
  writeRecord(f.codex,`.tmp-baba/start/tasks/${id}.json`,{version:1,root:f.codex,agent:'codex',task:'fixture',slug:id,
    taskKey:digest(`fixture\0${id}`),files:[file],taskId:id,branch,baseSha:gitOut(f.main,['rev-parse','main'])});
  commit(f.codex,file,'export const value=2;\n');
  if(complete){
    cpSync(join(f.main,'node_modules'),join(f.codex,'node_modules'),{recursive:true});
    const env=sanitizedEnv().env;
    const result=run(process.execPath,[join(f.codex,'scripts/agent/baba-verify.mjs'),'--base','main','--build','--tests','tests/check.test.mjs'],{cwd:f.codex,env,allowFail:true,timeout:120000});
    assert.equal(result.status,0,result.stdout+result.stderr);
    assert.equal(run(process.execPath,[join(f.codex,'scripts/agent/baba-handoff.mjs'),'--task-name','fixture','--base','main'],{cwd:f.codex,env}).status,0);
    const path=`docs/handoffs/${branch.replace('/','-')}.md`;
    put(f.codex,path,readFileSync(join(f.codex,path),'utf8').replace(/<!-- TODO[\s\S]*?-->/g,'fixture verification executed'));
    git(f.codex,['add','--',path]);git(f.codex,['commit','-m','handoff']);
  }
  const sha=head(f.codex);if(park)git(f.codex,['switch',`codex/ready-fixture`]);return {branch,sha};
}
function releaseAdapters(f,{ready=true}={}){
  let pushed=false,calls=0;
  const observer={observe:()=>({id:'project-fixture',name:'baba-staff-app',repository:'fixture/baba-staff-app',branch:'main',enabled:true,autoAssign:true,
    production:{sha:pushed&&ready?head(f.main):f.seed,readyState:'READY',target:'production'},pending:[]})};
  // Match production repository identity without making any network connection.
  // remoteMainState still queries a REAL disposable local origin via url.insteadOf.
  git(f.main,['config',`url.${f.origin}.insteadOf`,'https://github.com/fixture/baba-staff-app.git']);
  git(f.main,['remote','set-url','origin','https://github.com/fixture/baba-staff-app.git']);
  return {observer,verify:(root,base,sha)=>verifySerial(root,base,sha,['tests/check.test.mjs']),
    push:sha=>{calls++;assert.equal(sha,head(f.main));git(f.main,['push','origin',`${sha}:refs/heads/main`]);pushed=true;return {status:0};},
    get calls(){return calls;}};
}

test('active and preserved inactive candidates keep their exact refs, handoff and immutable Verify evidence',async()=>{
  for(const park of [false,true]){
    const f=fixture(),candidate=finishCandidate(f,{park}),refs=gitOut(f.main,['show-ref']);
    const r=await afterCommit({check:true},f.main);
    assert.equal(r.status,'INTEGRATION_PENDING',JSON.stringify(r));assert.equal(r.branch,'A');
    assert.equal(r.discovery.candidates[0].head,candidate.sha);assert.equal(r.discovery.candidates[0].active,!park);
    assert.equal(r.discovery.candidates[0].verdict,'PASS');assert.equal(r.pushed,false);
    assert.equal(gitOut(f.main,['show-ref']),refs);assert.equal(head(f.main),f.seed);
  }
});
test('already integrated branches are excluded; incomplete and unknown parked work fail closed',async()=>{
  const f=fixture(),c=finishCandidate(f);git(f.main,['merge','--ff-only',c.branch]);
  assert.equal(scanCandidates(f.main).candidates.length,0);
  finishCandidate(f,{id:'20261031-incomplete-01',file:'app/b.ts',park:true,complete:false});
  const r=await afterCommit({check:true},f.main);assert.equal(r.code,'PENDING_WORK_UNVERIFIED');assert.equal(r.discovery.candidates[0].code,'HANDOFF_MISSING');
  git(f.main,['branch','hold/legacy',head(f.codex)]); // merged ref is excluded, not counted merely by name.
  assert.ok(scanCandidates(f.main).candidates.every(x=>x.branch!=='hold/legacy'));
});
test('multiple disjoint valid candidates are listed; overlaps and invalid archived evidence block',async()=>{
  const f=fixture(),first=finishCandidate(f,{park:true});
  finishCandidate(f,{id:'20261031-second-01',file:'app/b.ts',park:true});
  const r=await afterCommit({check:true},f.main);assert.equal(r.status,'INTEGRATION_PENDING',JSON.stringify(r));assert.equal(r.discovery.candidates.length,2);
  const verify=r.discovery.candidates.find(c=>c.branch===first.branch).verify;
  const archive=JSON.parse(readFileSync(join(f.codex,verify),'utf8'));put(f.codex,verify,JSON.stringify({...archive,verdict:'FAIL'}));
  assert.equal((await afterCommit({check:true},f.main)).code,'PENDING_WORK_UNVERIFIED');
});
test('candidate-free UI release runs real isolated Verify, normal Push mock, exact production SHA/READY and duplicate suppression',async()=>{
  const f=fixture();commit(f.main,'app/a.ts','export const a=2;\n');const adapters=releaseAdapters(f);
  const r=await afterCommit({waitMs:0},f.main,adapters);assert.equal(r.status,'DEPLOYED',JSON.stringify(r));assert.equal(r.productionVerified,true);assert.equal(adapters.calls,1);
  const again=await afterCommit({},f.main,adapters);assert.equal(again.status,'ALREADY_DEPLOYED');assert.equal(adapters.calls,1);
  assert.equal(existsSync(join(f.main,'.tmp-baba/after-commit/lock.json')),false);
});
test('check mode verifies without push; missing READY or wrong SHA never becomes release success',async()=>{
  const f=fixture();commit(f.main,'app/a.ts','export const a=2;\n');const adapters=releaseAdapters(f,{ready:false});
  const check=await afterCommit({check:true},f.main,adapters);assert.equal(check.status,'ELIGIBLE',JSON.stringify(check));assert.equal(adapters.calls,0);
  const r=await afterCommit({waitMs:0},f.main,adapters);assert.equal(r.status,'PUSHED_UNCONFIRMED');assert.equal(r.productionVerified,false);assert.equal(adapters.calls,1);
});
test('all unshipped commits, including intermediate SQL and removed RPC calls, require actual operational evidence',async()=>{
  const f=fixture();commit(f.main,'supabase/migrations/20261031000000_fixture.sql','select 1;');
  commit(f.main,'app/a.ts',"export const a=()=>client.rpc('changed');\n");commit(f.main,'app/a.ts','export const a=2;\n');
  const adapters=releaseAdapters(f),r=await afterCommit({waitMs:0},f.main,adapters);
  assert.equal(r.code,'OPERATIONS_POSTFLIGHT_REQUIRED');assert.equal(r.commits.length,3);assert.equal(adapters.calls,0);
  const changes=sensitiveChanges(f.main,outgoingCommits(f.main,f.seed,head(f.main)));assert.ok(changes.some(c=>c.commit===head(f.main)&&c.path==='app/a.ts'));
  put(f.main,'.tmp-baba/forged.json',JSON.stringify({approvedBy:'user',applied:true}));
  assert.throws(()=>checkOperations(f.main,changes,head(f.main),'.tmp-baba/forged.json'),e=>e.code==='OPERATIONS_EVIDENCE_INVALID');
});
test('remote change during verification and concurrent execution prohibit push',async()=>{
  const f=fixture();commit(f.main,'app/a.ts','export const a=2;\n');const adapters=releaseAdapters(f),verify=adapters.verify;let nested;
  adapters.verify=async(root,base,sha)=>{nested=await afterCommit({check:true},root,adapters);const checked=verify(root,base,sha);
    git(root,['push','origin',`${sha}:refs/heads/main`]);return checked;}; // Only this disposable origin changes.
  const r=await afterCommit({waitMs:0},f.main,adapters);
  assert.equal(nested.code,'AFTER_COMMIT_LOCKED');assert.equal(r.code,'REMOTE_CHANGED_REVALIDATE');assert.equal(adapters.calls,0);
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
test('dirty worktree, Git operation, target mismatch, verification failure and deploy hold all block without push',async()=>{
  for(const mode of ['dirty','operation','target','verify','pending']){
    const f=fixture();commit(f.main,'app/a.ts','export const a=2;\n');const adapters=releaseAdapters(f);
    if(mode==='dirty')put(f.codex,'app/a.ts','preserve uncommitted');
    if(mode==='operation')writeFileSync(resolve(f.main,gitOut(f.main,['rev-parse','--git-path','MERGE_HEAD'])),f.seed);
    if(mode==='target'){const observe=adapters.observer.observe;adapters.observer.observe=()=>({...observe(),branch:'other'});}
    if(mode==='verify')adapters.verify=()=>{throw Object.assign(new Error('fixture'),{code:'SERIAL_VERIFY_FAILED'});};
    if(mode==='pending'){const observe=adapters.observer.observe;adapters.observer.observe=()=>({...observe(),pending:[{sha:f.seed,state:'BUILDING'}]});}
    const r=await afterCommit({waitMs:0},f.main,adapters);assert.equal(r.status,'BLOCKED',JSON.stringify(r));assert.equal(adapters.calls,0);
  }
});
test('push transport failure remains unconfirmed, and repository-level disabled deployment prohibits push',async()=>{
  const f=fixture();commit(f.main,'app/a.ts','export const a=2;\n');const adapters=releaseAdapters(f);let attempts=0;
  adapters.push=()=>{attempts++;return {status:1};};
  const r=await afterCommit({waitMs:0},f.main,adapters);
  assert.equal(r.status,'PUSHED_UNCONFIRMED');assert.equal(r.pushAttempted,true);assert.equal(r.productionVerified,false);assert.equal(attempts,1);
  commit(f.main,'vercel.json',JSON.stringify({git:{deploymentEnabled:{main:false}}}));
  const disabled=await afterCommit({},f.main,adapters);assert.equal(disabled.code,'GIT_DEPLOYMENT_DISABLED');assert.equal(attempts,1);
});
