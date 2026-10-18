// Read-only audit of a previously captured snapshot. No database connection or writes.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {calculatePurchaseSettlement,calculatePayableBalances} from '../lib/ledger/payables.ts';
import {buildLedgerEntries} from '../lib/ledger/entries.ts';
import {isPaymentVerification,buildPaymentVerificationItems} from '../lib/ledger/payment-verification.ts';
const output=process.argv[4]||'.qa-review/october-settlement';mkdirSync(output,{recursive:true});
const path=process.argv[2]||'.qa-review/october-settlement/baseline.json';
const raw=readFileSync(path,'utf8'),data=JSON.parse(raw),month='2026-10',start=month+'-01',end='2026-11-01';
const tx=new Map(data.transactions.map(t=>[t.id,t]));
const sum=a=>Math.round(a.reduce((s,n)=>s+Number(n),0)*1000)/1000;
const allocations=data.allocations.map(a=>({...a,payment:tx.has(a.payment_transaction_id)?{...tx.get(a.payment_transaction_id),movements:data.movements.filter(m=>m.transaction_id===a.payment_transaction_id)}:null}));
const sources=data.payables.map(p=>({...p,expense:tx.get(p.expense_transaction_id)||null}));
const october=sources.filter(p=>p.expense?.business_date>=start&&p.expense?.business_date<end);
const rows=october.map(p=>{const linked=allocations.filter(a=>a.payable_id===p.id);const beforeCredit=sum(linked.filter(a=>a.payment?.status==='confirmed').map(a=>a.allocated_amount));const after=calculatePurchaseSettlement(p.original_amount,linked,{payableId:p.id,transactionId:p.expense_transaction_id});return{payableId:p.id,transactionId:p.expense_transaction_id,date:p.expense.business_date,item:p.expense.source_snapshot?.item_name||p.expense.memo,partyId:p.party_id,rawStatus:p.status,expenseStatus:p.expense.status,beforeCredit,beforeRemaining:Math.max(0,p.original_amount-beforeCredit),...after}});
const applicable=rows.filter(r=>r.rawStatus!=='cancelled'&&r.expenseStatus==='confirmed');
const oldTotal=sum(applicable.map(r=>r.beforeRemaining)),newTotal=sum(applicable.map(r=>r.remainingAmount));
const nine=rows.filter(r=>r.adjustments.some(a=>a.transactionId>=2911&&a.transactionId<=2919));
const adjustedIds=new Set(nine.flatMap(r=>r.adjustments.map(a=>a.transactionId))),byRoot=new Map(nine.map(r=>[r.transactionId,r]));
const profit=data.transactions.filter(t=>t.status==='confirmed'&&t.recognition_month===start&&['income','sales','expense','expense_recognition'].includes(t.type));
const category=new Map();
for(const t of profit.filter(t=>['expense','expense_recognition'].includes(t.type))){const key=t.category_id;const c=category.get(key)||{id:key,name:data.categories.find(c=>c.id===key)?.name,before:0,after:0};c.before+=Number(t.amount)*Number(t.economic_effect_sign||1);if(!adjustedIds.has(t.id))c.after+=(byRoot.get(t.id)?.effectiveAmount??Number(t.amount))*Number(t.economic_effect_sign||1);category.set(key,c);}
const income=sum(profit.filter(t=>['income','sales'].includes(t.type)).map(t=>Number(t.amount)*Number(t.economic_effect_sign||1)));
const expenseBefore=sum([...category.values()].map(c=>c.before)),expenseAfter=sum([...category.values()].map(c=>c.after));
const accounts=data.accounts.map(account=>{const movements=data.movements.filter(m=>m.fund_account_id===account.id&&tx.get(m.transaction_id)?.status==='confirmed'&&tx.get(m.transaction_id)?.business_date<end);const opening=movements.filter(m=>tx.get(m.transaction_id).type==='opening'&&tx.get(m.transaction_id).business_date===start);const scoped=opening.length?movements.filter(m=>tx.get(m.transaction_id).business_date>=start):movements;return{id:account.id,code:account.code,name:account.display_name,before:sum(scoped.map(m=>m.amount)),after:sum(scoped.map(m=>m.amount))}});
const parties=[...new Set(applicable.map(r=>r.partyId))].map(partyId=>({partyId,before:sum(applicable.filter(r=>r.partyId===partyId).map(r=>r.beforeRemaining)),after:sum(applicable.filter(r=>r.partyId===partyId).map(r=>r.remainingAmount))}));
const balance=calculatePayableBalances(sources,allocations,month);
const verify=buildPaymentVerificationItems(sources,allocations);
const ordinarySources=sources.filter(s=>!isPaymentVerification(s));
const ordinaryBefore=calculatePayableBalances(ordinarySources,allocations.map(a=>({...a,payment:a.payment?{business_date:a.payment.business_date,status:a.payment.status}:null})),month);
const ordinaryAfter=calculatePayableBalances(ordinarySources,allocations,month);
const embedded=data.transactions.filter(t=>t.business_date>=start&&t.business_date<end).map(t=>({...t,display_snapshot:{...t.source_snapshot,...t.display_snapshot},category:data.categories.find(c=>c.id===t.category_id)||null,party:{name:t.source_snapshot?.supplier||'QA supplier'},movements:data.movements.filter(m=>m.transaction_id===t.id).map(m=>({...m,fund_account:data.accounts.find(a=>a.id===m.fund_account_id)})),payable:(()=>{const p=data.payables.find(p=>p.expense_transaction_id===t.id);return p?{...p,allocations:allocations.filter(a=>a.payable_id===p.id)}:null})()}));
const entries=buildLedgerEntries(embedded.filter(t=>t.status==='confirmed'),[],new Map(),[],month);
const sheetPath=process.argv[3]||'.qa-review/october-settlement/sheet.json';
const sheet=JSON.parse(readFileSync(sheetPath,'utf8')).values;
const excelDate=n=>typeof n==='number'?new Date(Date.UTC(1899,11,30)+n*86400000).toISOString().slice(0,10):'';
const sheetPayments=data.transactions.filter(t=>t.type==='payable_payment'&&t.status==='confirmed'&&t.business_date>=start&&t.business_date<='2026-10-15'&&/10월\s*\d+행/.test(t.memo||'')).map(t=>{const row=Number(/10월\s*(\d+)행/.exec(t.memo)[1]),s=sheet[row-1];const sheetPaid=-sum((s||[]).slice(6,11).filter(v=>typeof v==='number'&&v<0));return{transactionId:t.id,row,date:t.business_date,sheetDate:excelDate(s?.[1]),amount:t.amount,sheetPaid,match:Number(t.amount)===sheetPaid&&t.business_date===excelDate(s?.[1])}});
// Reconcile cash by explicit sheet-row provenance, never by matching amounts.
const sheetGroups=[...new Set(sheetPayments.map(p=>p.row))].map(row=>{
 const payments=sheetPayments.filter(p=>p.row===row),amount=sum(payments.map(p=>p.amount)),sheetPaid=payments[0].sheetPaid;
 const s=sheet[row-1],sheetDate=excelDate(s?.[1]);
 const accountColumns={store_cash:6,vuong_personal_custody:7,cho_personal_custody:8,card_clearing:9,baba_corporate_bank:10};
 const reconciliations=data.transactions.filter(t=>t.type==='balance_adjustment'&&t.status==='confirmed'&&t.business_date===sheetDate&&t.source_key?.startsWith('sheet:2026-10:row'+row+':')).map(t=>({transactionId:t.id,sourceKey:t.source_key,movements:data.movements.filter(m=>m.transaction_id===t.id)}));
 const cashTransactions=[...payments.map(p=>p.transactionId),...reconciliations.map(r=>r.transactionId)];
 const cashByColumn={};for(const id of cashTransactions)for(const m of data.movements.filter(m=>m.transaction_id===id)){
  const code=data.accounts.find(a=>a.id===m.fund_account_id)?.code,column=accountColumns[code];
  if(column===undefined||Number(m.amount)>=0)throw new Error('Unverified sheet movement '+id);
  cashByColumn[column]=(cashByColumn[column]||0)-Number(m.amount);
 }
 const cashTotal=sum(Object.values(cashByColumn)),reconciliationAmount=cashTotal-amount;
 return {row,paymentIds:payments.map(p=>p.transactionId),amount,sheetPaid,allocatedDifference:sheetPaid-amount,reconciliations:reconciliations.map(({transactionId,sourceKey})=>({transactionId,sourceKey})),reconciliationAmount,cashByColumn,cashTotal,difference:sheetPaid-cashTotal,match:cashTotal===sheetPaid&&payments.every(p=>p.date===sheetDate)&&[6,7,8,9,10].every(c=>(cashByColumn[c]||0)===Math.abs(Math.min(0,Number(s?.[c])||0)))};
});
const sheetHold=sheet.map((r,i)=>({row:i+1,date:excelDate(r[1]),description:r[5],amount:Math.abs(Number(r[6]||0))})).filter(r=>r.date==='2026-10-11'&&r.amount===1968000);
const summary={capturedAt:data.capturedAt,sourceHash:createHash('sha256').update(raw).digest('hex'),counts:{octoberTransactions:embedded.length,octoberPayables:october.length,activePayables:applicable.length,adjustments:adjustedIds.size},nine,totals:{nineOriginal:sum(nine.map(r=>r.originalAmount)),adjustment:sum(nine.map(r=>r.adjustmentAmount)),nineEffective:sum(nine.map(r=>r.effectiveAmount)),nineCash:sum(nine.map(r=>r.cashPaidAmount)),beforeOutstanding:oldTotal,afterOutstanding:newTotal,expenseBefore,expenseAfter,income,profitBefore:income-expenseBefore,profitAfter:income-expenseAfter},categories:[...category.values()],parties,accounts,monthBalance:balance.summary,ordinaryMonthBalance:{before:ordinaryBefore.summary,after:ordinaryAfter.summary},ordinaryPartyBalances:{before:ordinaryBefore.partySummaries,after:ordinaryAfter.partySummaries},pending:{count:verify.pendingCount,total:verify.totalPending,settledNineExcluded:nine.every(r=>!verify.items.some(i=>i.payableId===r.payableId&&i.remainingAmount>0))},sheetPayments,sheetGroups,sheetHold,protection:rows.filter(r=>[1023,1077].includes(r.payableId)),latestDate:embedded.map(t=>t.business_date).sort().at(-1)};
const invariant=sheetGroups.every(r=>r.match)&&[...category.values()].every(c=>c.before===c.after)&&data.movements.filter(m=>adjustedIds.has(m.transaction_id)).every(m=>Number(m.amount)===0)&&oldTotal===newTotal&&expenseBefore===expenseAfter&&parties.every(p=>p.before===p.after)&&adjustedIds.size===9&&sum(nine.map(r=>r.adjustmentAmount))===-7100&&nine.every(r=>r.remainingAmount===0&&r.status==='paid');
writeFileSync(output+'/comparison.json',JSON.stringify({...summary,invariant},null,2));
writeFileSync(output+'/entries.json',JSON.stringify(entries,null,2));
writeFileSync(output+'/verification.json',JSON.stringify(verify,null,2));
writeFileSync(output+'/per-receipt.csv','payable_id,transaction_id,date,original_db_status,expense_status,included,original_amount,adjustment_amount,effective_amount,cash_paid_amount,remaining_amount,status\n'+rows.map(r=>[r.payableId,r.transactionId,r.date,r.rawStatus,r.expenseStatus,r.rawStatus!=='cancelled'&&r.expenseStatus==='confirmed',r.originalAmount,r.adjustmentAmount,r.effectiveAmount,r.cashPaidAmount,r.remainingAmount,r.rawStatus==='cancelled'||r.expenseStatus!=='confirmed'?'excluded':r.status].join(',')).join('\n'));
console.log(JSON.stringify({invariant,counts:summary.counts,totals:summary.totals,pending:summary.pending,sheetPaymentCount:sheetPayments.length,sheetMismatches:sheetGroups.filter(p=>!p.match),sheetHold,protection:summary.protection.map(r=>({id:r.payableId,remaining:r.remainingAmount,status:r.status})),latestDate:summary.latestDate},null,2));
if(!invariant)process.exitCode=1;
