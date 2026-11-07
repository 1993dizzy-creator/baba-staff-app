// Local proposal renderer only. No database client, credential loading or executor.
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {reconstruct,reviewRuntime,summary,sha,csv,APPLIED,WEAK} from './july-restore-phase2.mjs';
import {parseVndMilli,formatVndMilli} from '../../lib/ledger/august-rebuild-plan.ts';
const FUNDS=['store_cash','vuong_personal_custody','cho_personal_custody','baba_corporate_bank'];
// Owner-observed 2026-11-07 production prosrc SHA-256 (CRLF -> LF).
// Reproduced from the source-lock and payment-verification migration patches.
export const PHASE2_RESOLVER_BODY_DIGEST='edcfb9d5429307c6fa0690d8d89cfa005b02b8fd13749fab480793b32ed7c4d5';
const logFields=['id','item_id','item_name','item_name_vi','category','category_vi','unit','change_quantity','new_purchase_price','new_supplier','business_date','created_at','source','reason','billed_amount','purchase_supplier_partner_id','correction_of_inventory_log_id'];
export function planPhase2(reconstructed,capture){
 const rows=reviewRuntime(reconstructed,capture),ready=rows.filter(r=>r.state==='ready');
 const fundDelta=Object.fromEntries(FUNDS.map(k=>[k,'0']));
 const actions=ready.map(r=>{
  if(APPLIED.includes(r.row)||r.row===395||WEAK.includes(r.row)||r.inventoryIds.length!==1||r.correctionIds.length||r.effects.length!==1)throw Error('READY_SCOPE');
  const log=capture.tables.inventoryLogs.find(l=>l.id===r.inventoryIds[0]);
  const action={row:r.row,key:r.key,sourceKey:'july-restore:'+r.key,date:r.date,amount:r.paid,
   account:r.effects[0].account,categoryId:r.categoryIds[0],partyId:r.partyIds[0],
   logExpected:Object.fromEntries(logFields.map(k=>[k,log[k]??null]))};
  if(!FUNDS.includes(action.account))throw Error('FUND_SCOPE');
  fundDelta[action.account]=formatVndMilli(parseVndMilli(fundDelta[action.account])-parseVndMilli(action.amount));
  return {...action,actionHash:sha(action)};
 });
 const bundle={profile:'july-phase2-single-log-immediate',actions,fundDelta,closures:capture.tables.closures.filter(c=>c.month>='2026-08-01'&&c.month<='2026-10-01'),cardCarryoverBlocked:'-6102347'};
 if(bundle.closures.length!==3)throw Error('CLOSURE_EVIDENCE');
 const bundleCanonical=JSON.stringify(bundle),payload={bundle,bundleCanonical,bundleDigest:sha(bundleCanonical)};
 return {rows,payload,summary:{...summary(rows),readyFundDelta:fundDelta,readyRows:ready.map(r=>r.row),httpCalls:capture.requests.length,readCapturedAt:capture.capturedAt,bundleDigest:payload.bundleDigest}};
}
export function renderPhase2(payload){
 if(!payload.bundle.actions.length)throw Error('NO_READY_ACTIONS');
 const canonical=JSON.stringify(payload),literal="'"+canonical.replaceAll("'","''")+"'";
 let sql=readFileSync(new URL('./july-restore-phase2-batch.sql',import.meta.url),'utf8');
 const replacements={__PAYLOAD_LITERAL__:literal,__PAYLOAD_DIGEST__:sha(canonical),__EXACT_ROWS__:payload.bundle.actions.map(a=>a.row).join(','),__RESOLVER_BODY_DIGEST__:PHASE2_RESOLVER_BODY_DIGEST};
 for(const [k,v] of Object.entries(replacements))sql=sql.replaceAll(k,v);
 return sql;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const root=fileURLToPath(new URL('../../.local/july-restore/',import.meta.url));
 const out=resolve(process.argv[2]||''),capturePath=resolve(process.argv[3]||'');
 for(const p of [out,capturePath]){const rel=relative(root,p);if(!rel||rel.startsWith('..')||isAbsolute(rel))throw Error('WORKTREE_LOCAL_REQUIRED');}
 if(existsSync(out))throw Error('NEW_LOCAL_OUTPUT_REQUIRED');
 const source=JSON.parse(readFileSync(join(root,'dry-run-20261107-v2/395-row-dry-run.json'),'utf8'));
 const capture=JSON.parse(readFileSync(capturePath,'utf8')),result=planPhase2(reconstruct(source),capture);
 const previous=JSON.parse(readFileSync(join(root,'runtime-review-20261107-final/148-source-links.json'),'utf8'));
 for(const row of result.rows){const old=previous.links.find(l=>l.row===row.row);if(old)row.previousPosLink=old;}
 mkdirSync(out,{recursive:true});
 for(const [name,data] of [['reviewed-345.json',result.rows],['summary.json',result.summary],['bundle.json',result.payload]])writeFileSync(join(out,name),JSON.stringify(data,null,2));
 const flat=result.rows.map(r=>({...r,effects:JSON.stringify(r.effects),inventoryIds:r.inventoryIds.join(';'),correctionIds:r.correctionIds.join(';'),excludedIds:r.excludedIds.join(';'),blockers:r.blockers.join(';'),logDetails:JSON.stringify(r.logDetails||[]),previousPosLink:JSON.stringify(r.previousPosLink||null)}));
 const headers=['row','key','date','group','effects','paid','evidenceClass','state','inventoryIds','correctionIds','excludedIds','calculatedAmount','sheetMinusCalculated','blockers','logDetails','mappingNotes','previousPosLink'];
 writeFileSync(join(out,'mapping.csv'),csv(headers,flat.filter(r=>r.inventoryIds)));
 writeFileSync(join(out,'remaining-345-status.csv'),csv(headers,flat));
 if(result.payload.bundle.actions.length)writeFileSync(join(out,'next-batch-REQUIRES-OWNER-DB-APPROVAL.sql'),renderPhase2(result.payload));
 console.log(JSON.stringify(result.summary));
}
