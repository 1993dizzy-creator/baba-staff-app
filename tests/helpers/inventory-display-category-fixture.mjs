// Isolated PGlite reconstruction of the deployed Inventory -> Ledger projection chain.
// Never reads production credentials. Function bodies follow the migration order and
// the stored CRLF sync bodies are pinned by the same md5 values as the gas migration.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {database} from './inventory-ledger-fixture.mjs';

const read=name=>readFileSync('supabase/migrations/'+name,'utf8').replace(/^﻿/,'');
export const DISPLAY_CATEGORY_MIGRATION='20261020093000_sync_inventory_display_category_to_ledger.sql';
const productionContracts=[['inventory_ledger_private.sync_candidate(jsonb,bigint)','fe28c88c30a1a3a55f756018a25eeec9'],['public.ledger_sync_inventory_candidates_core_v1(jsonb,bigint)','3a5059d9faf63b73d9c116414d538a17']];
const gasName='Cửa hàng gas petrolimex chính hãng';
export const one=async(db,sql,args=[])=>(await db.query(sql,args)).rows[0];

// Values mirror the production facts reported for 2026-10: original receipts 13561/13563,
// items 620/621, partner #33 with an unspecified payment mode, category 기타(#66) -> 가공식품(#31).
export async function displayCategoryDatabase({apply=true,projectionBodyEol='LF'}={}){
 const db=await database();
 await db.exec(`
 alter table business_partner_ledger_parties add primary key(business_partner_id);
 alter table ledger_month_closures add column revision integer default 1;
 alter table business_partners add column partner_type text default 'other',add column partner_subtype_id bigint,add column settlement_mode text,add column settlement_rule text,add column phone text,add column contact_name text,add column memo text,add column updated_at timestamptz;
 insert into ledger_categories(id,name,kind) values(23,'가스비','expense'),(31,'가공식품','expense'),(66,'기타 재고매입','expense'),(77,'수동 선택','expense');
 insert into business_partners(id,name,is_active,payment_mode,partner_type) values(21,'${gasName}',true,'postpaid','consumable'),(33,'Unspecified Mart',true,'unspecified','food');
 insert into ledger_parties(id,name,type,default_category_id) values(21,'${gasName}','supplier',23),(33,'Unspecified Mart','supplier',null),(34,'Owner Chosen Payee','supplier',null);
 insert into business_partner_ledger_parties values(21,21),(33,33);
 -- Production columns: every posted row carries display_snapshot={} by default; items have a part.
 alter table ledger_transactions add column display_snapshot jsonb not null default '{}'::jsonb check (jsonb_typeof(display_snapshot)='object');
 alter table inventory add column part text;
 insert into inventory(id,supplier_partner_id,part) values(342,21,'kitchen'),(620,33,'kitchen'),(621,33,'kitchen');
 insert into ledger_inventory_category_mappings(inventory_category,ledger_category_id) values('기타',66),('가공식품',31);
 create table business_partner_subtypes(id bigint primary key,code text,partner_type text,name_ko text,name_vi text,emoji text,is_active boolean);
 insert into business_partner_subtypes values(43,'utility_gas','utilities','가스','Gas',null,true);
 create table business_partner_audit_logs(business_partner_id bigint,actor_user_id bigint,action text,before_snapshot jsonb,after_snapshot jsonb);
 alter table inventory_logs add column action text,add column part text,add column new_part text,add column code text,add column new_code text,add column new_unit text,add column new_category text,add column new_category_vi text,add column prev_quantity numeric,add column new_quantity numeric,add column prev_supplier text;
 `);
 await db.exec(read('202608230004_fix_business_partner_fund_account_eligibility.sql'));
 const paymentTypes=read('202608210004_add_ledger_payable_payments.sql');await db.exec(paymentTypes.slice(0,paymentTypes.indexOf('alter table public.ledger_parties')));
 const verification=read('20260921170100_add_inventory_payment_verification.sql');
 await db.exec(verification.slice(0,verification.indexOf('  -- Keep the existing preflight'))+'end;\n$payment_verification$;');
 for(const [signature,hash] of productionContracts){
  const {definition}=await one(db,'select pg_get_functiondef($1::regprocedure) definition',[signature]);
  await db.exec(definition.replace(/\$function\$([\s\S]*)\$function\$/,(_,body)=>'$function$'+body.replace(/\r\n/g,'\n').replace(/\n/g,'\r\n')+'$function$'));
  assert.equal((await one(db,'select md5(pg_get_functiondef($1::regprocedure)) hash',[signature])).hash,hash);
 }
 for(const name of ['20261007182027_resolve_inventory_purchase_projection.sql','20261009080243_detect_inventory_purchase_economic_corrections.sql','20261010180457_scope_gas_inventory_purchase_category.sql'])await db.exec(read(name));
 if(projectionBodyEol==='CRLF'){
  const signature='public.ledger_project_inventory_purchase_log_v1(bigint,bigint)';
  const {definition}=await one(db,'select pg_get_functiondef($1::regprocedure) definition',[signature]);
  await db.exec(definition.replace(/\$function\$([\s\S]*)\$function\$/,(_,body)=>'$function$'+body.replace(/\r\n/g,'\n').replace(/\n/g,'\r\n')+'$function$'));
 }
 await db.exec("select setval('ledger_candidates_id_seq',1871,false)");
 if(apply)await applyDisplayCategoryMigration(db);
 return db;
}
export const displayCategoryMigrationSql=()=>read(DISPLAY_CATEGORY_MIGRATION);
export async function applyDisplayCategoryMigration(db){await db.exec(displayCategoryMigrationSql());}

