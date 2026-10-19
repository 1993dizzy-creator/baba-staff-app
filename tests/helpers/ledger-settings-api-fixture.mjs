// Local-only API fixture: real route handlers, isolated memory tables and RPC double.
// Production clients and external imports are explicitly blocked. RPCs model UI refresh, not SQL correctness.
import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import ts from 'typescript';
import {entriesApi} from './ledger-entries-api-fixture.mjs';
import {entriesTables} from './ledger-entries-tables.mjs';
export function settingsApi(){
 const tables=entriesTables();
 tables.users=[1,2,3].map(id=>({id,name:'Owner '+id,full_name:'Owner '+id,username:'owner'+id,role:'owner',is_active:true}));
 tables.ledger_owner_participants=tables.users.map(u=>({id:u.id,user_id:u.id,is_eligible:true,effective_from:'2026-08-01',effective_to:null,sort_order:u.id}));
 tables.ledger_owner_settlement_policies=[{id:1,effective_month:'2026-08-01',revision:3,note:null,lines:[.5,.3,.2].map((r,i)=>({participant_id:i+1,settlement_rate:String(r)}))}];
 tables.ledger_owner_profit_settings=[{profit_tracking_start_month:'2026-08-01',opening_undistributed_profit:5000}];
 tables.ledger_reserve_plans=[{id:91,name:'QA Reserve',target_amount:100000,target_date:'2027-10-01',is_active:true,memo:'QA',fund_account_id:1,linked_recurring_plan_id:null,recurring_monthly_amount:null,entries:[{id:901,entry_type:'allocate',amount:10000,occurred_at:'2026-10-10T00:00:00Z',memo:null}]}];
 tables.ledger_reserve_scheduled_allocations=[];
 const partner=(id,name,is_active)=>({id,name,is_active,partner_type:'other',payment_mode:'unspecified',settlement_mode:null,settlement_rule:null,default_payment_term_days:null,default_fund_account_id:null,partner_subtype_id:null,display_tag:null,phone:null,contact_name:null,memo:null,created_at:'2026-08-01',updated_at:'2026-10-01'});
 tables.business_partners=[partner(1,'QA Active',true),partner(2,'QA Inactive',false)];
 tables.business_partner_ledger_parties=[];tables.business_partner_subtypes=[];tables.business_partner_supplier_aliases=[{id:1,supplier_name:'QA Candidate',status:'pending',business_partner_id:null,first_seen_at:'2026-08-01',last_seen_at:'2026-10-01',reviewed_at:null}];
 tables.inventory=[];
 const calls=[],rpcs=[],modules=new Map(),accounts=entriesApi(tables);
 function project(row,columns){if(row==null)return row;if(Array.isArray(row))return row.map(r=>project(r,columns));const keys=columns.split(/,(?![^()]*\))/);const out={};for(const key of keys){const open=key.indexOf('('),name=(open<0?key:key.slice(0,open)).split(':')[0].split('!')[0];if(name==='*')return structuredClone(row);if(Object.hasOwn(row,name))out[name]=open<0?row[name]:project(row[name],key.slice(open+1,-1));}return out;}
 const db={from(table){let cols='',limit=1000;const filters=[],orders=[];const q={select(c){cols=c;return q;},order(k,o={}){orders.push([k,o.ascending!==false]);return q;},limit(n){limit=n;return q;},or(expression){const match=expression.match(/^effective_to\.is\.null,effective_to\.gte\.(.+)$/);if(!match)throw Error('Unexpected OR '+expression);filters.push(r=>r.effective_to==null||r.effective_to>=match[1]);return q;},maybeSingle:async()=>execute(true),then(a,b){return Promise.resolve(execute(false)).then(a,b);}};
 const value=(r,k)=>k.split('.').reduce((v,p)=>v?.[p],r);
 for(const op of ['eq','neq','lte','lt','gte','in','not'])q[op]=(k,v)=>{filters.push(r=>{const a=value(r,k);return op==='eq'?a===v:op==='neq'?a!==v:op==='lte'?a<=v:op==='lt'?a<v:op==='gte'?a>=v:op==='in'?v.includes(a):a!=null;});return q;};
 function execute(single){let rows=(tables[table]??[]).filter(r=>filters.every(f=>f(r))).sort((a,b)=>{for(const[k,asc]of orders){if(value(a,k)!==value(b,k))return(value(a,k)<value(b,k)?-1:1)*(asc?1:-1);}return 0;}).slice(0,limit).map(r=>project(r,cols));calls.push({table,cols,rows:rows.length,bytes:Buffer.byteLength(JSON.stringify(rows))});return{data:single?rows[0]??null:rows,error:null};}return q;},async rpc(name,args){rpcs.push({name,args});
 if(name==='ledger_save_owner_participants_v1')tables.ledger_owner_participants=args.p_rows.map((r,i)=>({id:i+1,user_id:r.userId,is_eligible:r.isEligible,effective_from:args.p_effective_month,effective_to:null,sort_order:r.sortOrder}));
 else if(name==='ledger_create_owner_policy_v1')tables.ledger_owner_settlement_policies=[{id:2,effective_month:args.p_effective_month,revision:4,lines:args.p_lines.map(r=>({participant_id:r.participantId,settlement_rate:r.rate}))}];
 else if(name==='business_partner_create_v4')tables.business_partners.push(partner(3,args.p_name,true));
 else if(name==='ledger_create_reserve_plan_v2')tables.ledger_reserve_plans.push({id:92,name:args.p_name,target_amount:args.p_target_amount,target_date:args.p_target_date,is_active:true,memo:args.p_memo,fund_account_id:args.p_fund_account_id,entries:[]});
 else if(name==='ledger_update_reserve_plan_v2'){const p=tables.ledger_reserve_plans.find(p=>p.id===args.p_reserve_plan_id);Object.assign(p,{target_amount:args.p_target_amount,target_date:args.p_target_date,memo:args.p_memo,fund_account_id:args.p_fund_account_id});}
 else if(name==='ledger_create_reserve_entry_v1')tables.ledger_reserve_plans.find(p=>p.id===args.p_reserve_plan_id).entries.push({id:902,entry_type:args.p_entry_type,amount:args.p_amount,occurred_at:args.p_occurred_at,memo:args.p_memo});
 else throw Error('Unexpected test RPC '+name);
 return{data:{status:name==='ledger_save_owner_participants_v1'||name==='ledger_create_owner_policy_v1'?'saved':name==='ledger_update_reserve_plan_v2'?'updated':'created'},error:null};}};
 const overrides={'server-only':{},'next/server':{NextResponse:{json:Response.json}},'@/lib/supabase/server':{supabaseServer:db},'@/lib/auth/server-auth':{requireRole:async()=>({ok:true,actor:{id:7,role:'owner'}})},'@/lib/ledger/server':{requireLedgerActor:async()=>({actor:{id:7,role:'owner'}}),ledgerJson:(body,status=200)=>Response.json(body,{status})}};
 function load(file){file=resolve(file);if(modules.has(file))return modules.get(file).exports;const m={exports:{}};modules.set(file,m);const code=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;new Function('require','module','exports',code)(name=>{if(name in overrides)return overrides[name];if(name.startsWith('@/'))return load(name.slice(2).replace(/\.ts$/, '')+'.ts');if(name.startsWith('.'))return load(resolve(dirname(file),name).replace(/\.ts$/, '')+'.ts');throw Error('Forbidden external module '+name);},m,m.exports);return m.exports;}
 async function request(path,method='GET',body){const u=new URL(path,'http://local');if(u.pathname==='/api/admin/ledger'){if(method!=='GET'||u.searchParams.get('scope')!=='accounts')throw Error('Only accounts read allowed');return accounts.get(u.searchParams.get('month'),'&scope=accounts');}const file='app'+u.pathname.replace(/\/\d+(?=\/|$)/g,'/[id]')+'/route.ts';const handler=load(file);const id=u.pathname.match(/\/(\d+)/)?.[1];return handler[method](new Request(u,{method,...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})}),{params:Promise.resolve({id})});}
 return{request,tables,calls,rpcs,accounts};
}
