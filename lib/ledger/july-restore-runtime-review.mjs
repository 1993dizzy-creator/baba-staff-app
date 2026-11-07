// Pure follow-up to 6d290d39. Reuses its 395-row result; no source rescan/DB calls.
import {classifyPaymentBucket,filterPaidPayments} from '../sales/payment-summary.ts';
import {parseVndMilli,formatVndMilli} from './august-rebuild-plan.ts';
import {digest,FUNDS} from './july-restore-plan.ts';
const n=value=>parseVndMilli(String(value??0)),money=formatVndMilli;
const sum=(rows,fn)=>rows.reduce((v,r)=>v+n(fn(r)),0n);
const safeManualCategories=new Map([
  [43,[68,'배송·운송비']],[96,[68,'배송·운송비']],[220,[68,'배송·운송비']],
  [221,[68,'배송·운송비']],[262,[68,'배송·운송비']],[275,[68,'배송·운송비']],
  [284,[68,'배송·운송비']],[302,[68,'배송·운송비']],[314,[68,'배송·운송비']],[357,[68,'배송·운송비']],
  [126,[25,'수리·유지보수']],[363,[25,'수리·유지보수']],[277,[70,'인쇄·홍보비']],
]);
const tagsMemo=text=>[...new Set([...text.toLowerCase().matchAll(/b(r)?\s*(\d+)/g)].map(m=>(m[1]?'bar':'table')+Number(m[2])))].sort();
const tagsTable=text=>[...new Set(String(text||'').toLowerCase().split(/[,;+]/).map(s=>s.trim()).filter(Boolean).map(s=>{
  const m=/^(?:bar\s*)?(\d+)$/.exec(s);return m?(s.startsWith('bar')?'bar':'table')+Number(m[1]):s;
}))].sort();
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);

