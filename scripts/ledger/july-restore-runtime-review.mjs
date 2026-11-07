// Offline only. Reuse 6d290d39 results + GET observations, never rescan 710 logs.
// node --experimental-strip-types <this-file> <input-root> <runtime-folder> <new-output-folder>
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {reviewJulyRuntime} from '../../lib/ledger/july-restore-runtime-review.mjs';
import {parseCsv} from './july-restore-source-review.mjs';
import {digest,JULY_SHEET,JULY_TAB} from '../../lib/ledger/july-restore-plan.ts';
import {renderJulyBatch} from './july-restore-dry-run.mjs';
const [, ,inputArg,runtimeArg,outArg]=process.argv;
if(!inputArg||!runtimeArg||!outArg)throw Error('Usage: <inputs> <GET-runtime-folder> <new-output-folder>');
const input=resolve(inputArg),runtime=resolve(runtimeArg),out=resolve(outArg),rel=relative(input,out);
if(!rel||rel.startsWith('..')||isAbsolute(rel)||existsSync(out))throw Error('NEW_REFERENCE_SUBFOLDER_REQUIRED');
const read=(folder,name)=>JSON.parse(readFileSync(join(folder,name),'utf8'));
const baselineDir=join(input,'dry-run-20261107-v2'),baseline=read(baselineDir,'395-row-dry-run.json'),oldSummary=read(baselineDir,'summary.json');
// Fingerprint comparison only. Do not rerun the old source mapping or 31-day math.
for(const [name,expected]of Object.entries(oldSummary.sourceFiles))if(createHash('sha256').update(readFileSync(join(input,name))).digest('hex')!==expected.sha256)throw Error('BASELINE_SOURCE_CHANGED');
const snapshot=read(runtime,'runtime-readonly.json');
const extra=existsSync(join(runtime,'runtime-extra.json'))?read(runtime,'runtime-extra.json'):{capturedAt:snapshot.completedAt,httpCalls:0,rows:{rowAudits:snapshot.tables.rowAudits,julyClosures:snapshot.tables.julyClosures,juneCardLedger:snapshot.tables.juneCardLedger}};
const labels=existsSync(join(runtime,'pos-receipt-labels.json'))?read(runtime,'pos-receipt-labels.json'):{capturedAt:snapshot.completedAt,httpCalls:0,rows:snapshot.tables.posReceiptsJuneJuly.filter(r=>r.business_date>='2026-07-01')};
const review=reviewJulyRuntime(baseline,snapshot,extra.rows,labels.rows);
const byRow=new Map(review.candidates.map(c=>[c.row,c]));
const rowAmount=r=>{
 const positive=r.effects.filter(e=>BigInt(e.amount)>0n).reduce((s,e)=>s+BigInt(e.amount),0n);
 const negative=r.effects.filter(e=>BigInt(e.amount)<0n).reduce((s,e)=>s-BigInt(e.amount),0n);
 return String(positive>negative?positive:negative);
};
const targets=parseCsv(readFileSync(join(baselineDir,'31-day-reconciliation.csv'),'utf8')).filter(r=>r.account!=='card_clearing');
const bundle={version:1,sheetId:JULY_SHEET,tabId:JULY_TAB,mappingReference:'6d290d39:reused-395-row-dry-run',capturedAt:snapshot.capturedAt,legacyInventorySplit:'aggregate_only',
 rows:baseline.map(r=>({sheetId:JULY_SHEET,tabId:JULY_TAB,row:r.row,date:r.date,classification:r.group,amount:rowAmount(r),effects:r.effects,mappingReference:r.key,sourceRefs:[]})),
 actions:baseline.map(r=>byRow.get(r.row)?.action??{key:`hold-row-${r.row}`,rowNumbers:[r.row],kind:'hold',date:r.date,amount:rowAmount(r),effects:r.effects,economicKey:r.key,evidence:'6d290d39 hold preserved'}),
 dailyTargets:[...new Set(targets.map(r=>r.date))].map(date=>({date,closing:Object.fromEntries(targets.filter(r=>r.date===date).map(r=>[r.account,r.targetClosing]))})),
 runtimePreflight:{
   transactions:snapshot.tables.julyTransactions.map(t=>Object.fromEntries(['id','type','status','business_date','recognition_month','amount','category_id','source_type','source_key'].map(k=>[k,t[k]]))).sort((a,b)=>a.id-b.id),
   movements:[...snapshot.tables.julyMovements].sort((a,b)=>a.id-b.id),
   candidates:[...snapshot.tables.julyCandidates].sort((a,b)=>a.id-b.id),
   accounts:[...snapshot.tables.accounts].sort((a,b)=>a.id-b.id),
   categories:snapshot.tables.categories.filter(c=>review.candidates.some(r=>r.status==='ready'&&r.categoryId===c.id)).map(c=>({id:c.id,name:c.name,kind:c.kind,is_active:c.is_active})).sort((a,b)=>a.id-b.id),
 },
 openings:snapshot.tables.julyTransactions.filter(t=>[4207,4208,4209,4210].includes(t.id)).map(t=>{
   const movements=snapshot.tables.julyMovements.filter(m=>m.transaction_id===t.id);
   if(movements.length!==1)throw Error('OPENING_MOVEMENT_DRIFT');
   return {id:t.id,account:snapshot.tables.accounts.find(a=>a.id===movements[0].fund_account_id)?.code,amount:String(t.amount)};
 })};
const plan={status:'REVIEWABLE',sourceRows:395,digest:digest(bundle),fullRestoreReady:false,daily:targets.map(r=>({date:r.date,account:r.account,target:r.targetClosing})),
 decisions:review.candidates.filter(c=>c.status==='ready').map(c=>({status:'ready',action:c.action}))};
const sql=renderJulyBatch(bundle,plan);
review.summary.runtimeHttpCalls=snapshot.requests.length+labels.httpCalls+extra.httpCalls;
review.summary.preliminaryAccountGetCalls=1;
review.summary.readyManifestDigest=plan.digest;
review.summary.observationHashes={runtime:digest(snapshot),extra:digest(extra),labels:digest(labels)};
mkdirSync(out,{recursive:true});
for(const [name,value]of Object.entries({'runtime-summary.json':review.summary,'82-candidate-decisions.json':review.candidates,'148-source-links.json':{links:review.links,unresolved:review.unresolved},'noncard-day-groups.json':review.dayGroups,'safe-subset-bundle.json':bundle}))writeFileSync(join(out,name),JSON.stringify(value,null,2));
writeFileSync(join(out,'safe-subset-REQUIRES-SEPARATE-DB-APPROVAL.sql'),sql);
console.log(JSON.stringify(review.summary,null,2));
