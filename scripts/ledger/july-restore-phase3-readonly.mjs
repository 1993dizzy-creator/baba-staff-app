// Operator GET-only supplement to the preserved 95-row status table; no full inventory/POS scan.
// Run from the existing env-owning Main, with output inside this worktree's .local.
import {createRequire} from 'node:module';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../.local/july-restore/',import.meta.url));
const out=resolve(process.argv[2]||''),rel=relative(root,out);
if(!process.argv[2]||!rel||rel.startsWith('..')||isAbsolute(rel)||existsSync(out))throw Error('NEW_LOCAL_OUTPUT_REQUIRED');
const prior=JSON.parse(readFileSync(join(root,'phase2-final-20261107-r2/reviewed-345.json'),'utf8'));
const scope=prior.filter(r=>r.state==='needs_link');if(scope.length!==95)throw Error('PRIOR_SCOPE_DRIFT');
const ids=[...new Set(scope.flatMap(r=>[...r.inventoryIds,...r.correctionIds,...r.excludedIds]))].sort((a,b)=>a-b);
const require=createRequire(join(process.cwd(),'package.json')),{createClient}=require('@supabase/supabase-js');
const capture={capturedAt:new Date().toISOString(),readOnly:true,scope:{rows:scope.map(r=>r.row),inventoryIds:ids},requests:[],tables:{},checks:{}};
const db=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:async(url,init={})=>{
 if((init.method||'GET').toUpperCase()!=='GET')throw Error('GET_ONLY');
 const r=await fetch(url,{...init,signal:AbortSignal.timeout(30000)});capture.requests.push({method:'GET',http:r.status,at:new Date().toISOString()});return r;
}}});
async function read(name,table,columns,filter=q=>q,order='id'){
 let expected=null;const all=[];
 for(let offset=0;;offset+=500){const {data,error,count,status}=await filter(db.from(table).select(columns,{count:'exact'})).order(order).range(offset,offset+499);
  if(error)throw Error(`${name}:HTTP_${status}:CODE_${error.code}`);
  if(count===null||expected!==null&&expected!==count)throw Error(`${name}:COUNT_CHANGED`);expected=count;all.push(...data);
  if(all.length===count)break;if(!data.length||all.length>count)throw Error(`${name}:INCOMPLETE`);
 }
 capture.tables[name]=all;capture.checks[name]={count:all.length,complete:true};console.log(JSON.stringify({table:name,count:all.length}));return all;
}
async function chunks(name,table,columns,values,apply,order='id'){
 const all=[];for(let i=0;i<values.length;i+=75){const k=name+i;all.push(...await read(k,table,columns,q=>apply(q,values.slice(i,i+75)),order));delete capture.tables[k];}
 capture.tables[name]=[...new Map(all.map(x=>[x[order],x])).values()];capture.checks[name]={count:capture.tables[name].length,complete:true};return capture.tables[name];
}
try{
 const logs=await chunks('inventoryLogs','inventory_logs','*',ids,(q,v)=>q.in('id',v));
 await chunks('linkedCorrections','inventory_logs','*',ids,(q,v)=>q.in('correction_of_inventory_log_id',v));
 await chunks('inventoryItems','inventory','id,quantity,purchase_price,updated_at',[...new Set(logs.map(l=>l.item_id))].filter(Boolean),(q,v)=>q.in('id',v));
 const candidates=await chunks('candidates','ledger_candidates','*',ids.map(id=>'inventory-log:'+id),(q,v)=>q.in('source_key',v));
 await chunks('projection','ledger_inventory_projection_status','*',ids,(q,v)=>q.in('inventory_log_id',v),'inventory_log_id');
 await chunks('directTransactions','ledger_transactions','*',ids,(q,v)=>q.in('source_snapshot->>inventory_log_id',v));
 const july=await read('julyTransactions','ledger_transactions','*',q=>q.or('and(business_date.gte.2026-07-01,business_date.lt.2026-08-01),recognition_month.eq.2026-07-01'));
 await read('julyAudits','ledger_audit_logs','id,action,entity_id,reason,after_snapshot',q=>q.eq('action','july_restore_row'));
 await read('accounts','ledger_fund_accounts','id,code,type,is_active,is_business_fund,active_from,active_to');
 await read('categories','ledger_categories','id,name,kind,is_active');
 await read('categoryMappings','ledger_inventory_category_mappings','*');
 await read('supplierMappings','ledger_supplier_party_mappings','*');
 await read('parties','ledger_parties','id,name,type,is_active');
 // Date is filtered through the actual expense FK: do not reread 837 later-month payables.
 const payables=await read('payables','ledger_payables','*,expense:ledger_transactions!ledger_payables_expense_transaction_id_fkey!inner(id,business_date,status,source_type,source_key,source_snapshot)',q=>q.lt('expense.business_date','2026-08-01'));
 await chunks('payableAllocations','ledger_payable_allocations','*',payables.map(p=>p.id),(q,v)=>q.in('payable_id',v));
 const txIds=[...new Set([...july.map(t=>t.id),...capture.tables.directTransactions.map(t=>t.id),...candidates.map(c=>c.resolved_transaction_id).filter(Boolean)])];
 await chunks('movements','ledger_movements','id,transaction_id,fund_account_id,amount',txIds,(q,v)=>q.in('transaction_id',v));
 await read('closures','ledger_month_closures','id,month,status,revision,snapshot_hash',q=>q.gte('month','2026-07-01').lte('month','2026-10-01'));
 capture.status='CAPTURED';capture.completedAt=new Date().toISOString();
}catch(e){capture.status='BLOCKED_READ_CAPTURE';capture.error=String(e.message);process.exitCode=1;}
mkdirSync(out,{recursive:true});writeFileSync(join(out,'runtime-readonly.json'),JSON.stringify(capture,null,2));
console.log(JSON.stringify({status:capture.status,error:capture.error,httpCalls:capture.requests.length,inventoryIds:ids.length,dbWrites:0}));