export function reviewJulyRuntime(baseline,snapshot,extra,labels=[]) {
  if(baseline.length!==395||baseline.filter(r=>r.status==='registration_candidate').length!==82||baseline.filter(r=>r.status==='needs_link').length!==148)throw Error('BASELINE_6D290D39_REQUIRED');
  const t=snapshot.tables;
  if(!snapshot.readOnly||!Object.values(snapshot.checks).every(c=>c.complete))throw Error('COMPLETE_READONLY_SNAPSHOT_REQUIRED');
  if(!extra||!Array.isArray(extra.rowAudits)||!Array.isArray(extra.julyClosures)||!Array.isArray(extra.juneCardLedger))throw Error('EXTRA_READONLY_EVIDENCE_REQUIRED');
  if(new Set(t.posReceiptsJuneJuly.map(r=>r.id)).size!==t.posReceiptsJuneJuly.length||new Set(t.posPaymentsJuneJuly.map(p=>p.id)).size!==t.posPaymentsJuneJuly.length)throw Error('DUPLICATE_POS_SOURCE_ID');
  const receipts=new Map(t.posReceiptsJuneJuly.map(r=>[r.id,{...r}]));
  for(const label of labels){const r=receipts.get(label.id);if(r&&r.business_date!==label.business_date)throw Error('RECEIPT_LABEL_DATE_DRIFT');if(r)Object.assign(r,label);}
  const payments=filterPaidPayments([...receipts.values()].filter(r=>r.payment_status===3&&r.is_canceled!==true),t.posPaymentsJuneJuly);
  if(payments.some(p=>!receipts.has(p.receipt_id)||receipts.get(p.receipt_id).business_date!==p.business_date||classifyPaymentBucket(p)===null))throw Error('POS_SOURCE_SCOPE_MISMATCH');
  const currentTx=new Map([...t.cardTransactions,...t.julyTransactions].map(r=>[r.id,r]));
  const bySource=new Map([...currentTx.values()].filter(r=>r.source_key).map(r=>[r.source_key,r]));
  const accounts=new Map(t.accounts.map(a=>[a.code,a]));
  const categories=new Map(t.categories.map(c=>[c.id,c]));
  const auditKeys=new Set(extra.rowAudits.map(a=>a.reason));
  const closed=extra.julyClosures.some(c=>c.status==='closed');
  const candidateResults=[];
  for(const row of baseline.filter(r=>r.status==='registration_candidate')) {
    const reasons=[];let category=null,kind=null;
    if(row.group==='meal'){category=[6,'직원 식대'];kind='meal';}
    else if(row.group==='pos_card'){category=[5,'POS 매출'];kind='pos';}
    else if(row.row===236){category=[30,'예금이자'];kind='income';}
    else if([306,368].includes(row.row)){category=[29,'결제·은행 수수료'];kind='expense';}
    else if([191,193].includes(row.row)){kind='transfer';}
    else if(safeManualCategories.has(row.row)){category=safeManualCategories.get(row.row);kind='expense';}
    else reasons.push('ECONOMIC_CLASSIFICATION_OR_CAPITALIZATION_UNRESOLVED');
    if(category){const c=categories.get(category[0]);if(!c||c.name!==category[1]||!c.is_active||c.kind!==(kind==='income'||kind==='pos'?'income':'expense'))reasons.push('CATEGORY_DRIFT');}
    for(const e of row.effects){const a=accounts.get(e.account);if(!a?.is_active||kind!=='pos'&&!a.is_business_fund)reasons.push('ACCOUNT_UNAVAILABLE');}
    if(closed)reasons.push('JULY_CLOSED');
    const key=`sheet-row-${row.row}`,sourceKey=kind==='pos'?`pos:${row.date}:card`:`july-restore:${key}`;
    if(auditKeys.has(row.key)||bySource.has(sourceKey))reasons.push('EXISTING_SOURCE_OR_ROW_AUDIT');
    if(t.julyCandidates.some(c=>c.business_date===row.date&&c.status==='pending'&&(c.proposed_category_id===category?.[0]&&n(c.proposed_amount)===sum(row.effects.filter(e=>n(e.amount)<0n),e=>money(-n(e.amount)))||kind==='meal'&&c.candidate_type==='employee_meal')))reasons.push('EXISTING_PENDING_CANDIDATE');
    if([...currentTx.values()].some(tx=>tx.business_date===row.date&&!['opening','sales'].includes(tx.type)&&tx.amount>0&&row.effects.some(e=>n(e.amount)<0n&&-n(e.amount)===n(tx.amount))))reasons.push('POSSIBLE_EXISTING_TRANSACTION');
    const positive=row.effects.filter(e=>n(e.amount)>0n),negative=row.effects.filter(e=>n(e.amount)<0n);
    const amount=kind==='income'||kind==='pos'?sum(positive,e=>e.amount):sum(negative,e=>money(-n(e.amount)));
    if(kind==='transfer'&&(positive.length!==1||negative.length!==1||sum(row.effects,e=>e.amount)!==0n))reasons.push('TRANSFER_NOT_BALANCED');
    if(['expense','meal'].includes(kind)&&(negative.length!==1||positive.length!==0))reasons.push('EXPENSE_SHAPE');
    if(kind==='income'&&(positive.length!==1||negative.length!==0))reasons.push('INCOME_SHAPE');
    let posPayments=[];
    if(kind==='pos'){
      posPayments=payments.filter(p=>p.business_date===row.date&&classifyPaymentBucket(p)==='card');
      if(sum(posPayments,p=>p.amount)!==amount)reasons.push('POS_CARD_SOURCE_DRIFT');
    }
    const status=reasons.length?'needs_confirmation':kind==='pos'?'card_blocked':'ready';
    candidateResults.push({row:row.row,key:row.key,date:row.date,status,reasons,kind,categoryId:category?.[0]??null,amount:money(amount),effects:row.effects,
      sourceKey,accountIds:row.effects.map(e=>({account:e.account,id:accounts.get(e.account)?.id})),paymentIds:posPayments.map(p=>p.id),
      action:status==='ready'?{key,rowNumbers:[row.row],kind,date:row.date,amount:money(amount),effects:row.effects,economicKey:row.key,
        evidence:`July sheet row ${row.row}; 6d290d39 mapping; GET snapshot ${snapshot.capturedAt}`,categoryId:category?.[0],costBasis:kind==='meal'?'verified_sheet_meal':kind==='expense'?'verified_non_inventory':undefined}:null});
  }

  // Parent aggregate links are never separate revenue in addition to children.
  const links=[];const unresolved=[];
  const summaryRows=baseline.filter(r=>r.status==='needs_link'&&r.group==='pos_daily_split');
  for(const date of [...new Set(summaryRows.map(r=>r.date))]) {
    const rows=summaryRows.filter(r=>r.date===date),pp=payments.filter(p=>p.business_date===date&&classifyPaymentBucket(p)==='transfer');
    const expected=sum(rows.flatMap(r=>r.effects).filter(e=>e.account==='baba_corporate_bank'),e=>e.amount);
    if(pp.length&&expected===sum(pp,p=>p.amount))for(const row of rows)links.push({row:row.row,key:row.key,date,kind:'pos_transfer_aggregate',postingStatus:'GROUP_REQUIRED',componentOnly:true,
      groupKey:`pos:${date}:transfer`,rowNumbers:rows.map(r=>r.row),paymentIds:pp.map(p=>p.id),receiptIds:[...new Set(pp.map(p=>p.receipt_id))],sourceFingerprint:digest(pp)});
    else for(const row of rows)unresolved.push({row:row.row,reason:'TRANSFER_AGGREGATE_MISMATCH'});
  }
  const detailCandidates=[];
  for(const row of baseline.filter(r=>r.status==='needs_link'&&r.group==='other'&&r.batch==='B2_POS')) {
    const positive=row.effects.filter(e=>n(e.amount)>0n),bucket=positive[0]?.account==='store_cash'?'cash':'other',memoTags=tagsMemo(row.description);
    if(positive.length!==1||!memoTags.length||/nham|tttloi|hoan/i.test(row.description)){unresolved.push({row:row.row,reason:'SPLIT_OR_SETTLEMENT_EVIDENCE_REQUIRED'});continue;}
    const matches=payments.filter(p=>p.business_date===row.date&&classifyPaymentBucket(p)===bucket&&n(p.amount)===n(positive[0].amount)&&same(memoTags,tagsTable(receipts.get(p.receipt_id)?.table_name)));
    if(matches.length!==1){unresolved.push({row:row.row,reason:matches.length?'AMBIGUOUS_RECEIPT':'NO_DATE_TABLE_BUCKET_AMOUNT_MATCH'});continue;}
    const p=matches[0];detailCandidates.push({row:row.row,key:row.key,date:row.date,kind:'pos_receipt_payment',postingStatus:'GROUP_REQUIRED',componentOnly:false,
      groupKey:`pos:${row.date}:noncard`,paymentIds:[p.id],receiptIds:[p.receipt_id],sourceFingerprint:digest({receipt:receipts.get(p.receipt_id),payment:p}),bucket});
  }
  for(const link of detailCandidates){if(detailCandidates.filter(l=>l.paymentIds[0]===link.paymentIds[0]).length===1)links.push(link);else unresolved.push({row:link.row,reason:'PAYMENT_KEY_REUSED'});}
  for(const r of baseline.filter(r=>r.status==='needs_link'&&r.group==='card_deposit'))unresolved.push({row:r.row,reason:'JULY_DEPOSIT_SETTLEMENT_PERIOD_UNPROVEN'});
  const linkedSet=new Set(links.map(l=>l.row));const dayGroups=[];
  for(const date of [...new Set(baseline.filter(r=>r.batch==='B2_POS'&&r.group!=='pos_card').map(r=>r.date))]) {
    const rows=baseline.filter(r=>r.date===date&&r.batch==='B2_POS'&&r.group!=='pos_card'),pp=payments.filter(p=>p.business_date===date&&classifyPaymentBucket(p)!=='card');
    const sheetNet=sum(rows.flatMap(r=>r.effects),e=>e.amount),sourceNet=sum(pp,p=>p.amount);
    dayGroups.push({date,rowNumbers:rows.map(r=>r.row),sourcePaymentIds:pp.map(p=>p.id),sheetNet:money(sheetNet),sourceNet:money(sourceNet),difference:money(sheetNet-sourceNet),
      fullyLinked:sheetNet===sourceNet&&rows.every(r=>linkedSet.has(r.row)),postingStatus:'GROUPED_POSTING_REVIEW_REQUIRED'});
  }
  const ready=candidateResults.filter(r=>r.status==='ready'),deltas=Object.fromEntries(FUNDS.map(f=>[f,money(sum(ready.flatMap(r=>r.effects).filter(e=>e.account===f),e=>e.amount))]));
  const activeReconciliations=t.cardReconciliations.filter(r=>['matched','auto_allocated'].includes(r.status));
  const recIds=new Set(activeReconciliations.map(r=>r.id));const periods={};
  for(const line of t.cardAllocationLines){if(!recIds.has(line.reconciliation_id))continue;const sale=currentTx.get(line.pos_card_transaction_id),deposit=activeReconciliations.find(r=>r.id===line.reconciliation_id);if(sale?.status!=='confirmed')continue;const k=sale.business_date.slice(0,7)+'->'+deposit.deposit_date.slice(0,7);periods[k]=money(n(periods[k]??0)+n(line.allocated_gross_amount));}
  const juneCard=sum(payments.filter(p=>p.business_date<'2026-07-01'&&classifyPaymentBucket(p)==='card'),p=>p.amount);
  const julyCard=sum(payments.filter(p=>p.business_date>='2026-07-01'&&classifyPaymentBucket(p)==='card'),p=>p.amount);
  const currentBalance=sum(t.cardMovements.filter(m=>currentTx.get(m.transaction_id)?.status==='confirmed'),m=>m.amount);
  const sheetCard=sum(baseline.filter(r=>r.group==='pos_card').flatMap(r=>r.effects).filter(e=>e.account==='card_clearing'),e=>e.amount);
  const julyDeposits=sum(baseline.filter(r=>r.group==='card_deposit').flatMap(r=>r.effects).filter(e=>e.account==='baba_corporate_bank'),e=>e.amount);
  const existing=currentTx.get(1190),existingMovement=sum(t.cardMovements.filter(m=>m.transaction_id===1190),m=>m.amount);
  if(existing?.status!=='confirmed'||existing.source_key!=='pos:2026-07-31:card'||existingMovement!==n(existing.amount))throw Error('PROTECTED_1190_DRIFT');
  const proposedDelta=sheetCard-n(existing.amount)-julyDeposits;
  const statuses=Object.fromEntries(['ready','card_blocked','needs_confirmation'].map(status=>[status,candidateResults.filter(r=>r.status===status).length]));
  const summary={baselineCommit:'6d290d39',baselineReconciliation:'REUSED_WITHOUT_RERUN',capturedAt:snapshot.capturedAt,
    candidate82:{statuses,readyGrossAmount:money(sum(ready,r=>r.amount)),expense:money(sum(ready.filter(r=>['expense','meal'].includes(r.kind)),r=>r.amount)),income:money(sum(ready.filter(r=>r.kind==='income'),r=>r.amount)),transfer:money(sum(ready.filter(r=>r.kind==='transfer'),r=>r.amount)),deltas},
    links148:{sourceLinked:links.length,remaining:148-links.length,aggregateComponentLinks:links.filter(l=>l.componentOnly).length,receiptPaymentLinks:links.filter(l=>!l.componentOnly).length,
      fullyLinkedNoncardDayGroups:dayGroups.filter(g=>g.fullyLinked).length,fullyLinkedNoncardRows:dayGroups.filter(g=>g.fullyLinked).reduce((s,g)=>s+g.rowNumbers.length,0),newLedgerTransactions:0},
    card:{juneOriginalSales:money(juneCard),juneLedgerCardRows:extra.juneCardLedger.length,juneCarryoverConfirmed:false,julyOriginalSales:money(julyCard),sheetSales:money(sheetCard),julyDeposits:money(julyDeposits),
      monthSheetNet:money(sheetCard-julyDeposits),existing1190:String(existing.amount),knownSheetSourceDifferences:money(julyCard-sheetCard),remainingWithOriginalPos:money(julyCard-n(existing.amount)-julyDeposits),proposedCurrentChange:money(proposedDelta),
      currentBalance:money(currentBalance),projectedIfUnblocked:money(currentBalance+proposedDelta),julySettlementPeriodsConfirmed:false,
      reconciliations:t.cardReconciliations.length,activeReconciliations:activeReconciliations.length,cancelledReconciliations:t.cardReconciliations.filter(r=>r.status==='cancelled').length,allocationLines:t.cardAllocationLines.length,
      activeAllocationPeriods:periods,protectedFingerprint:digest({reconciliations:t.cardReconciliations,allocations:t.cardAllocationLines,feeClosures:t.cardFeeClosures,feeLines:t.cardFeeAllocationLines}),batchStatus:'BLOCKED'},
    accountsActiveFrom:Object.fromEntries(t.accounts.map(a=>[a.code,a.active_from])),currentJulyTransactions:t.julyTransactions.length,currentJulyCandidates:t.julyCandidates.length,
    batchStatus:{B1:'READY_SUBSET_REQUIRES_SEPARATE_DB_APPROVAL',B2_NONCARD:'SOURCE_LINKED_GROUPED_POSTING_REVIEW_REQUIRED',B2_CARD:'BLOCKED',B3_TRANSFER:'READY_SUBSET_REQUIRES_SEPARATE_DB_APPROVAL',B3_OTHER:'BLOCKED'},dbWrites:0};
  return {summary,candidates:candidateResults,links,unresolved,dayGroups};
}
