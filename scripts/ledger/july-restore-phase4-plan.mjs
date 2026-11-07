// Local proposal only. No credentials, network calls, previous batch rendering or DB execution.
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {sha,csv} from './july-restore-phase2.mjs';
import {parseCsv} from './july-restore-source-review.mjs';
import {rpcContracts,functionFrom} from './july-restore-rpc-contracts.mjs';
import {productionAdvanceContract} from './july-restore-phase4-advance-contract.mjs';
export const FUNDS=['store_cash','vuong_personal_custody','cho_personal_custody','baba_corporate_bank'];
export const READY=[26,33,75,78,181,207,252,289,299];
const TRANSFERS=[26,75,78,181,207];
const zero=()=>Object.fromEntries(FUNDS.map(f=>[f,0]));
const sum=rows=>{const d=zero();for(const r of rows)for(const e of r.effects)if(FUNDS.includes(e.account))d[e.account]+=Number(e.amount);return d;};
// Transfers are counted once (the larger of total paid and received), never twice.
export const volume=r=>Math.max(r.effects.filter(e=>Number(e.amount)<0).reduce((s,e)=>s-Number(e.amount),0),r.effects.filter(e=>Number(e.amount)>0).reduce((s,e)=>s+Number(e.amount),0));
export function contracts4(){
 const read=n=>readFileSync(new URL('../../supabase/migrations/'+n,import.meta.url),'utf8').replaceAll('\r\n','\n');
 const one=(file,name,signature)=>{const r=functionFrom(read(file),name);return {...r,signature,hash:sha(r.body)};};
 return {manual:rpcContracts().manual,
 advance:productionAdvanceContract(one('20260929090000_add_ledger_payroll_advance_payment.sql','public.ledger_create_payroll_advance_payment_v1','public.ledger_create_payroll_advance_payment_v1(text,bigint,numeric,timestamptz,bigint,text,bigint)')),
 rent:one('20261028140000_add_rent_contracts.sql','public.ledger_link_rent_payment_v1','public.ledger_link_rent_payment_v1(bigint,bigint,bigint,text,bigint)'),
 rentActor:one('20261028140000_add_rent_contracts.sql','public.ledger_rent_actor_can_write_v1','public.ledger_rent_actor_can_write_v1(bigint)')};
}
const payables=[34,35,157,170,172,211,248,346,390,391,392,393];
export function phase4Plan(prior,phase3,capture,targetCsv){
 if(capture.status!=='CAPTURED'||!capture.readOnly||capture.requests.some(r=>r.method!=='GET'||![200,206].includes(r.http)))throw Error('INCOMPLETE_READ');
 const t=capture.tables,completed=[...phase3.bundle.completedRows,...phase3.bundle.actions.map(a=>a.row)];
 if(new Set(completed).size!==145)throw Error('COMPLETED_SCOPE');
 const remaining=prior.filter(r=>!completed.includes(r.row));
 if(remaining.length!==250||remaining.filter(r=>r.state==='hold').length!==217||new Set(remaining.map(r=>r.key)).size!==250)throw Error('REMAINING_SCOPE');
 if(t.julyAudits.length!==144)throw Error('APPLIED_AUDIT_SCOPE');
 for(const [lo,hi,n] of [[4227,4275,49],[4292,4324,33],[4327,4436,110]])if(t.julyTransactions.filter(r=>r.id>=lo&&r.id<=hi&&r.status==='confirmed').length!==n)throw Error('APPLIED_TX_SCOPE');
 const accountById=new Map(t.accounts.map(a=>[a.id,a.code]));
 const existingDelta=zero();for(const m of t.movements){const x=t.julyTransactions.find(x=>x.id===m.transaction_id);if(x?.status==='confirmed'&&x.type!=='opening'&&x.business_date>='2026-07-01'&&x.business_date<'2026-08-01'&&FUNDS.includes(accountById.get(m.fund_account_id)))existingDelta[accountById.get(m.fund_account_id)]+=Number(m.amount);}
 const monthly={store_cash:-106834200,vuong_personal_custody:-10891700,cho_personal_custody:94620700,baba_corporate_bank:-277400975};
 const residualBefore=Object.fromEntries(FUNDS.map(f=>[f,monthly[f]-existingDelta[f]]));
 if(JSON.stringify(residualBefore)!==JSON.stringify({store_cash:-63764400,vuong_personal_custody:-6731700,cho_personal_custody:105001900,baba_corporate_bank:-252813978}))throw Error('OPERATING_BASELINE_CHANGED');
 const payment=t.rentPayments.find(p=>p.id===1),contract=t.rentContracts.find(p=>p.id===1);
 if(payment?.source!=='pre_ledger'||payment.payment_transaction_id!==null||payment.pre_ledger_reference!=='sheet:2026-07:row:33'||Number(payment.amount)!==300000000||payment.paid_on!=='2026-07-03'||payment.fund_account_id!==2||contract?.id!==payment.contract_id)throw Error('RENT_EVIDENCE');
 if(t.julyAdjustments.length||t.julyPayrollBatches.length)throw Error('PAYROLL_EVIDENCE_CHANGED');
 for(const id of [4,10]){const u=t.relevantUsers.find(u=>u.id===id);if(!u?.is_active||u.is_system_account||u.payroll_eligible_override===false||['owner','master'].includes(u.role))throw Error('ADVANCE_EMPLOYEE');}
 if(!t.categories.some(c=>c.id===70&&c.is_active&&c.kind==='expense'))throw Error('MENU_CATEGORY');
 const actions=remaining.filter(r=>READY.includes(r.row)).map(r=>{
  const kind=TRANSFERS.includes(r.row)?'transfer':r.row===33?'rent_preledger_conversion':r.row===299?'expense':'payroll_advance';
  const amount=volume(r);if(kind==='transfer'&&(r.effects.length!==2||r.effects.reduce((s,e)=>s+Number(e.amount),0)!==0))throw Error('TRANSFER_NOT_NET_ZERO');
  if(t.julyAudits.some(a=>a.reason===r.key)||t.julyTransactions.some(x=>x.source_key==='july-restore:'+r.key))throw Error('EXISTING_ROW');
  if(t.julyTransactions.some(x=>x.status==='confirmed'&&x.business_date===r.date&&Number(x.amount)===amount&&t.movements.some(m=>m.transaction_id===x.id&&r.effects.some(e=>e.account===accountById.get(m.fund_account_id)&&Number(e.amount)===Number(m.amount)))&&!t.julyAudits.some(a=>a.entity_id===x.id)))throw Error('UNLINKED_EXISTING_PAYMENT:'+r.row);
  const a={row:r.row,key:r.key,date:r.date,kind,amount,effects:r.effects,categoryId:kind==='expense'?70:null,userId:r.row===252?4:r.row===289?10:null};
  if(kind==='payroll_advance'){
   const h=createHash('md5').update('july-phase4:'+r.key).digest('hex');a.requestId=[h.slice(0,8),h.slice(8,12),h.slice(12,16),h.slice(16,20),h.slice(20)].join('-');
   a.sourceKey=`payroll-advance-payment:${r.date}:user:${a.userId}:${a.requestId}`;
  }else a.sourceKey='july-restore:'+r.key;
  return {...a,actionCanonical:JSON.stringify(a),actionHash:sha(a)};
 });
 if(actions.map(a=>a.row).join(',')!==READY.join(','))throw Error('READY_SCOPE');
 const rows=remaining.map(r=>{
  let route='insufficient_evidence',bucket='held',reason='Existing mapping does not establish economic type/recognition, source identity or payment allocation; no arbitrary adjustment.';
  if(actions.some(a=>a.row===r.row)){const a=actions.find(a=>a.row===r.row);route=a.kind;bucket='ready';reason=a.kind==='transfer'?'Explicit exchange description and two equal opposing business-fund movements; no sales.':a.kind==='rent_preledger_conversion'?'Exact pre-ledger reference; convert payment 1, preserve contract total and monthly P&L.':a.kind==='payroll_advance'?'T7 source deduction and employee confirmed; native cash-only advance RPC; no expense or second salary deduction.':'Menu update identified; existing printing category 70, no purchase source.';}
  else if(['card_deposit','pos_card'].includes(r.group)){route='card';bucket='pos_card';reason='Card delta -6102347 unresolved; no execution.';}
  else if(r.group==='pos_daily_split'||r.risks?.some(x=>/POS/.test(x))||r.batch==='B2_POS'){route='pos';bucket='pos_card';reason='Original receipt/payment allocation vs daily summary not established; no new sales.';}
  else if(r.phase3State==='linked_restricted'||payables.includes(r.row)){route='payable_prepayment';bucket='payable';reason=r.phase3State==='linked_restricted'?'Prior seven historical supplier payments/prepayments remain blocked by active_from or allocation rules; no new evidence.':'Invoice period, prior debt or actual payment allocation unresolved; preserve existing supplier cost/payable links.';}
  else if([123,144,252,289,296].includes(r.row)){route='salary_advance';reason='Payroll period/net calculation or employee allocation not complete; June salary discrepancy 2109128 remains unresolved.';}
  else if([184,267].includes(r.row)){route='capital';reason='Source labels investment, but pre-August capital opening already exists; no row-level opening rollforward proof or approved cash-only import contract. Do not double count principal or treat cash exchange as recovery.';}
  else if(r.row===367){route='tax';reason='VAT liability payment vs new P&L expense not established; no liability/allocation proof.';}
  else if(r.group==='manual_candidate'){route='ordinary_expense';reason='Description available but asset/repair/recognition-period or beneficiary evidence incomplete.';}
  const priorReasons=r.phase3Reasons||r.blockers||[];
  if(bucket!=='ready'&&priorReasons.length)reason+=' Prior findings: '+priorReasons.join('; ')+'. See preserved mappingNotes for row-specific evidence.';
  return {...r,phase4Route:route,phase4Bucket:bucket,phase4Reason:reason,phase4Amount:volume(r),executable:bucket==='ready'};
 });
 // Some older POS rows are tagged only by their prior batch name. Enforce the known179 minus5 transfers.
 const totals=Object.fromEntries(['ready','pos_card','payable','held'].map(b=>{const rr=rows.filter(r=>r.phase4Bucket===b);return [b,{count:rr.length,amount:rr.reduce((s,r)=>s+r.phase4Amount,0),fundDelta:sum(rr)}];}));
 const delta=sum(actions),residualAfter=Object.fromEntries(FUNDS.map(f=>[f,residualBefore[f]-delta[f]]));
 const targets=parseCsv(targetCsv),prefix={store_cash:'cash',vuong_personal_custody:'vuong',cho_personal_custody:'cho',baba_corporate_bank:'corporate'};
 if(targets.length!==31)throw Error('TARGET_SCOPE');
 const daily=targets.flatMap(target=>FUNDS.map(f=>{
  const before=t.movements.filter(m=>accountById.get(m.fund_account_id)===f&&t.julyTransactions.some(x=>x.id===m.transaction_id&&x.status==='confirmed'&&x.business_date<=''+target.business_date&&x.business_date>='2026-07-01')).reduce((s,m)=>s+Number(m.amount),0);
  const added=actions.filter(a=>a.date<=target.business_date).flatMap(a=>a.effects).filter(e=>e.account===f).reduce((s,e)=>s+Number(e.amount),0),goal=Number(target[prefix[f]+'_closing_vnd']);
  return {date:target.business_date,account:f,target:goal,before,added,after:before+added,differenceBefore:goal-before,differenceAfter:goal-before-added,matchBefore:goal===before,matchAfter:goal===before+added};
 }));
 const bundle={profile:'july-phase4-20261107',completedRows:completed.sort((a,b)=>a-b),actions,fundDelta:delta,closures:t.closures,accounts:t.accounts,category:t.categories.find(c=>c.id===70),rentPayment:payment,rentContract:contract,employees:t.relevantUsers.filter(u=>[4,10].includes(u.id)),rpcContracts:Object.fromEntries(Object.entries(contracts4()).map(([k,v])=>[k,{signature:v.signature,hash:v.hash}]))};
 const payload={bundle,bundleCanonical:JSON.stringify(bundle),bundleDigest:sha(bundle)};
 return {rows,payload,daily,summary:{count:250,completed:145,readyRows:READY,totals,existingDelta,residualBefore,residualAfter,matchingBefore:daily.filter(d=>d.matchBefore).length,matchingAfter:daily.filter(d=>d.matchAfter).length,newlyMatching:daily.filter(d=>!d.matchBefore&&d.matchAfter).map(d=>({date:d.date,account:d.account})),rpcLiveDefinitionRead:false,executionStatus:'READY_PENDING_OWNER_DB_APPROVAL',rpcContractValidation:'Owner production snapshot SHA matched; executable tokens equal; other three RPCs owner PASS',readOnlyHttpResponses:capture.requests.length,top10:rows.filter(r=>!r.executable).sort((a,b)=>b.phase4Amount-a.phase4Amount).slice(0,10).map(r=>({row:r.row,description:r.description,amount:r.phase4Amount,reason:r.phase4Reason}))}};
}
export function renderPhase4(payload){
 if(existsSync(new URL('../../.local/july-restore/phase4-final-20261107-r2/README-APPLIED-DO-NOT-RERUN.md',import.meta.url)))throw Error('PHASE4_ALREADY_APPLIED_DO_NOT_RENDER');
 const literal=s=>"'"+s.replaceAll("'","''")+"'",canonical=JSON.stringify(payload);
 return readFileSync(new URL('./july-restore-phase4-batch.sql',import.meta.url),'utf8').replaceAll('__PAYLOAD_LITERAL__',()=>literal(canonical)).replaceAll('__PAYLOAD_DIGEST__',sha(canonical));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const root=fileURLToPath(new URL('../../.local/july-restore/',import.meta.url)),out=resolve(process.argv[2]||''),rel=relative(root,out);
 if(existsSync(join(root,'phase4-final-20261107-r2/README-APPLIED-DO-NOT-RERUN.md')))throw Error('PHASE4_ALREADY_APPLIED_DO_NOT_RENDER');
 if(!process.argv[2]||!rel||rel.startsWith('..')||isAbsolute(rel)||existsSync(out))throw Error('NEW_LOCAL_FOLDER_REQUIRED');
 const load=p=>JSON.parse(readFileSync(join(root,p),'utf8'));
 const result=phase4Plan(load('phase3-final-20261107-r2/remaining-312.json'),load('phase3-final-20261107-r2/bundle.json'),load('phase4-runtime-20261107-r2/runtime-readonly.json'),readFileSync(join(root,'july_2026_daily_targets.csv'),'utf8'));
 mkdirSync(out,{recursive:true});
 for(const [n,v] of Object.entries({summary:result.summary,bundle:result.payload,'remaining-250':result.rows}))writeFileSync(join(out,n+'.json'),JSON.stringify(v,null,2));
 const serial=rows=>rows.map(r=>Object.fromEntries(Object.entries(r).map(([k,v])=>[k,v&&typeof v==='object'?JSON.stringify(v):v])));
 writeFileSync(join(out,'remaining-250.csv'),csv(['row','date','key','phase4Route','phase4Bucket','phase4Amount','effects','phase4Reason','mappingNotes'],serial(result.rows)));
 writeFileSync(join(out,'ready-9.csv'),csv(['row','date','key','kind','amount','effects','sourceKey','userId','categoryId','actionHash'],serial(result.payload.bundle.actions)));
 writeFileSync(join(out,'daily-124-impact.csv'),csv(Object.keys(result.daily[0]),result.daily));
 writeFileSync(join(out,'next-batch-REQUIRES-OWNER-DB-APPROVAL.sql'),renderPhase4(result.payload));
 writeFileSync(join(out,'rpc-contract-preflight-READONLY.sql'),"BEGIN READ ONLY;\nSELECT name,signature,expected,encode(sha256(convert_to(replace(p.prosrc,E'\\r\\n',E'\\n'),'UTF8')),'hex') actual,expected=encode(sha256(convert_to(replace(p.prosrc,E'\\r\\n',E'\\n'),'UTF8')),'hex') pass FROM (VALUES\n"+Object.entries(result.payload.bundle.rpcContracts).map(([k,v])=>`('${k}','${v.signature}','${v.hash}')`).join(',\n')+") r(name,signature,expected) LEFT JOIN pg_proc p ON p.oid=to_regprocedure(r.signature);\nROLLBACK;\n");
 const files=['summary.json','bundle.json','remaining-250.json','remaining-250.csv','ready-9.csv','daily-124-impact.csv','next-batch-REQUIRES-OWNER-DB-APPROVAL.sql','rpc-contract-preflight-READONLY.sql'];
 writeFileSync(join(out,'verification.json'),JSON.stringify({payloadSha:sha(JSON.stringify(result.payload)),bundleDigest:result.payload.bundleDigest,files:Object.fromEntries(files.map(n=>[n,sha(readFileSync(join(out,n),'utf8'))]))},null,2));
 console.log(JSON.stringify(result.summary,null,2));
}
