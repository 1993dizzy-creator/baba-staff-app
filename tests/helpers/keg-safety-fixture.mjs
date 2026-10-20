import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import ts from 'typescript';
export const kegBusinessDate=load('lib/common/business-time.ts',{}).getBusinessDate;
export const draftPath='supabase/drafts/keg_safety_p0.sql';
export const migrationPath='supabase/migrations/20261020120000_keg_safety_p0.sql';
export async function setupKegSafety(db,{installDraft=true}={}){
 await db.exec(`create role anon; create role authenticated; create role service_role;
 create table users(id bigint primary key,username text unique,name text,role text,is_active boolean);
 create table inventory(id bigint primary key,item_name text,item_name_vi text,part text,category text,category_vi text,quantity numeric,purchase_price numeric,note text,unit text,code text,supplier text,low_stock_threshold numeric,package_content_quantity numeric,package_content_unit text,updated_at timestamptz default now(),updated_by_name text,updated_by_username text);
 create table inventory_logs(id bigserial primary key,item_id bigint,item_name text,item_name_vi text,action text,part text,category text,category_vi text,prev_quantity numeric,new_quantity numeric,change_quantity numeric,prev_purchase_price numeric,new_purchase_price numeric,prev_note text,new_note text,prev_supplier text,new_supplier text,prev_code text,new_code text,prev_unit text,new_unit text,prev_category text,new_category text,prev_category_vi text,new_category_vi text,prev_part text,new_part text,unit text,code text,actor_name text,actor_username text,prev_low_stock_threshold numeric,new_low_stock_threshold numeric,reason text,source text,business_date date,created_at timestamptz default now());
 create table pos_products(id bigint primary key,pos_item_id text,item_id text,item_code text,item_name text,unit_name text);
 create table pos_sales_receipts(id bigint primary key,ref_date timestamptz,synced_at timestamptz,updated_at timestamptz,payment_status int,is_canceled boolean);
 create table pos_sales_receipt_lines(id bigint primary key,receipt_id bigint,item_id text,item_code text,quantity numeric,is_option boolean,is_excluded boolean,is_canceled boolean,payment_status int,ref_date timestamptz,synced_at timestamptz,updated_at timestamptz);`);
 const original=readFileSync('supabase/migrations/202607020001_create_inventory_keg_tracking.sql','utf8');
 await db.exec(original.slice(0,original.indexOf('create or replace function public.replace_inventory_keg')));
 await db.exec(readFileSync('supabase/migrations/202607230003_unify_keg_sales_calculation.sql','utf8'));
 if(installDraft)await db.exec(readFileSync(migrationPath,'utf8')); 
}
export async function seedKegSafety(db,{previousId=22,activeId=23,date='2026-07-10',drift=false,tower=2700,itemCode='L3'}={}){
 await db.exec(`truncate inventory_keg_safety_audit,inventory_keg_sessions,inventory_keg_tracking_mappings,inventory_logs,inventory,users,pos_sales_receipt_lines,pos_sales_receipts,pos_products restart identity cascade;
 insert into users values(1,'alice','Alice','staff',true),(2,'bob','Bob','staff',true);
 insert into inventory(id,item_name,item_name_vi,code,part,quantity,unit,package_content_quantity,package_content_unit) values(3,'${itemCode}','${itemCode}','${itemCode}','bar',10,'Keg',30000,'ml');
 insert into pos_products values(1,'glass',null,'G','Beer','Cốc'),(2,'tower',null,'T','Beer tower','Tháp');
 insert into inventory_keg_tracking_mappings(inventory_item_id,target_type,pos_product_id,quantity_per_pos_unit) values(3,'product',1,330),(3,'product',2,${tower});
 insert into inventory_logs(id,item_id,source) values(77,3,'keg_replace');
 select setval('inventory_logs_id_seq',100);
 insert into inventory_keg_sessions(id,inventory_item_id,status,started_at,started_business_date,ended_at,ended_business_date,ended_log_id,capacity_quantity,sold_quantity,loss_quantity,loss_rate) values(${previousId},3,'closed','${date}T09:00Z','${date}','${date}T10:00Z','${date}',77,30000,${drift?999:330},${drift?29001:29670},${drift?0.9667:0.989});
 insert into inventory_keg_sessions(id,inventory_item_id,status,started_at,started_business_date,started_log_id,capacity_quantity,created_by) values(${activeId},3,'active','${date}T10:00Z','${date}',77,30000,'alice');
 select setval('inventory_keg_sessions_id_seq',200);
 insert into pos_sales_receipts(id,ref_date,payment_status,is_canceled) values(1,'${date}T09:45Z',3,false),(2,'${date}T10:00Z',3,false),(3,'${date}T10:30Z',3,false);
 insert into pos_sales_receipt_lines(id,receipt_id,item_id,quantity,payment_status,ref_date) values(1,1,'glass',1,3,'${date}T09:45Z'),(2,2,'tower',1,3,'${date}T10:00Z'),(3,3,'glass',1,3,'${date}T10:30Z');`);
 return {previousId,activeId,date};
}
export async function previewKeg(db,{action='edit-start',session=23,at='2026-07-10T10:30Z',actor='alice',expected=10,businessDate=kegBusinessDate(new Date(at))}={}){
 const r=await db.query('select inventory_preview_keg_change($1,3,$2,$3,$4,$5,$6) result',[action,action==='replace'?null:session,at,businessDate,actor,expected]);return r.rows[0].result;
}
export async function applyKeg(db,p,{key='10000000-0000-4000-8000-000000000001',reason='Boundary verified',confirmed=false,actor='alice',token=p.previewToken,session=p.activeSessionId}={}){
 const r=await db.query('select inventory_apply_keg_change($1,$2,$3,$4,$5,$6,10,$7,$8,$9,$10) result',[p.action,p.action==='replace'?3:null,p.action==='replace'?null:session,p.replacementAt,p.businessDate,actor,token,key,reason,confirmed]);return r.rows[0].result;
}
export async function kegState(db){return (await db.query(`select jsonb_build_object('inventory',(select jsonb_agg(i order by id) from inventory i),'sessions',(select jsonb_agg(s order by id) from inventory_keg_sessions s),'logs',(select jsonb_agg(l order by id) from inventory_logs l),'audit',(select jsonb_agg(a order by request_id) from inventory_keg_safety_audit a)) state`)).rows[0].state;}

