// Operator-only, scoped GET capture. Run from existing env-owning Main (read only):
// node --env-file=.env.local <worktree>/scripts/ledger/july-restore-phase2-readonly.mjs <new-worktree-local-folder>
// No RPC, POST, credential copying, retry or inventory-wide/month-wide source scan.
import {createRequire} from 'node:module';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {reconstruct} from './july-restore-phase2.mjs';
const root=fileURLToPath(new URL('../../.local/july-restore/',import.meta.url));
const out=resolve(process.argv[2]||''),rel=relative(root,out);
if(!process.argv[2]||!rel||rel.startsWith('..')||isAbsolute(rel)||existsSync(out))throw Error('NEW_LOCAL_OUTPUT_REQUIRED');
const rows=reconstruct(JSON.parse(readFileSync(join(root,'dry-run-20261107-v2/395-row-dry-run.json'),'utf8')));
const ids=[...new Set(rows.flatMap(r=>[...r.inventoryIds,...r.correctionIds,...r.excludedIds]))].sort((a,b)=>a-b);
const require=createRequire(join(process.cwd(),'package.json'));
const {createClient}=require('@supabase/supabase-js');
const snapshot={capturedAt:new Date().toISOString(),readOnly:true,scope:{sourceRows:rows.filter(r=>r.inventoryIds.length).map(r=>r.row),inventoryIds:ids},requests:[],tables:{},checks:{}};
const db=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{
 auth:{persistSession:false,autoRefreshToken:false},
 global:{fetch:async(url,init={})=>{
  if((init.method||'GET').toUpperCase()!=='GET')throw Error('GET_ONLY');
  const r=await fetch(url,{...init,signal:AbortSignal.timeout(30000)});
  snapshot.requests.push({method:'GET',http:r.status,at:new Date().toISOString()});return r;
 }},
});
async function read(name,table,columns,filter=q=>q){
 const all=[];let expected=null;
 for(let offset=0;;offset+=500){
  const {data,error,count,status}=await filter(db.from(table).select(columns,{count:'exact'})).order('id').range(offset,offset+499);
  if(error)throw Error(`${name}:HTTP_${status}:CODE_${error.code}`);
  if(count===null||(expected!==null&&expected!==count))throw Error(`${name}:COUNT_CHANGED`);
  expected=count;all.push(...data);if(all.length===count)break;
  if(!data.length||all.length>count)throw Error(`${name}:INCOMPLETE_PAGE`);
 }
 snapshot.tables[name]=all;snapshot.checks[name]={count:all.length,complete:true};
 console.log(JSON.stringify({table:name,count:all.length}));return all;
}
async function chunks(name,table,columns,values,apply){
 const all=[];
 for(let i=0;i<values.length;i+=75){const key=name+i;all.push(...await read(key,table,columns,q=>apply(q,values.slice(i,i+75))));delete snapshot.tables[key];}
 snapshot.tables[name]=[...new Map(all.map(x=>[x.id,x])).values()];
 snapshot.checks[name]={count:snapshot.tables[name].length,complete:true};return snapshot.tables[name];
}
const orIn=v=>v.length?v:[-1];
try{
 const logs=await chunks('inventoryLogs','inventory_logs','*',ids,(q,v)=>q.in('id',v));
 await chunks('inventoryItems','inventory','id,quantity,purchase_price,updated_at',[...new Set(logs.map(l=>l.item_id))].filter(Boolean),(q,v)=>q.in('id',v));
 const candidates=await chunks('candidates','ledger_candidates','*',ids.map(id=>'inventory-log:'+id),(q,v)=>q.in('source_key',v));
 // Projection table key is inventory_log_id, not id: one narrow request.
 const {data:projection,error:pe,status:ps,count:pc}=await db.from('ledger_inventory_projection_status').select('*',{count:'exact'}).in('inventory_log_id',ids);
 if(pe)throw Error(`projection:HTTP_${ps}:CODE_${pe.code}`);
 if(pc!==projection.length)throw Error('projection:INCOMPLETE_PAGE');
 snapshot.tables.projection=projection;
 await read('accounts','ledger_fund_accounts','id,code,type,is_active,is_business_fund,active_from,active_to');
 await read('categories','ledger_categories','id,name,kind,is_active');
 await read('categoryMappings','ledger_inventory_category_mappings','*');
 await read('supplierMappings','ledger_supplier_party_mappings','*');
 await read('parties','ledger_parties','id,name,type,is_active');
 await read('partners','business_partners','id,name,is_active,payment_mode,default_fund_account_id');
 await read('supplierAliases','business_partner_supplier_aliases','id,business_partner_id,normalized_name,status');
 const {data:links,error:le,status:ls,count:lc}=await db.from('business_partner_ledger_parties').select('*',{count:'exact'});
 if(le)throw Error(`partnerLinks:HTTP_${ls}:CODE_${le.code}`);if(lc!==links.length)throw Error('partnerLinks:INCOMPLETE_PAGE');snapshot.tables.partnerLinks=links;
 const july=await read('julyTransactions','ledger_transactions','*',q=>q.or('and(business_date.gte.2026-07-01,business_date.lt.2026-08-01),recognition_month.eq.2026-07-01'));
 await chunks('directTransactions','ledger_transactions','*',ids,(q,v)=>q.in('source_snapshot->>inventory_log_id',v));
 await chunks('resolvedTransactions','ledger_transactions','*',[...new Set(candidates.map(c=>c.resolved_transaction_id).filter(Boolean))],(q,v)=>q.in('id',v));
 await read('julyAudits','ledger_audit_logs','id,action,entity_id,reason,after_snapshot',q=>q.eq('action','july_restore_row'));
 const suppliers=new Set(logs.map(l=>(l.new_supplier||'').trim().toLowerCase()));
 const partnerIds=snapshot.tables.partners.filter(p=>suppliers.has(p.name.trim().toLowerCase())).map(p=>p.id);
 for(const a of snapshot.tables.supplierAliases)if(a.status==='linked'&&suppliers.has(a.normalized_name))partnerIds.push(a.business_partner_id);
 const partyIds=[...new Set([...snapshot.tables.supplierMappings.filter(m=>m.is_active&&suppliers.has(m.supplier_name.trim().toLowerCase())).map(m=>m.party_id),...links.filter(l=>partnerIds.includes(l.business_partner_id)).map(l=>l.ledger_party_id)])];
 const payables=await read('payables','ledger_payables','*',q=>q.or(`party_id.in.(${orIn(partyIds).join(',')}),expense_transaction_id.in.(${orIn(july.map(t=>t.id)).join(',')})`));
 const allocs=await chunks('payableAllocations','ledger_payable_allocations','*',payables.map(p=>p.id),(q,v)=>q.in('payable_id',v));
 await chunks('payableTransactions','ledger_transactions','*',[...new Set([...payables.map(p=>p.expense_transaction_id),...allocs.map(a=>a.payment_transaction_id)])],(q,v)=>q.in('id',v));
 const txIds=[...new Set(['julyTransactions','directTransactions','resolvedTransactions','payableTransactions'].flatMap(k=>snapshot.tables[k].map(t=>t.id)))];
 await chunks('movements','ledger_movements','id,transaction_id,fund_account_id,amount',txIds,(q,v)=>q.in('transaction_id',v));
 await read('closures','ledger_month_closures','id,month,status,revision,snapshot_hash',q=>q.gte('month','2026-07-01').lte('month','2026-10-01'));
 snapshot.completedAt=new Date().toISOString();snapshot.status='CAPTURED';
}catch(e){snapshot.status='BLOCKED_READ_CAPTURE';snapshot.error=String(e.message);process.exitCode=1;}
mkdirSync(out,{recursive:true});writeFileSync(join(out,'runtime-readonly.json'),JSON.stringify(snapshot,null,2));
console.log(JSON.stringify({status:snapshot.status,error:snapshot.error,httpCalls:snapshot.requests.length,sourceLogs:ids.length,dbWrites:0}));
