// Standard local data manifest/SQL renderer; no DB client or production runner.
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {sha} from './july-restore-phase2.mjs';
import {julySimulation} from './cash-first-simulation.mjs';
import {functionFrom} from './july-restore-rpc-contracts.mjs';
import {parseCsv} from './july-restore-source-review.mjs';
export const migrationName='20261107150007_ledger_historical_cash_import_v1.sql';
export const migrationSource=()=>readFileSync(new URL('../../supabase/migrations/'+migrationName,import.meta.url),'utf8').replaceAll('\r\n','\n');
export function importContracts(){
 const sql=migrationSource();
 return [...sql.matchAll(/create function ([\w.]+)\(([^)]*)\) returns /g)].map(m=>{
  const fn=functionFrom(sql,m[1]);
  return {signature:m[1]+'('+m[2].split(',').filter(Boolean).map(p=>p.trim().split(/\s+/).slice(1).join(' ')).join(',')+')',hash:sha(fn.body),securityDefiner:/security definer/.test(fn.sql.split('as $$')[0])};
 });
}
export function julyCashManifest(root){
 const sim=julySimulation(root),phase4=JSON.parse(readFileSync(join(root,'phase4-final-20261107-r2/bundle.json'),'utf8'));
 const phase2=JSON.parse(readFileSync(join(root,'phase2-final-20261107-r2/bundle.json'),'utf8')),phase3=JSON.parse(readFileSync(join(root,'phase3-final-20261107-r2/bundle.json'),'utf8'));
 const sourceRows=JSON.parse(readFileSync(join(root,'dry-run-20261107-v2/395-row-dry-run.json'),'utf8'));
 const originals=new Map(parseCsv(readFileSync(join(root,'july_2026_395_transactions.csv'),'utf8')).map(r=>[Number(r.sheet_row),r]));
 if(originals.size!==395)throw Error('ORIGINAL_SHEET_SCOPE');
 const rows=sim.registry.map(r=>{
  const source={key:r.key,date:r.date,effects:r.effects,referenceEffects:r.referenceEffects,sourceSnapshot:{original:originals.get(r.row),mapping:sourceRows.find(x=>x.key===r.key)}};
  const a=phase4.bundle.actions.find(a=>a.key===r.key);
  const inventoryIds=[...phase2.bundle.actions.filter(a=>a.key===r.key).map(a=>a.logExpected.id),...phase3.bundle.actions.filter(a=>a.key===r.key).flatMap(a=>a.sources.map(s=>s.logExpected.id))];
  return {...source,row:r.row,sourceRole:sourceRows.find(x=>x.key===r.key).group,cashStatus:r.cashStatus,sourceCanonical:JSON.stringify(source),sourceFingerprint:sha(source),sourceClaims:inventoryIds.map(id=>({kind:'inventory_log',id:String(id)})),...(r.row===395?{knownTransactionId:1190}:{}),...(a?{expectedSourceKey:a.sourceKey,expectedActionHash:a.actionHash}:{})};
 });
 const contracts=importContracts();
 const manifest={version:'cash-import-v1',engineContracts:contracts,profileKey:'sheet-july-2026-cash-v1',period:'2026-07-01',cutoff:'2026-08-01',sourceRows:395,existingRows:154,newCashRows:211,newMovementLegs:278,referenceRows:30,bootstrapClaims:rows.reduce((s,r)=>s+r.sourceClaims.length,0),rows,targets:sim.daily.map(d=>({date:d.date,account:d.account,target:d.target})),fundDelta:sim.summary.fundDelta,closures:phase4.bundle.closures,sourceFiles:sim.summary.sourceHashes};
 const canonical=JSON.stringify(manifest);return {manifest,canonical,digest:sha(canonical),contracts,migrationSha:sha(migrationSource())};
}
const literal=s=>"'"+s.replaceAll("'","''")+"'";
export function renderCashBatch(bundle,mode='apply'){
 if(!['apply','preflight','postflight'].includes(mode))throw Error('MODE');
 const begin=mode==='apply'?'BEGIN;':'BEGIN READ ONLY;';
 const gate=`DO $contract$ DECLARE r jsonb;BEGIN FOR r IN SELECT value FROM jsonb_array_elements(${literal(JSON.stringify(bundle.contracts))}::jsonb) LOOP
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure(r->>'signature') AND encode(sha256(convert_to(replace(prosrc,E'\\r\\n',E'\\n'),'UTF8')),'hex')=r->>'hash' AND prosecdef=(r->>'securityDefiner')::boolean AND array_to_string(proconfig,',') IN('search_path=pg_catalog, public','search_path=pg_catalog,public')) THEN RAISE EXCEPTION 'CASH_IMPORT_ENGINE_CONTRACT: %',r->>'signature';END IF;END LOOP;END $contract$;`;
 const invoke=mode==='apply'?`SELECT public.ledger_import_cash_v1(${literal(bundle.canonical)},'${bundle.digest}',current_setting('baba.cash_import_approval'),current_setting('baba.cash_import_actor')::bigint);`:
 mode==='preflight'?`SELECT public.ledger_preflight_cash_import_v1(${literal(bundle.canonical)},'${bundle.digest}',current_setting('baba.cash_import_actor')::bigint);`:
 `SELECT public.ledger_cash_import_status_v1('${bundle.manifest.period}',current_setting('baba.cash_import_actor')::bigint);
 SELECT public.ledger_preflight_cash_import_v1(${literal(bundle.canonical)},'${bundle.digest}',current_setting('baba.cash_import_actor')::bigint);`;
 return `-- ${mode.toUpperCase()}: structure migration requires separate prior approval; no old phase1-4 SQL.
${begin}
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='90s';
SET LOCAL standard_conforming_strings=on;
SET LOCAL baba.cash_import_actor='__ACTOR_USER_ID__';
${mode==='apply'?"SET LOCAL baba.cash_import_approval='__OWNER_APPROVAL__';\n":''}${gate}
${invoke}
${mode==='apply'?'COMMIT;':'ROLLBACK;'}
`;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const root=fileURLToPath(new URL('../../.local/july-restore/',import.meta.url)),out=resolve(process.argv[2]||''),rel=relative(root,out);
 if(!process.argv[2]||!rel||rel.startsWith('..')||isAbsolute(rel)||existsSync(out))throw Error('NEW_LOCAL_OUTPUT_REQUIRED');
 const bundle=julyCashManifest(root);mkdirSync(out,{recursive:true});
 writeFileSync(join(out,'manifest.json'),JSON.stringify(bundle,null,2));
 for(const mode of ['apply','preflight','postflight'])writeFileSync(join(out,mode==='apply'?'cash-241-REQUIRES-SEPARATE-OWNER-APPROVAL.sql':mode+'-READONLY.sql'),renderCashBatch(bundle,mode));
 writeFileSync(join(out,'verification.json'),JSON.stringify({manifestDigest:bundle.digest,migrationSha:bundle.migrationSha,files:Object.fromEntries(['manifest.json','cash-241-REQUIRES-SEPARATE-OWNER-APPROVAL.sql','preflight-READONLY.sql','postflight-READONLY.sql'].map(n=>[n,sha(readFileSync(join(out,n),'utf8'))]))},null,2));
 console.log(JSON.stringify({digest:bundle.digest,contracts:bundle.contracts.length,migrationSha:bundle.migrationSha,registry:395,newCash:211,newLegs:278,references:30,productionCalls:0}));
}
