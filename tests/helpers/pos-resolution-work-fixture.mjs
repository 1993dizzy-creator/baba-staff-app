import {readFileSync} from 'node:fs';
import {resolutionDatabase} from './pos-pending-resolution-fixture.mjs';
export const phase2=readFileSync('supabase/migrations/20261021081604_pos_resolution_corrections_inventory_review.sql','utf8');
const read=n=>readFileSync('supabase/migrations/'+n,'utf8');
export async function initializeWork(db,{beforeMigration,migration=phase2}={}){
 const schema=readFileSync('tests/sales-receipt-split-payment-db.test.mjs','utf8');
 for(const match of schema.matchAll(/create table (pos_sales_receipt\w*)\(([^;]+)\);/g)){
  const [_,table,body]=match;
  if(table==='pos_sales_receipt_modifications'){await db.exec('create table '+table+'('+body+');');continue;}
  for(const col of body.split(',')){
   const m=col.match(/^(\w+) (bigint|text|date|timestamptz|integer|numeric|boolean|jsonb)(.*)$/);
   if(m) await db.exec('alter table '+table+' add column if not exists '+m[1]+' '+m[2]+(m[3].includes('default 0')?' default 0':'')+';');
  }
 }
 await db.exec('alter table users add column name text; alter table pos_inventory_deductions add primary key(id); drop table pos_inventory_deduction_receipts;');
 await db.exec(`create table pos_products(id bigint primary key,pos_item_id text,item_id text,item_code text,item_name text,unit_name text,unit_price numeric,tax_rate numeric,is_active boolean);
 create table inventory(id bigint primary key,quantity numeric,purchase_price numeric,item_name text,item_name_vi text,part text,category text,category_vi text,note text,supplier text,code text,unit text,updated_at timestamptz);
 create table pos_item_mappings(id bigint primary key,pos_item_code text,mapping_type text,is_active boolean,mapping_version integer,inventory_item_id bigint,quantity_multiplier numeric,is_archived boolean default false);
 create table pos_item_mapping_recipes(id bigint primary key,mapping_id bigint,inventory_item_id bigint,is_active boolean,version integer,quantity_per_pos_unit numeric);
 alter table pos_inventory_deductions add column invoice_ref_id text,add column ref_detail_id text,add column pos_item_code text,add column pos_item_name text,add column pos_quantity numeric,add column inventory_item_id bigint,add column deduct_quantity numeric,add column status text,add column error_message text,add column applied_at timestamptz,add column applied_by text,add column inventory_log_id bigint,add column processed_line_id bigint;
 `);
 const engines=['202606210001_add_purchase_price_to_sale_deduction_logs.sql','202607180005_fix_reprocess_modified_sales_inventory_deduction.sql','202607130001_complete_sales_receipt_inventory_deduction_lifecycle.sql'].map(read);
 const logColumns=[...new Set(engines.flatMap(sql=>[...sql.matchAll(/insert into public.inventory_logs \(([^)]+)\)/g)].flatMap(m=>m[1].split(',').map(x=>x.trim()))))];
 await db.exec('create table inventory_logs(id bigint generated always as identity primary key,'+logColumns.map(c=>c+' '+(c==='business_date'?'date':c.endsWith('_id')?'bigint':/quantity|price/.test(c)?'numeric':'text')).join(',')+');');
 await db.exec(read('202606140002_create_sales_inventory_deduction_batches.sql'));
 await db.exec('alter table pos_inventory_deductions add column if not exists reversal_of_deduction_id bigint; alter table pos_inventory_deduction_batches add column if not exists applied_receipt_count integer;');
 await db.exec(read('202607100001_add_inventory_deduction_receipt_workflow_fingerprint.sql'));
 const applyBase=read('202606150001_apply_sales_inventory_deduction_batch.sql');await db.exec(applyBase.slice(0,applyBase.indexOf('create or replace function')));
 await db.exec('create function public.admin_update_paid_sales_receipt(bigint,bigint,uuid,text,text,text,numeric,text,numeric,jsonb) returns jsonb language sql as '+String.fromCharCode(36,36)+"select '{}'::jsonb"+String.fromCharCode(36,36)+';');
 await db.exec(read('20260928210713_add_sales_receipt_split_payment.sql'));
 await db.exec(engines[0]);await db.exec(engines[1]);await db.exec(engines[2]);
 await db.exec("create unique index pos_sales_receipt_payments_unique_payment on pos_sales_receipt_payments(source,receipt_ref_id,coalesce(payment_type,-1),coalesce(payment_name,''),coalesce(card_name,''));");
 if(beforeMigration) await beforeMigration(db);
 await db.exec(migration);
}
export async function workDatabase(){const db=await resolutionDatabase();try{await initializeWork(db);return db;}catch(e){await db.close();throw e;}}
export async function work(db,id=10,actor=1){return (await db.query('select sales_get_admin_resolution_work_v2($1,$2) r',[id,actor])).rows[0].r;}
export async function correct(db,body,id=10,actor=1){return (await db.query('select sales_correct_admin_resolution_v2($1,$2,$3::jsonb) r',[id,actor,JSON.stringify(body)])).rows[0].r;}
export function correction(w,patch={}){return {requestId:'22222222-2222-4222-8222-222222222222',resolutionId:w.resolution.request_id,resolutionVersion:w.version,expectedRevision:w.state.receipt.revision,fingerprint:w.fingerprint,decision:'paid',amount:90000,payments:[{method:'transfer',amount:40000},{method:'card',amount:50000}],taxMode:'apply',reason:'verified correction',lines:w.state.lines.filter(l=>!l.is_excluded).map(l=>({...l,quantity:1,unit_price:90000,discount_amount:0,tax_rate:0})),...patch};}