function load(file,deps){const m={exports:{}};const code=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;new Function('require','module','exports',code)(name=>{assert.ok(name in deps,name);return deps[name];},m,m.exports);return m.exports;}
export function kegSafetyApi(db,{authenticated=true,actor='alice',missingRpc=false,businessDateOverride=null}={}){
 const calls=[];const rpc=async(name,args)=>{calls.push({name,args});if(missingRpc)return{error:{message:'function does not exist'},data:null};try{const values=Object.values(args);const query='select '+name+'('+values.map((_,i)=>'$'+(i+1)).join(',')+') result';return{data:(await db.query(query,values)).rows[0].result,error:null};}catch(error){return{data:null,error:{message:error.message}};}};
 const helper=load('lib/inventory/keg-safety-server.ts',{'server-only':{},'next/server':{NextResponse:{json:(v,o)=>Response.json(v,o)}},'@/lib/common/business-time':{BUSINESS_TIMEZONE_OFFSET:'+07:00'},'@/lib/inventory/inventory-business-time':{resolveInventoryBusinessDate:async at=>({businessDate:businessDateOverride??kegBusinessDate(at)})},'@/lib/supabase/server':{supabaseServer:{rpc}}});
 const deps={'next/server':{NextResponse:{json:(v,o)=>Response.json(v,o)}},'@/lib/auth/server-auth':{getAuthenticatedActor:async()=>authenticated?{ok:true,actor:{username:actor,role:'staff'}}:{ok:false,code:'RELOGIN_REQUIRED',status:401}},'@/lib/inventory/keg-safety-server':helper};
 return{calls,helper,replace:load('app/api/inventory/keg-sessions/replace/route.ts',deps),session:load('app/api/inventory/keg-sessions/[id]/route.ts',deps)};
}
