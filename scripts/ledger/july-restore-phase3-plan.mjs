// One-off local phase-3 proposal. Reuses phase-2 rows; never executes SQL or loads credentials.
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {APPLIED,WEAK,sha,csv} from './july-restore-phase2.mjs';
import {parseCsv} from './july-restore-source-review.mjs';
import {parseVndMilli as money,formatVndMilli as vnd} from '../../lib/ledger/august-rebuild-plan.ts';
import {rpcContracts} from './july-restore-rpc-contracts.mjs';
const FUNDS=['store_cash','vuong_personal_custody','cho_personal_custody','baba_corporate_bank'];
const ASSET=[7,19,83,94,164,201,250,251,276];
const HISTORY=[133,137,210,270,273,332,372];
const RESOLVED=[9,99,128,209,272,287,317,352];
const logFields=['id','item_id','item_name','item_name_vi','category','category_vi','unit','change_quantity','new_purchase_price','new_supplier','business_date','created_at','source','reason','billed_amount','purchase_supplier_partner_id','correction_of_inventory_log_id','prev_quantity','new_quantity','prev_note','new_note'];
export function extractPhase3(prior,priorCsv,phase2){
 const table=parseCsv(priorCsv),scope=prior.filter(r=>r.state==='needs_link');
 const csvKeys=table.filter(r=>r.state==='needs_link').map(r=>r.key).sort();
 if(JSON.stringify(csvKeys)!==JSON.stringify(scope.map(r=>r.key).sort()))throw Error('CSV_JSON_SCOPE_DRIFT');
 const completed=[...APPLIED,...phase2.bundle.actions.map(a=>a.row),395];
 if(new Set(completed).size!==83||scope.some(r=>completed.includes(r.row)))throw Error('COMPLETED_SCOPE');
 const remaining=prior.filter(r=>!completed.includes(r.row));
 if(prior.length!==345||remaining.length!==312||scope.length!==95||remaining.filter(r=>r.state==='hold').length!==217)throw Error('PRIOR_SCOPE_DRIFT');
 return {scope,remaining,completed};
}
const norm=s=>(s||'').trim().toLowerCase();
const calc=l=>vnd(money(String(Math.round(Number(l.change_quantity)*Number(l.new_purchase_price)*1000)/1000)));
export function phase3Plan(prior,priorCsv,phase2,capture){
 const {scope,remaining,completed}=extractPhase3(prior,priorCsv,phase2);
 if(capture.status!=='CAPTURED'||!capture.readOnly||capture.requests.some(r=>r.method!=='GET'||![200,206].includes(r.http)))throw Error('READ_EVIDENCE_INCOMPLETE');
 const t=capture.tables,logs=new Map(t.inventoryLogs.map(l=>[l.id,l])),allTx=[...t.julyTransactions,...t.directTransactions];
 const keysDone=prior.filter(r=>phase2.bundle.actions.some(a=>a.row===r.row)).map(r=>r.key);
 for(const k of keysDone)if(t.julyAudits.filter(a=>a.reason===k).length!==1)throw Error('PHASE2_APPLIED_AUDIT_NOT_PRESENT');
 if(t.julyTransactions.filter(x=>x.id>=4227&&x.id<=4275&&x.status==='confirmed').length!==49||t.julyTransactions.filter(x=>x.id>=4292&&x.id<=4324&&x.status==='confirmed').length!==33)throw Error('COMPLETED_LEDGER_NOT_CONFIRMED');
 const owners=new Map();for(const r of scope)for(const id of [...r.inventoryIds,...r.correctionIds]){const a=owners.get(id)||[];a.push(r.row);owners.set(id,a);}
 const actions=[];
 const rows=scope.map(r=>{
  const row={...r,phase3State:'evidence_needed',phase3Reasons:[],resolution:[],workflow:null};
  const src=[...r.inventoryIds,...r.correctionIds].map(id=>logs.get(id));
  if(src.some(l=>!l)){row.phase3Reasons=['SOURCE_MISSING'];return row;}
  row.logDetails=src.map(l=>({id:l.id,item:l.item_name||l.item_name_vi,itemId:l.item_id,quantity:l.change_quantity,sourceDate:l.business_date,supplier:l.new_supplier,sourceAmount:calc(l),noteInherited:l.prev_note===l.new_note}));
  row.calculatedAmount=vnd(src.reduce((s,l)=>s+money(calc(l)),0n));row.sheetMinusCalculated=vnd(money(r.paid)-money(row.calculatedAmount));
  if(WEAK.includes(r.row)){row.phase3Reasons=['OWNER_WEAK_SIX_NO_NEW_PAYMENT_PROOF'];return row;}
  if(ASSET.includes(r.row)){row.phase3State='separate_hold';row.phase3Reasons=['COST_VERSUS_DURABLE_EQUIPMENT_UNCONFIRMED'];return row;}
  if(HISTORY.includes(r.row)){
   row.phase3State='linked_restricted';row.phase3Reasons=[r.row===133||r.row===270?'SUPPLIER_PREPAYMENT_ACCOUNT_PERIOD':'PAYABLE_RPC_ACCOUNT_ACTIVE_FROM_AUGUST'];
   row.resolution=['SOURCE_IDENTIFIED','RECEIPT_AND_PAYMENT_DATES_SEPARATED'];return row;
  }
  if(r.evidenceClass!=='A'&&!RESOLVED.includes(r.row)){row.phase3Reasons=[...r.blockers.filter(b=>!['MULTI_LOG_INVOICE_BATCH_REQUIRED','CATEGORY_NOT_UNIQUE','SHEET_PRICE_OVERRIDE_REVIEW'].includes(b))];return row;}
  if(RESOLVED.includes(r.row)){
   if([9,99,209,272,287,317,352].includes(r.row)&&src.some(l=>l.prev_note!==l.new_note)){row.phase3Reasons=['NEW_NOTE_IS_NOT_INHERITED'];return row;}
   row.resolution.push(r.row===128?'OTHER_LOG_NOT_ALLOCATED':'INHERITED_NOTE_NOT_CURRENT_PURCHASE_EVENT');
   if([99,272,287,317,352].includes(r.row))row.resolution.push('PRIOR_WOW_SPIRIT_GROUP_REUSED');
  }
  const bad=row.phase3Reasons;
  if(src.some(l=>l.business_date!==r.date))bad.push('RECEIPT_PAYMENT_DATE_DIFFERENCE');
  if(src.some(l=>l.reason!=='purchase'||l.billed_amount!==null||l.purchase_supplier_partner_id!==null||l.correction_of_inventory_log_id!==null))bad.push('SOURCE_METADATA_CHANGED');
  if(r.inventoryIds.some(id=>Number(logs.get(id).change_quantity)<=0)||r.correctionIds.some(id=>Number(logs.get(id).change_quantity)>=0))bad.push('SOURCE_SIGN');
  if(src.some(l=>Math.abs(Number(l.new_quantity)-Number(l.prev_quantity)-Number(l.change_quantity))>0.000001))bad.push('SOURCE_QUANTITY_INCONSISTENT');
  if(src.some(l=>owners.get(l.id).length!==1))bad.push('CROSS_ROW_LOG_DUPLICATE');
  if(t.linkedCorrections.some(l=>r.inventoryIds.includes(l.correction_of_inventory_log_id)))bad.push('NEW_LINKED_CORRECTION');
  const sourceKeys=r.inventoryIds.map(id=>'inventory-log:'+id);
  if(t.candidates.some(c=>sourceKeys.includes(c.source_key))||allTx.some(x=>r.inventoryIds.includes(Number(x.source_snapshot?.inventory_log_id))))bad.push('EXISTING_SOURCE_COST');
  if(t.projection.some(p=>r.inventoryIds.includes(p.inventory_log_id)))bad.push('EXISTING_SOURCE_PROJECTION');
  if(t.julyAudits.some(a=>a.reason===r.key)||allTx.some(x=>x.source_key==='july-restore:'+r.key))bad.push('EXISTING_ROW_KEY');
  // Known restored rows have their own source audit; equal date/amount alone is
  // not duplication (e.g. banana and ice). A NEW unlinked equal payment needs review.
  if(t.julyTransactions.some(x=>x.status==='confirmed'&&x.business_date===r.date&&money(String(x.amount))===money(r.paid)
   &&!t.julyAudits.some(a=>a.entity_id===x.id)&&t.movements.some(m=>m.transaction_id===x.id&&r.effects.some(e=>t.accounts.find(f=>f.id===m.fund_account_id)?.code===e.account&&money(String(m.amount))===money(e.amount)))))bad.push('UNLINKED_EXISTING_PAYMENT');
  const parties=[...new Set(src.flatMap(l=>t.supplierMappings.filter(m=>m.is_active&&norm(m.supplier_name)===norm(l.new_supplier)).map(m=>m.party_id)))];
  if(parties.length!==1||!t.parties.some(p=>p.id===parties[0]&&p.is_active))bad.push('PARTY_NOT_UNIQUE');
  if(t.payables.some(p=>parties.includes(p.party_id)&&p.status!=='cancelled'))bad.push('HISTORICAL_PAYABLE');
  if(r.effects.some(e=>!FUNDS.includes(e.account)||money(e.amount)>=0n||!t.accounts.some(a=>a.code===e.account&&a.is_active&&a.is_business_fund)))bad.push('FUND_ACCOUNT');
  if(src.some(l=>!t.inventoryItems.some(i=>i.id===l.item_id)))bad.push('ITEM_MISSING');
  const sources=src.map(l=>{
   const categories=t.categoryMappings.filter(m=>m.is_active&&norm(m.inventory_category)===norm(l.category)).map(m=>m.ledger_category_id);
   if(categories.length!==1||!t.categories.some(c=>c.id===categories[0]&&c.is_active&&c.kind==='expense'))bad.push('SOURCE_CATEGORY');
   return {logExpected:Object.fromEntries(logFields.map(k=>[k,l[k]??null])),amount:calc(l),categoryId:categories[0],correction:r.correctionIds.includes(l.id)};
  });
  if(bad.length)return row;
  const exact=row.sheetMinusCalculated==='0'&&!r.correctionIds.length;
  let workflow=exact?'canonical_components':'sheet_paid_group';
  const categories=[...new Set(sources.filter(s=>!s.correction).map(s=>s.categoryId))];
  const groupCategoryId=categories.length===1?categories[0]:r.row===53?34:null;
  if(!exact&&(!groupCategoryId||r.effects.length!==1)){row.phase3State='linked_restricted';bad.push('GROUP_COST_CATEGORY_OR_FUND_SPLIT');return row;}
  // Consumable goods already identified in the old mapping: no capitalization
  // threshold is inferred. Durable/ambiguous items are the explicit ASSET holds.
  if(r.group==='manual_candidate')row.resolution.push('CONSUMABLE_GOODS_IDENTIFIED_FROM_ITEM');
  if(exact){
   for(const s of sources){
    if(r.effects.length===1)s.account=r.effects[0].account;
    else if(r.row===352)s.account=s.logExpected.id===7979?'cho_personal_custody':'baba_corporate_bank';
    else {row.phase3State='linked_restricted';bad.push('COMPONENT_FUND_ASSIGNMENT');return row;}
   }
   for(const e of r.effects)if(sources.filter(s=>s.account===e.account).reduce((a,s)=>a+money(s.amount),0n)!==-money(e.amount))throw Error('COMPONENT_FUND_TOTAL');
  }else row.resolution.push('SHEET_PAID_TOTAL_NO_ITEM_PRICE_ALLOCATION','SOURCE_CLAIMS_DISMISSED_AS_ALREADY_GROUPED_COST');
  row.phase3State='ready';row.workflow=workflow;
  row.resolution.push(exact?'MULTI_LOG_COMPONENTS_SUM_TO_SHEET':'ONE_SHEET_COST_WITH_ORIGINAL_SOURCE_VALUES');
  const action={row:r.row,key:r.key,sourceKey:'july-restore:'+r.key,date:r.date,amount:r.paid,effects:r.effects,partyId:parties[0],groupCategoryId,workflow,sources,calculatedAmount:row.calculatedAmount,sheetMinusCalculated:row.sheetMinusCalculated};
  actions.push({...action,actionHash:sha(action)});return row;
 });
 const fundDelta=Object.fromEntries(FUNDS.map(k=>[k,'0']));for(const a of actions)for(const e of a.effects)fundDelta[e.account]=vnd(money(fundDelta[e.account])+money(e.amount));
 const contracts=rpcContracts();
 const bundle={profile:'july-phase3-source-groups',completedRows:completed.sort((a,b)=>a-b),actions,fundDelta,
  rpcContracts:Object.values(contracts).map(c=>({signature:c.signature,hash:c.hash})),closures:t.closures.filter(c=>c.month>='2026-08-01'&&c.month<='2026-10-01'),cardCarryoverBlocked:'-6102347'};
 if(bundle.closures.length!==3)throw Error('CLOSURES');
 const canonical=JSON.stringify(bundle),payload={bundle,bundleCanonical:canonical,bundleDigest:sha(canonical)};
 const byState=Object.fromEntries(['ready','linked_restricted','evidence_needed','separate_hold'].map(state=>{const a=rows.filter(r=>r.phase3State===state);return[state,{rows:a.length,paid:vnd(a.reduce((s,r)=>s+money(r.paid),0n)),sourceRows:a.map(r=>r.row)}]}));
 return {rows,remaining:remaining.map(r=>rows.find(a=>a.row===r.row)||r),payload,summary:{byState,cohort:rows.length,paid:vnd(rows.reduce((s,r)=>s+money(r.paid),0n)),remaining:remaining.length,unchangedHeld217:217,fundDelta,httpCalls:capture.requests.length,workflows:Object.fromEntries(['canonical_components','sheet_paid_group'].map(w=>[w,actions.filter(a=>a.workflow===w).length])),bundleDigest:payload.bundleDigest}};
}
export function renderPhase3(payload){
 if(!payload.bundle.actions.length)throw Error('NO_READY_ROWS');
 const canonical=JSON.stringify(payload),literal="'"+canonical.replaceAll("'","''")+"'";
 return readFileSync(new URL('./july-restore-phase3-batch.sql',import.meta.url),'utf8').replaceAll('__PAYLOAD_LITERAL__',()=>literal).replaceAll('__PAYLOAD_DIGEST__',sha(canonical)).replaceAll('__EXACT_ROWS__',payload.bundle.actions.map(a=>a.row).join(','));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const root=fileURLToPath(new URL('../../.local/july-restore/',import.meta.url)),out=resolve(process.argv[2]||''),capturePath=resolve(process.argv[3]||'');
 for(const p of [out,capturePath]){const r=relative(root,p);if(!r||r.startsWith('..')||isAbsolute(r))throw Error('WORKTREE_LOCAL_REQUIRED');}if(existsSync(out))throw Error('NEW_OUTPUT_REQUIRED');
 const priorRoot=join(root,'phase2-final-20261107-r2'),prior=JSON.parse(readFileSync(join(priorRoot,'reviewed-345.json'),'utf8')),priorCsv=readFileSync(join(priorRoot,'remaining-345-status.csv'),'utf8'),phase2=JSON.parse(readFileSync(join(priorRoot,'bundle.json'),'utf8'));
 const result=phase3Plan(prior,priorCsv,phase2,JSON.parse(readFileSync(capturePath,'utf8')));
 mkdirSync(out,{recursive:true});for(const [name,obj] of [['reviewed-95.json',result.rows],['remaining-312.json',result.remaining],['bundle.json',result.payload],['summary.json',result.summary]])writeFileSync(join(out,name),JSON.stringify(obj,null,2));
 const fields=['row','key','date','paid','effects','state','phase3State','phase3Reasons','blockers','workflow','inventoryIds','correctionIds','excludedIds','calculatedAmount','sheetMinusCalculated','resolution','logDetails','mappingNotes','previousPosLink'];
 const flatten=r=>Object.fromEntries(fields.map(k=>[k,typeof r[k]==='object'?JSON.stringify(r[k]):r[k]??'']));
 writeFileSync(join(out,'source-review-95.csv'),csv(fields,result.rows.map(flatten)));writeFileSync(join(out,'remaining-312-status.csv'),csv(fields,result.remaining.map(r=>flatten({...r,phase3State:r.phase3State||'prior_hold_217',phase3Reasons:r.phase3Reasons||r.blockers||[]}))));
 writeFileSync(join(out,'next-batch-REQUIRES-OWNER-DB-APPROVAL.sql'),renderPhase3(result.payload));console.log(JSON.stringify(result.summary));
}
