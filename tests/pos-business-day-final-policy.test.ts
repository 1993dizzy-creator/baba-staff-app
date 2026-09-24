import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
// @ts-expect-error Direct Node TypeScript tests require explicit extensions.
import { comparePosFinalAmounts,isEligiblePosFinalSync,posSnapshotTotals } from '../lib/sales/pos-business-day-final-policy.ts';
// @ts-expect-error Direct Node TypeScript tests require explicit extensions.
import { runManualCloseWorkflow,runPosFinalWorkflow } from '../lib/sales/pos-business-day-final-workflow.ts';
// @ts-expect-error Direct Node TypeScript tests require explicit extensions.
import { buildPosBusinessDaySource } from '../lib/ledger/pos-sales-source.ts';
const date='2026-09-11',now=new Date('2026-09-11T20:05:00Z'),cutoffAt='2026-09-11T20:00:00Z';
const read=(path:string)=>readFileSync(join(process.cwd(),path),'utf8');
const closePanel=read('components/sales/PosBusinessDayClosePanel.tsx');
const salesPage=read('app/(protected)/admin/sales/page.tsx');
const closeText=read('lib/text/sales-close.ts');
const closeService=read('lib/sales/pos-business-day-close.ts');
const finalService=read('lib/sales/pos-business-day-final.ts');
const source=buildPosBusinessDaySource(date,[],[]);
const run={id:100,business_date:date,source:'cukcuk',status:'success',source_complete:true,started_at:cutoffAt,finished_at:'2026-09-11T20:01:00Z',error_message:null};
for(const role of ['owner','master','manager','staff','leader'])test('manual close role '+role,async()=>{
 const calls:string[]=[];
 const deps={eligible:async()=>{calls.push('time');return true;},refresh:async()=>{calls.push('force');return 100;},close:async(id:number)=>{calls.push('close');assert.equal(id,100);return 'closed';}};
 if(['owner','master','manager'].includes(role)){assert.equal(await runManualCloseWorkflow({role,reclose:false},deps),'closed');assert.deepEqual(calls,['time','force','close']);}
 else{await assert.rejects(runManualCloseWorkflow({role,reclose:false},deps),/FORBIDDEN/);assert.deepEqual(calls,[]);}
});
test('manual force failure, early close and manager reclose never invoke close',async()=>{
 const close=async()=>{assert.fail('close must not run');};
 await assert.rejects(runManualCloseWorkflow({role:'owner',reclose:false},{eligible:async()=>true,refresh:async()=>{throw Error('sync_failed');},close}),/sync_failed/);
 await assert.rejects(runManualCloseWorkflow({role:'owner',reclose:false},{eligible:async()=>false,refresh:async()=>100,close}),/BEFORE_CONFIGURED/);
 await assert.rejects(runManualCloseWorkflow({role:'manager',reclose:true},{eligible:async()=>true,refresh:async()=>100,close}),/FORBIDDEN/);
});
test('final sync requires exact date/source/success/completeness/cutoff and 30-minute freshness',()=>{
 assert.equal(isEligiblePosFinalSync(run,date,cutoffAt,now),true);
 for(const change of [{business_date:'2026-09-10'},{status:'failed'},{source:'other'},{source_complete:null},{source_complete:false},
  {started_at:'2026-09-11T19:59:59Z'},{finished_at:'2026-09-11T20:06:00Z'},{error_message:'details skipped'}])
  assert.equal(isEligiblePosFinalSync({...run,...change},date,cutoffAt,now),false);
 assert.equal(isEligiblePosFinalSync(run,date,cutoffAt,new Date('2026-09-11T21:00:00Z')),false);
});
test('final amounts distinguish unchanged, metadata-only, total and bucket-only drift',()=>{
 const closed={total:100000,cash:40000,transfer:30000,card:20000,other:10000};
 assert.equal(comparePosFinalAmounts(closed,closed,'a','a').result,'verified_unchanged');
 assert.equal(comparePosFinalAmounts(closed,closed,'a','b').result,'metadata_changed_only');
 for(const current of [{...closed,total:110000,cash:50000},{...closed,cash:50000,transfer:20000},{...closed,card:30000,transfer:20000}])
  assert.equal(comparePosFinalAmounts(closed,current,'a','b').result,'financial_drift');
 assert.throws(()=>posSnapshotTotals({receiptTotal:10,totalsByBucket:{cash:9,transfer:0,card:0,other:0}}),/MISMATCH/);
});
for(const scenario of ['reuse','missing_retry_success','legacy_null_retry_success','retry_failed','source_invalid','busy','rpc_source_changed'])test('final workflow '+scenario,async()=>{
 let refreshes=0,released=0,reads=0;
 const result=await runPosFinalWorkflow({date,cutoffAt,now},{
  now:()=>now,claim:async()=>scenario==='busy'?null:'token',release:async()=>{released++;},
  latest:async()=>{reads++;if(scenario==='legacy_null_retry_success'&&reads===1)return {...run,source_complete:null};return scenario==='missing_retry_success'&&reads===1||scenario==='retry_failed'?null:run;},
  refresh:async()=>{refreshes++;if(scenario==='retry_failed')throw Error('network');return 100;},
  source:async()=>{if(scenario==='source_invalid')throw Error('payment mismatch');return source;},
  finalize:async(token,r,s,failure,detail)=>{assert.equal(token,'token');assert.equal(detail.businessDate,date);assert.equal(detail.cutoffAt,cutoffAt);assert.ok('finalSync' in detail);assert.ok('retryFailureReason' in detail);if(scenario==='legacy_null_retry_success'){assert.equal(refreshes,1);assert.equal(r?.source_complete,true);assert.equal(detail.retryExecuted,true);}if(scenario==='rpc_source_changed'&&!failure)throw {code:'40001'};return {status:failure??'verified_unchanged'};},
 });
 assert.equal(result.status,scenario==='busy'?'in_progress':scenario==='retry_failed'?'sync_failed':['source_invalid','rpc_source_changed'].includes(scenario)?'source_invalid':'verified_unchanged');
 assert.equal(refreshes,['missing_retry_success','legacy_null_retry_success','retry_failed'].includes(scenario)?1:0);
 assert.equal(released,scenario==='busy'?0:1);
});
test('workflow releases lease even when finalize throws an unexpected failure',async()=>{
 let released=0;
 await assert.rejects(runPosFinalWorkflow({date,cutoffAt,now},{now:()=>now,claim:async()=> 'token',
  release:async()=>{released++;},latest:async()=>run,refresh:async()=>100,source:async()=>source,
  finalize:async()=>{throw Error('database unavailable');}}),/database unavailable/);
 assert.equal(released,1);
});
test('daily sales notice integrates the compact close control before summary cards',()=>{
 const notice=salesPage.slice(salesPage.indexOf('<section style={noticeCardStyle}>'),salesPage.indexOf('<section style={summaryGridStyle}>'));
 assert.match(notice,/dailyText\.syncButton[\s\S]*<PosBusinessDayClosePanel/);
 assert.equal((salesPage.match(/<PosBusinessDayClosePanel/g)||[]).length,1);
});
test('normal closed state is compact and omits duplicate sales totals, payment grid and sync detail',()=>{
 assert.match(closePanel,/✓ \{t\.closed\}/);
 assert.match(closePanel,/check\.result==='verified_unchanged'\?''/);
 assert.doesNotMatch(closePanel,/t\.lastSync/);
 assert.doesNotMatch(closePanel,/totals\?<div style=\{grid\}/);
 assert.doesNotMatch(closePanel,/t\.verifiedDetail/);
});
test('pre-close eligibility, automatic/manual metadata and reclose confirmation remain available',()=>{
 assert.match(closePanel,/disabled=\{!status\.canClose\|\|busy\|\|disabled\}/);
 assert.match(closePanel,/\{eligibility\?<p style=\{muted\}>\{eligibility\}/);
 assert.match(closePanel,/status\.latestClose\.method==='automatic'\?t\.automatic:t\.manual/);
 assert.match(closePanel,/status\.canReclose[\s\S]*setConfirm\(true\)/);
 assert.match(closePanel,/confirm&&status\.latestClose&&status\.currentTotals&&status\.delta/);
 assert.match(closePanel,/expectedSourceFingerprint:status\?\.currentFingerprint/);
});
test('initial manual close requires confirmation while reclose keeps its existing review flow',()=>{
 assert.match(closePanel,/onClick=\{\(\)=>setConfirmInitialClose\(true\)\}/);
 assert.match(closePanel,/confirmInitialClose&&!status\.latestClose[\s\S]*role='dialog'[\s\S]*t\.manualCloseConfirmTitle/);
 assert.match(closePanel,/onClick=\{\(\)=>setConfirmInitialClose\(false\)\}>\{t\.cancel\}/);
 assert.equal((closePanel.match(/onClick=\{\(\)=>void close\(false\)\}/g)||[]).length,1);
 assert.match(closePanel,/status\.canReclose[\s\S]*setConfirm\(true\)/);
 assert.match(closeText,/"beforeClose": "오후 11시 이후 영업 마감이 가능합니다\."/);
 assert.match(closeText,/"beforeClose": "Có thể chốt ngày kinh doanh sau 23:00\."/);
 assert.match(closeText,/"manualCloseConfirmTitle": "영업 마감을 진행하시겠습니까\?"/);
 assert.match(closeText,/"manualCloseConfirmTitle": "Bạn có muốn chốt ngày kinh doanh không\?"/);
});
test('manual close paths use the 23:00 policy while automatic and final paths retain configured close time',()=>{
 assert.match(closeService,/getPosBusinessDayManualCloseTime[\s\S]*evaluatePosManualCloseTime/);
 assert.match(closeService,/options\.method === "manual"[\s\S]*getPosBusinessDayManualCloseTime[\s\S]*getPosBusinessDayCloseTime/);
 assert.match(finalService,/eligible:async\(\)=>\(await getPosBusinessDayManualCloseTime\(date\)\)\.allowed/);
 assert.match(finalService,/finalizePosBusinessDay[\s\S]*getPosBusinessDayCloseTime\(date,now\)/);
});
test('exception states stay visible while verified unchanged stays quiet',()=>{
 for(const contract of ['metadata_changed_only','financial_drift','sync_failed','source_invalid','month_closed','ledgerProjection.status===\'mismatch\'','needsOwnerReview'])assert.match(closePanel,new RegExp(contract.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
 assert.match(closeText,/"recloseReview": "마감 재확인"/);
 assert.match(closeText,/"recloseReview": "Kiểm tra chốt lại"/);
});
