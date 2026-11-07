// Operator-only GET snapshot. Run from the existing env-owning repository:
// node --env-file=.env.local <worktree>/scripts/ledger/july-restore-runtime-readonly.mjs <new-folder-outside-git>
// No RPC, POST, authentication refresh, DB/POS writes, retry, or env copying.
import {createRequire} from 'node:module';
import {mkdirSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,join,relative,isAbsolute} from 'node:path';
const output=resolve(process.argv[2]||'');
const referenceRoot=resolve('C:/workspace/baba-july-inputs-2026');
const rel=relative(referenceRoot,output);
if(!process.argv[2]||!rel||rel.startsWith('..')||isAbsolute(rel)||existsSync(output))throw Error('NEW_REFERENCE_SUBFOLDER_REQUIRED');
const require=createRequire(join(process.cwd(),'package.json'));
const {createClient}=require('@supabase/supabase-js');
const requests=[];
const readFetch=async(url,init={})=>{
  if((init.method||'GET').toUpperCase()!=='GET')throw Error('GET_ONLY');
  const r=await fetch(url,{...init,signal:AbortSignal.timeout(30000)});
  requests.push({method:'GET',http:r.status,at:new Date().toISOString()});
  return r;
};
const db=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:readFetch}});
const snapshot={capturedAt:new Date().toISOString(),readOnly:true,requests,tables:{},checks:{}};
async function read(name,table,columns,filter=q=>q){
  let expected=null;const rows=[];
  for(let offset=0;;offset+=500){
    const {data,error,count,status}=await filter(db.from(table).select(columns,{count:'exact'})).order('id').range(offset,offset+499);
    if(error)throw Error(`${name}:HTTP_${status}:CODE_${error.code}`);
    if(count===null||expected!==null&&expected!==count)throw Error(`${name}:COUNT_CHANGED`);
    expected=count;rows.push(...data);
    if(rows.length===count)break;
    if(!data.length||rows.length>count)throw Error(`${name}:INCOMPLETE_PAGE`);
  }
  snapshot.tables[name]=rows;snapshot.checks[name]={count:rows.length,complete:true};
  console.log(JSON.stringify({table:name,count:rows.length,complete:true}));return rows;
}
try{
 await read('accounts','ledger_fund_accounts','id,code,type,is_active,is_business_fund,active_from,active_to');
 await read('categories','ledger_categories','id,name,kind,cost_behavior,is_active');
 await read('julyTransactions','ledger_transactions','*',q=>q.or('and(business_date.gte.2026-07-01,business_date.lt.2026-08-01),recognition_month.eq.2026-07-01'));
 await read('julyCandidates','ledger_candidates','*',q=>q.gte('business_date','2026-07-01').lt('business_date','2026-08-01'));
 await read('rowAudits','ledger_audit_logs','id,reason,entity_id,after_snapshot',q=>q.eq('action','july_restore_row'));
 await read('julyClosures','ledger_month_closures','id,month,status,revision,snapshot_hash',q=>q.eq('month','2026-07-01'));
 await read('juneCardLedger','ledger_transactions','id,type,status,business_date,amount,source_type,source_key',q=>q.eq('source_type','pos_sales_daily_payment').gte('business_date','2026-06-01').lt('business_date','2026-07-01').like('source_key','%:card'));
 await read('cardMovements','ledger_movements','id,transaction_id,fund_account_id,amount',q=>q.eq('fund_account_id',4));
 const reconciliations=await read('cardReconciliations','ledger_card_reconciliations','*');
 const lines=await read('cardAllocationLines','ledger_card_reconciliation_lines','*');
 await read('cardFeeClosures','ledger_card_fee_closures','*');
 const fees=await read('cardFeeAllocationLines','ledger_card_fee_allocation_lines','*');
 const transactionIds=[...new Set([...snapshot.tables.cardMovements.map(x=>x.transaction_id),...reconciliations.map(x=>x.deposit_transaction_id),...lines.map(x=>x.pos_card_transaction_id),...fees.map(x=>x.pos_card_transaction_id)])];
 const cardTransactions=[];
 for(let i=0;i<transactionIds.length;i+=100)cardTransactions.push(...await read('cardTransactionChunk'+i,'ledger_transactions','*',q=>q.in('id',transactionIds.slice(i,i+100))));
 snapshot.tables.cardTransactions=cardTransactions;
 for(const k of Object.keys(snapshot.tables))if(k.startsWith('cardTransactionChunk'))delete snapshot.tables[k];
 const julyIds=snapshot.tables.julyTransactions.map(x=>x.id);
 await read('julyMovements','ledger_movements','id,transaction_id,fund_account_id,amount',q=>q.in('transaction_id',julyIds.length?julyIds:[-1]));
 await read('posReceiptsJuneJuly','pos_sales_receipts','id,ref_no,business_date,ref_date,payment_status,is_canceled,final_amount,revision,updated_at,table_name',q=>q.gte('business_date','2026-06-01').lt('business_date','2026-08-01'));
 await read('posPaymentsJuneJuly','pos_sales_receipt_payments','id,receipt_id,business_date,payment_type,payment_name,card_name,amount',q=>q.gte('business_date','2026-06-01').lt('business_date','2026-08-01'));
 snapshot.completedAt=new Date().toISOString();
 mkdirSync(output,{recursive:true});writeFileSync(join(output,'runtime-readonly.json'),JSON.stringify(snapshot,null,2));
 console.log(JSON.stringify({status:'CAPTURED',httpCalls:requests.length,dbWrites:0,outputFolder:output}));
}catch(error){console.error(String(error.message));process.exitCode=1;}
