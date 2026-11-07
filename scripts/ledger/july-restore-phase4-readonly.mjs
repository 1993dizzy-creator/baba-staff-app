// Operator-only GET supplement. No inventory/POS rescan, SQL/RPC call, env copying or retry.
import {createRequire} from 'node:module';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../.local/july-restore/',import.meta.url)),out=resolve(process.argv[2]||''),rel=relative(root,out);
if(!process.argv[2]||!rel||rel.startsWith('..')||isAbsolute(rel)||existsSync(out))throw Error('NEW_LOCAL_FOLDER_REQUIRED');
const require=createRequire(join(process.cwd(),'package.json')),{createClient}=require('@supabase/supabase-js');
const cap={capturedAt:new Date().toISOString(),readOnly:true,requests:[],tables:{},checks:{}};
const db=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:async(url,init={})=>{
 if((init.method||'GET').toUpperCase()!=='GET')throw Error('GET_ONLY');const r=await fetch(url,{...init,signal:AbortSignal.timeout(30000)});cap.requests.push({method:'GET',http:r.status,at:new Date().toISOString()});return r;
}}});
async function read(name,table,columns,filter=q=>q,order='id'){
 let expected=null;const all=[];
 for(let offset=0;;offset+=500){const {data,error,count,status}=await filter(db.from(table).select(columns,{count:'exact'})).order(order).range(offset,offset+499);
  if(error)throw Error(`${name}:HTTP_${status}:CODE_${error.code}`);if(count===null||expected!==null&&count!==expected)throw Error(`${name}:COUNT_DRIFT`);
  expected=count;all.push(...data);if(all.length===count)break;if(!data.length||all.length>count)throw Error(`${name}:INCOMPLETE`);
 }
 cap.tables[name]=all;cap.checks[name]={count:all.length,complete:true};console.log(JSON.stringify({table:name,count:all.length}));return all;
}
try{
 const tx=await read('julyTransactions','ledger_transactions','id,operation_id,type,status,occurred_at,business_date,recognition_month,amount,category_id,party_id,source_type,source_key,source_fingerprint,source_synced_at,memo,economic_effect_sign',q=>q.or('and(business_date.gte.2026-07-01,business_date.lt.2026-08-01),recognition_month.eq.2026-07-01'));
 await read('julyAudits','ledger_audit_logs','id,action,entity_id,reason,after_snapshot',q=>q.eq('action','july_restore_row'));
 const movements=[];for(let i=0;i<tx.length;i+=75){const k='movementChunk'+i;movements.push(...await read(k,'ledger_movements','*',q=>q.in('transaction_id',tx.slice(i,i+75).map(t=>t.id))));delete cap.tables[k];}cap.tables.movements=movements;
 await read('accounts','ledger_fund_accounts','id,code,type,is_active,is_business_fund,active_from,active_to');
 await read('categories','ledger_categories','id,name,kind,is_active');
 await read('rentContracts','ledger_rent_contracts','*');
 await read('rentPayments','ledger_rent_contract_payments','*');
 await read('recurringPlans','ledger_recurring_expense_plans','*',q=>q.eq('id',1));
 await read('julyAdjustments','payroll_monthly_adjustments','*',q=>q.eq('payroll_month','2026-07-01'));
 await read('julyPayrollBatches','payroll_payment_batches','*',q=>q.eq('payroll_month','2026-07-01'));
 await read('ownerParticipants','ledger_owner_participants','*');
 await read('ownerInvestments','ledger_owner_investments','*');
 const userIds=[...new Set([4,10,...cap.tables.ownerParticipants.map(p=>p.user_id)])];
 await read('relevantUsers','users','id,username,name,full_name,role,is_active,is_system_account,payroll_eligible_override,app_login_enabled',q=>q.in('id',userIds));
 await read('relatedLaterTransactions','ledger_transactions','id,type,status,business_date,recognition_month,amount,category_id,source_type,source_key,source_snapshot,memo',q=>q.in('id',[1081,1079,1653,3259,1077,1657,1304,1084,1886,3260]));
 await read('closures','ledger_month_closures','id,month,status,revision,snapshot_hash',q=>q.gte('month','2026-07-01').lte('month','2026-10-01'));
 cap.status='CAPTURED';cap.completedAt=new Date().toISOString();
}catch(e){cap.status='BLOCKED_READ_CAPTURE';cap.error=String(e.message);process.exitCode=1;}
mkdirSync(out,{recursive:true});writeFileSync(join(out,'runtime-readonly.json'),JSON.stringify(cap,null,2));console.log(JSON.stringify({status:cap.status,error:cap.error,httpCalls:cap.requests.length,productionWrites:0}));
