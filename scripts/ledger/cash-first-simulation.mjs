// Offline model only: no database client, SQL renderer, credentials or network.
// The generic preflight/simulate/postflight functions also accept Jan-Jun inputs.
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {sha,csv} from './july-restore-phase2.mjs';
import {parseCsv} from './july-restore-source-review.mjs';
export const FUNDS=['store_cash','vuong_personal_custody','cho_personal_custody','baba_corporate_bank'];
const integer=x=>{if(!/^-?\d+$/.test(String(x)))throw Error('INVALID_INTEGER_MONEY');return BigInt(x);};
const money=x=>x.toString();
const zeros=funds=>Object.fromEntries(funds.map(f=>[f,0n]));
export function cashPreflight({rows,completedKeys,period,funds=FUNDS}){
 if(new Set(rows.map(r=>r.key)).size!==rows.length)throw Error('DUPLICATE_SOURCE_KEY');
 if(new Set(completedKeys).size!==completedKeys.length||completedKeys.some(k=>!rows.some(r=>r.key===k)))throw Error('COMPLETED_KEY_DRIFT');
 const completed=new Set(completedKeys);
 return rows.map(r=>{
  if(!r.date.startsWith(period+'-'))throw Error('SOURCE_DATE_OUTSIDE_PERIOD');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(r.date)||!Number.isFinite(Date.parse(r.date+'T00:00:00Z'))||new Date(r.date+'T00:00:00Z').toISOString().slice(0,10)!==r.date)throw Error('INVALID_BUSINESS_DATE');
  if(!r.effects.length||new Set(r.effects.map(e=>e.account)).size!==r.effects.length)throw Error('INVALID_EFFECTS');
  const effects=r.effects.filter(e=>funds.includes(e.account)).map(e=>({account:e.account,amount:money(integer(e.amount))}));
  if(r.effects.some(e=>!funds.includes(e.account)&&e.account!=='card_clearing'))throw Error('UNKNOWN_ACCOUNT');
  for(const e of r.effects)if(integer(e.amount)===0n)throw Error('ZERO_EFFECT');
  const referenceEffects=r.effects.filter(e=>!funds.includes(e.account));
  const source={key:r.key,date:r.date,effects,referenceEffects};
  return {...source,row:r.row,period,sourceFingerprint:sha(source),cashStatus:completed.has(r.key)?'existing_link':effects.length?'cash_record_pending':'reference_only',economicStatus:completed.has(r.key)?'previously_processed':'unclassified',economicPostingAllowed:false};
 });
}
// Pure staged copy: demonstrates the required replay/conflict/atomicity contract,
// not evidence that a future PostgreSQL implementation already has that contract.
export function simulateCashBatch(plan,existing=new Map(),failAfter=null){
 const next=new Map(existing);let imported=0,movements=0,referenceOnly=0;
 for(const r of plan){
  const old=next.get(r.key);
  if(old){if(old.sourceFingerprint!==r.sourceFingerprint)throw Error('SOURCE_REVISION_CONFLICT');continue;}
  next.set(r.key,r);imported++;
  if(r.cashStatus==='cash_record_pending')movements+=r.effects.length;
  if(r.cashStatus==='reference_only')referenceOnly++;
  if(failAfter===imported)throw Error('SIMULATED_BATCH_FAILURE');
 }
 return {registry:next,imported,movements,referenceOnly};
}
export function cashPostflight({plan,baseline,funds=FUNDS}){
 const pending=plan.filter(r=>r.cashStatus==='cash_record_pending');
 const daily=baseline.map(cell=>{
  if(!funds.includes(cell.account))throw Error('TARGET_ACCOUNT');
  const delta=pending.filter(r=>r.date<=cell.date).flatMap(r=>r.effects).filter(e=>e.account===cell.account).reduce((s,e)=>s+integer(e.amount),0n);
  const before=integer(cell.before),target=integer(cell.target),after=before+delta;
  return {...cell,before:money(before),target:money(target),added:money(delta),after:money(after),difference:money(target-after),matchBefore:before===target,matchAfter:after===target};
 });
 return {daily,matchedBefore:daily.filter(d=>d.matchBefore).length,matchedAfter:daily.filter(d=>d.matchAfter).length,remainingCells:daily.filter(d=>!d.matchAfter).length};
}
const volume=effects=>{
 const out=effects.filter(e=>integer(e.amount)<0n).reduce((s,e)=>s-integer(e.amount),0n),inc=effects.filter(e=>integer(e.amount)>0n).reduce((s,e)=>s+integer(e.amount),0n);return out>inc?out:inc;
};
export function posMatchPlan(rows){
 const groups=new Map(),payments=new Map();
 const records=rows.filter(r=>r.phase4Bucket==='pos_card').map(r=>{
  const role=r.group==='card_deposit'?'card_deposit':r.group==='pos_card'?'card_sale_reference':r.group==='pos_daily_split'?'daily_payment_summary':'individual_collection';
  const link=r.previousPosLink,group=link?.groupKey||null;
  if(group){const g=groups.get(group)||{key:group,date:r.date,rows:[],paymentIds:[],receiptIds:[]};g.rows.push(r.row);g.paymentIds=[...new Set([...g.paymentIds,...(link.paymentIds||[])])];g.receiptIds=[...new Set([...g.receiptIds,...(link.receiptIds||[])])];groups.set(group,g);}
  for(const id of link?.paymentIds||[]){const p=payments.get(id)||{id,rows:[],groups:[]};p.rows.push(r.row);p.groups=[...new Set([...p.groups,group])];payments.set(id,p);}
  return {row:r.row,key:r.key,date:r.date,role,groupKey:group,paymentIds:link?.paymentIds||[],receiptIds:link?.receiptIds||[],mappingState:group?'prior_source_identified_allocation_not_posting':'needs_evidence',createRevenue:false,createCardSettlement:false,createAdditionalCash:false};
 });
 const roles=Object.fromEntries(['daily_payment_summary','individual_collection','card_sale_reference','card_deposit'].map(role=>[role,{rows:records.filter(r=>r.role===role).length,amount:money(rows.filter(r=>records.some(x=>x.row===r.row&&x.role===role)).reduce((s,r)=>s+volume(r.effects),0n))}]));
 return {records,groups:[...groups.values()],summary:{roles,identifiedRows:records.filter(r=>r.groupKey).length,unidentifiedRows:records.filter(r=>!r.groupKey).length,uniquePaymentIds:payments.size,paymentReferences:[...payments.values()].reduce((s,p)=>s+p.rows.length,0),sharedPayments:[...payments.values()].filter(p=>p.rows.length>1),crossGroupConflicts:[...payments.values()].filter(p=>p.groups.length>1)}};
}
export function julySimulation(root){
 const read=p=>readFileSync(join(root,p),'utf8'),load=p=>JSON.parse(read(p));
 const approved=load('phase4-final-20261107-r2/bundle.json'),previous=load('phase4-final-20261107-r2/remaining-250.json'),original=load('dry-run-20261107-v2/395-row-dry-run.json');
 const sourceHashes=load('dry-run-20261107-v2/summary.json').sourceFiles;
 for(const name of ['july_2026_395_transactions.csv','july_2026_daily_targets.csv'])if(sha(read(name))!==sourceHashes[name].sha256)throw Error('SOURCE_FILE_CHANGED:'+name);
 const appliedRows=[...approved.bundle.completedRows,...approved.bundle.actions.map(a=>a.row)];
 if(original.length!==395||new Set(appliedRows).size!==154)throw Error('SOURCE_OR_APPLIED_SCOPE');
 const remaining=previous.filter(r=>!appliedRows.includes(r.row));
 if(remaining.length!==241)throw Error('REMAINING_SCOPE');
 const rows=original.map(r=>remaining.find(x=>x.key===r.key)||r),completedKeys=rows.filter(r=>appliedRows.includes(r.row)).map(r=>r.key);
 const plan=cashPreflight({rows,completedKeys,period:'2026-07'}),anchors=new Map(plan.filter(r=>r.cashStatus==='existing_link').map(r=>[r.key,r]));
 const fresh=plan.filter(r=>r.cashStatus!=='existing_link'),simulated=simulateCashBatch(fresh,anchors),replay=simulateCashBatch(fresh,simulated.registry);
 const baseline=parseCsv(read('phase4-final-20261107-r2/daily-124-impact.csv')).map(d=>({date:d.date,account:d.account,before:d.after,target:d.target}));
 if(baseline.length!==124)throw Error('TARGET_SCOPE');
 const post=cashPostflight({plan,baseline});
 const cash=fresh.filter(r=>r.cashStatus==='cash_record_pending'),refs=fresh.filter(r=>r.cashStatus==='reference_only'),delta=zeros(FUNDS);
 for(const r of cash)for(const e of r.effects)delta[e.account]+=integer(e.amount);
 const matching=posMatchPlan(remaining),existingAudits=load('phase4-runtime-20261107-r2/runtime-readonly.json').tables.julyAudits;
 const registry=plan.map(r=>({...r,existingTransactionIds:r.row===395?[1190]:existingAudits.find(a=>a.reason===r.key)?.after_snapshot?.transactionIds||[],existingExpectedSourceKey:approved.bundle.actions.find(a=>a.key===r.key)?.sourceKey||null,existingEvidence:appliedRows.includes(r.row)?approved.bundle.actions.some(a=>a.row===r.row)?'owner_reported_phase4_applied_fresh_resolution_required':'prior_capture_and_owner_applied':'sheet_mapping_reused'}));
 const economicExceptions=remaining.map(r=>({row:r.row,key:r.key,date:r.date,amount:money(volume(r.effects)),economicState:r.phase4Bucket==='pos_card'?'source_match_pending':r.phase4Bucket==='payable'?'payable_allocation_pending':'evidence_or_special_type_pending',reason:r.phase4Reason,mappingNotes:r.mappingNotes,cashImportBlocked:false,financialCloseBlocked:true}));
 const summary={mode:'OFFLINE_SIMULATION_NO_DB_CALLS',baseline:'phase3 read capture + owner-confirmed phase4 nine actions; no fresh production observation',sourceRows:395,alreadyProcessed:154,previousRestoredSourceRows:153,remaining:241,metadataImportRows:fresh.length,newCashRows:cash.length,newMovementLegs:simulated.movements,cashRowVolume:money(cash.reduce((s,r)=>s+volume(r.effects),0n)),referenceOnlyRows:refs.length,referenceVolume:money(refs.reduce((s,r)=>s+volume(r.referenceEffects),0n)),fundDelta:Object.fromEntries(FUNDS.map(f=>[f,money(delta[f])])),netFundChange:money(Object.values(delta).reduce((s,n)=>s+n,0n)),matchesBefore:post.matchedBefore,matchesAfter:post.matchedAfter,targetCells:post.daily.length,residualCells:post.remainingCells,ending:post.daily.filter(d=>d.date==='2026-07-31').map(d=>({account:d.account,balance:d.after,residual:d.difference})),replayNewRows:replay.imported,replayNewMovements:replay.movements,pos:matching.summary,economicExceptions:241,otherEconomicRows:remaining.filter(r=>r.phase4Bucket!=='pos_card').length,newRevenueOrExpensePostings:0,newCardMovementsOrAllocations:0,productionCalls:0,implementationStatus:'PROPOSED_SCHEMA_AND_SMALL_CODE_CHANGES_REQUIRED_NOT_EXECUTABLE',approvals:{dateByDate31:31,rowByRowUpperBound:241,cashBatchDataApproval:1,separateCodeSchemaApproval:1,dateBatchReductionPercent:96.77,rowBatchReductionPercent:99.59},sourceHashes};
 return {summary,registry,fresh,economicExceptions,pos:matching,daily:post.daily};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const root=fileURLToPath(new URL('../../.local/july-restore/',import.meta.url)),out=resolve(process.argv[2]||''),rel=relative(root,out);
 if(!process.argv[2]||!rel||rel.startsWith('..')||isAbsolute(rel)||existsSync(out))throw Error('NEW_LOCAL_OUTPUT_REQUIRED');
 const r=julySimulation(root);mkdirSync(out,{recursive:true});
 for(const [n,data] of Object.entries({summary:r.summary,'source-registry-395':r.registry,'cash-batch-241':r.fresh,'economic-exceptions-241':r.economicExceptions,'pos-match-174':r.pos,'daily-124':r.daily}))writeFileSync(join(out,n+'.json'),JSON.stringify(data,null,2));
 const serial=rows=>rows.map(r=>Object.fromEntries(Object.entries(r).map(([k,v])=>[k,v&&typeof v==='object'?JSON.stringify(v):v])));
 for(const [n,rows,fields] of [['cash-batch-241',r.fresh,['row','key','date','cashStatus','economicStatus','effects','referenceEffects','sourceFingerprint']],['daily-124',r.daily,Object.keys(r.daily[0])],['pos-match-174',r.pos.records,Object.keys(r.pos.records[0])],['economic-exceptions-241',r.economicExceptions,Object.keys(r.economicExceptions[0])]])writeFileSync(join(out,n+'.csv'),csv(fields,serial(rows)));
 const files=['summary.json','source-registry-395.json','cash-batch-241.json','cash-batch-241.csv','economic-exceptions-241.json','economic-exceptions-241.csv','pos-match-174.json','pos-match-174.csv','daily-124.json','daily-124.csv'];writeFileSync(join(out,'verification.json'),JSON.stringify({files:Object.fromEntries(files.map(n=>[n,sha(readFileSync(join(out,n),'utf8'))]))},null,2));
 console.log(JSON.stringify(r.summary,null,2));
}
