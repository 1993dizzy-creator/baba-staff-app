// Offline only. Never loads env files or executes SQL / connects to a database.
// node --experimental-strip-types scripts/ledger/july-restore-dry-run.mjs <bundle.json> <output-directory>
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {planJulyRestore,rowKey} from '../../lib/ledger/july-restore-plan.ts';

export function renderJulyBatch(bundle,plan) {
  if(plan.status!=='REVIEWABLE') throw Error('SOURCE_BUNDLE_BLOCKED');
  const openings=[['store_cash',4207,'202299186'],['vuong_personal_custody',4208,'16123010'],['cho_personal_custody',4209,'850041'],['baba_corporate_bank',4210,'381587580']]
    .map(([account,id,amount])=>({account,id,amount}));
  // Opening IDs must be read from approved live evidence. The pre-seed evidence
  // in Git has no IDs yet; never assume the four IDs map to this account order.
  if(!Array.isArray(bundle.openings)||bundle.openings.length!==4 || openings.some(x=>!bundle.openings.some(y=>y.account===x.account&&y.amount===x.amount&&[4207,4208,4209,4210].includes(y.id)))||new Set(bundle.openings.map(x=>x.id)).size!==4) throw Error('APPROVED_OPENING_ID_MAPPING_REQUIRED');
  const payload={status:plan.status,sourceRows:plan.sourceRows,bundleDigest:plan.digest,openings:bundle.openings,fullRestoreReady:plan.fullRestoreReady,daily:plan.daily,
    actions:plan.decisions.filter(d=>['ready','linked'].includes(d.status)).map(d=>({...d.action,rows:bundle.rows.filter(r=>d.action.rowNumbers.includes(r.row)).map(r=>({...r,key:rowKey(r)}))}))};
  if(!payload.actions.length) throw Error('NO_REVIEWED_ACTIONS');
  let sql=readFileSync(new URL('./july-restore-batch.sql',import.meta.url),'utf8');
  sql=sql.replace('__REVIEWED_PAYLOAD__',()=>"'"+JSON.stringify(payload).replaceAll("'","''")+"'::jsonb");
  return sql;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const [, ,input,out]=process.argv;
  if(!input||!out) throw Error('Usage: <bundle.json> <new-output-directory>');
  const output=resolve(out);if(existsSync(output))throw Error('OUTPUT_ALREADY_EXISTS');
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
