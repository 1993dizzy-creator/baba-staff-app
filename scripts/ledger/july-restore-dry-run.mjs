// Offline only. Never loads env files or executes SQL / connects to a database.
// node --experimental-strip-types scripts/ledger/july-restore-dry-run.mjs <bundle.json> <output-directory>
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {planJulyRestore,rowKey,digest,stable} from '../../lib/ledger/july-restore-plan.ts';

const reviewed49Digest='72ef76c0716d488ee2372259f742087c375ee33550acc3b0cb418c26b1b62a8d';
const reviewed49Rows=[11,17,30,43,45,56,67,91,95,96,108,125,126,136,147,163,173,185,191,193,198,216,220,221,225,236,238,249,258,262,275,277,282,284,291,298,302,306,311,314,319,331,340,353,357,363,368,374,381];
const reviewed49Contract={rows:reviewed49Rows,fundDelta:{store_cash:-15650800,vuong_personal_custody:-50000,cho_personal_custody:4570800,baba_corporate_bank:-94655}};

export function renderJulyBatch(bundle,plan) {
  if(plan.status!=='REVIEWABLE') throw Error('SOURCE_BUNDLE_BLOCKED');
  if(plan.digest!==digest(bundle))throw Error('BUNDLE_DIGEST_MISMATCH');
  const safe49=Boolean(bundle.runtimePreflight);
  if(safe49&&plan.digest!==reviewed49Digest)throw Error('REVIEWED_49_BUNDLE_REQUIRED');
  const openings=[['store_cash',4207,'202299186'],['vuong_personal_custody',4208,'16123010'],['cho_personal_custody',4209,'850041'],['baba_corporate_bank',4210,'381587580']]
    .map(([account,id,amount])=>({account,id,amount}));
  // Opening IDs must be read from approved live evidence. The pre-seed evidence
  // in Git has no IDs yet; never assume the four IDs map to this account order.
  if(!Array.isArray(bundle.openings)||bundle.openings.length!==4 || openings.some(x=>!bundle.openings.some(y=>y.account===x.account&&y.amount===x.amount&&[4207,4208,4209,4210].includes(y.id)))||new Set(bundle.openings.map(x=>x.id)).size!==4) throw Error('APPROVED_OPENING_ID_MAPPING_REQUIRED');
  const payload={status:plan.status,sourceRows:plan.sourceRows,bundleDigest:plan.digest,openings:bundle.openings,fullRestoreReady:plan.fullRestoreReady,daily:plan.daily,
    ...(bundle.runtimePreflight?{runtimePreflight:bundle.runtimePreflight}:{}),
    actions:plan.decisions.filter(d=>['ready','linked'].includes(d.status)).map(d=>({...d.action,rows:bundle.rows.filter(r=>d.action.rowNumbers.includes(r.row)).map(r=>({...r,key:rowKey(r)}))}))};
  if(!payload.actions.length) throw Error('NO_REVIEWED_ACTIONS');
  if(safe49){
    const rows=payload.actions.flatMap(a=>a.rows.map(r=>r.row)).sort((a,b)=>a-b);
    if(payload.actions.length!==49||!rows.every((r,i)=>r===reviewed49Rows[i])||rows.length!==49)throw Error('REVIEWED_49_ROWS_REQUIRED');
    payload.batch49Contract=reviewed49Contract;
  }
  const canonical=stable(payload),payloadDigest=digest(payload),quote=s=>"'"+s.replaceAll("'","''")+"'";
  let sql=readFileSync(new URL('./july-restore-batch.sql',import.meta.url),'utf8');
  sql=sql.replace('__REVIEWED_PAYLOAD__',()=>quote(canonical)+'::jsonb,'+quote(canonical));
  sql=sql.replaceAll('__SAFE49_PROFILE__',String(safe49)).replaceAll('__APPROVED_BUNDLE_DIGEST__',plan.digest).replaceAll('__APPROVED_PAYLOAD_DIGEST__',payloadDigest);
  sql=sql.replaceAll('__APPROVED_49_CONTRACT__',JSON.stringify(reviewed49Contract));
  return sql;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const [, ,input,out]=process.argv;
  if(!input||!out) throw Error('Usage: <bundle.json> <new-output-directory>');
  const output=resolve(out),rel=relative(fileURLToPath(new URL('../../.local/',import.meta.url)),output);
  if(!rel||rel.startsWith('..')||isAbsolute(rel))throw Error('WORKTREE_LOCAL_OUTPUT_REQUIRED');
  if(existsSync(output))throw Error('OUTPUT_ALREADY_EXISTS');
  const bundle=JSON.parse(readFileSync(input,'utf8'));const plan=planJulyRestore(bundle);
  mkdirSync(output,{recursive:true});
  writeFileSync(join(output,'dry-run.json'),JSON.stringify(plan,null,2));
  let executionStatus='BLOCKED';
  if(plan.status==='REVIEWABLE') {
    try {writeFileSync(join(output,'batch-REQUIRES-SEPARATE-APPROVAL.sql'),renderJulyBatch(bundle,plan));executionStatus='REVIEW_REQUIRED';}
    catch(error){writeFileSync(join(output,'execution-blocker.txt'),String(error.message));}
  }
  console.log(JSON.stringify({status:plan.status,executionStatus,sourceRows:plan.sourceRows,counts:plan.counts,byClass:plan.byClass,dailyMatches:plan.daily.filter(x=>x.matches).length,blockers:plan.blockers}));
  if(plan.status==='BLOCKED'||executionStatus==='BLOCKED')process.exitCode=2;
}