export async function receipt(db,{id=13561,item=620,price=270000,quantity=1,date='2026-10-19',category='기타',categoryVi='Khác',part='kitchen',partner=33,supplier='Unspecified Mart'}={}){
 await db.query(`insert into inventory_logs(id,item_id,item_name,item_name_vi,part,new_part,category,category_vi,new_category,new_category_vi,unit,change_quantity,prev_quantity,new_quantity,new_purchase_price,new_supplier,business_date,created_at,source,reason,source_actor_user_id,purchase_supplier_partner_id)
  values($1,$2,$11,$12,$3,$3,$4,$5,$4,$5,'ea',$6,0,$6,$7,$8,$9::date,($9::date+time '03:00')::timestamptz,'quick_save','purchase',2,$10)`,[id,item,part,category,categoryVi,quantity,price,supplier,date,partner,'품목'+item,'Item '+item]);
}
// Same payload shape as lib/inventory/ledger-sync-contract.ts inventoryLogDisplayUpdate().
// A part change is an item edit first, so the current item part moves with it.
export async function displayUpdate(db,id,{category,categoryVi,part}){
 if(part)await db.query('update inventory set part=$2 where id=(select item_id from inventory_logs where id=$1)',[id,part]);
 await db.query(`update inventory_logs set category=coalesce($2,category),new_category=coalesce($2,category),category_vi=coalesce($3,category_vi),new_category_vi=coalesce($3,category_vi),part=coalesce($4,part),new_part=coalesce($4,part) where id=$1`,[id,category??null,categoryVi??null,part??null]);
}
export const projectV1=async(db,id,actor=2)=>(await one(db,'select ledger_project_inventory_purchase_log_v1($1,$2) as result',[id,actor])).result;
export const projectDisplay=async(db,id,actor=2)=>(await one(db,'select ledger_project_inventory_display_sync_v1($1,$2) as result',[id,actor])).result;
export const candidates=async(db,id)=>(await db.query("select id,status,proposed_category_id,proposed_party_id,proposed_amount,source_snapshot->>'category' category,source_fingerprint from ledger_candidates where source_key=$1 order by id",['inventory-log:'+id])).rows;
export async function ledgerState(db){return (await one(db,`select jsonb_build_object(
 'tx',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'amount',amount,'party',party_id,'category',category_id,'type',source_type,'sign',economic_effect_sign) order by id),'[]') from ledger_transactions),
 'payables',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'tx',expense_transaction_id,'amount',original_amount,'party',party_id,'status',status,'due',due_date) order by id),'[]') from ledger_payables),
 'movements',(select coalesce(jsonb_agg(jsonb_build_object('tx',transaction_id,'account',fund_account_id,'amount',amount) order by id),'[]') from ledger_movements)) as state`)).state;}
